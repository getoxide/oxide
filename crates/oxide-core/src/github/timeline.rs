//! The Activity Timeline of an issue or a pull request: its comments, reviews, commits and
//! events in the order GitHub shows them, read through one `gh api graphql` round trip.

use super::image::{SignedImage, signed_images};
use super::reactions::{REACTION_FIELDS, ReactionGroup, reactions_from};
use super::{CheckState, Gh, PullRequestLabel, ReviewState, review_state_from, text};
use oxide_platform::sync::LockExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A plain comment, which its author can edit or delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineComment {
    /// GitHub's node id.
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub reactions: Vec<ReactionGroup>,
}

/// A submitted review. Its node id is kept (to react to it), but it is never edited here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineReview {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub state: ReviewState,
    pub reactions: Vec<ReactionGroup>,
}

/// A commit pushed to a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineCommit {
    pub oid: String,
    pub abbreviated_oid: String,
    /// The first line of the message.
    pub headline: String,
    /// The GitHub login of the author, or the name in the commit when it has none.
    pub author: String,
    pub committed_at: String,
    /// Whether GitHub verified the signature.
    pub verified: bool,
    /// The combined state of its checks, when it has any.
    pub status: Option<CheckState>,
    /// Its page on GitHub; empty when GitHub gave none over HTTPS.
    pub url: String,
}

/// A force-push to the head branch of a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineForcePush {
    pub actor: String,
    pub created_at: String,
    pub branch: String,
    /// Abbreviated commit the branch pointed at before; empty when GitHub no longer knows it.
    pub before: String,
    pub after: String,
    /// GitHub's comparison of the two commits; empty when either is unknown.
    pub compare_url: String,
}

/// Someone assigned or unassigned, or asked or no longer asked to review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePerson {
    pub actor: String,
    pub created_at: String,
    /// The person (or team) the event is about.
    pub login: String,
}

/// A label added or removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLabel {
    pub actor: String,
    pub created_at: String,
    pub label: PullRequestLabel,
}

/// The issue or pull request was closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClosed {
    pub actor: String,
    pub created_at: String,
    /// `COMPLETED`, `NOT_PLANNED` or `DUPLICATE` for an issue; empty for a pull request.
    pub state_reason: String,
}

/// An event that is only who and when: reopened, converted to draft, marked ready for
/// review, head branch deleted or restored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineAction {
    pub actor: String,
    pub created_at: String,
}

/// A pull request merged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMerge {
    pub actor: String,
    pub created_at: String,
    /// The abbreviated merge commit.
    pub commit: String,
    /// The branch it was merged into.
    pub base: String,
}

/// The title changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRename {
    pub actor: String,
    pub created_at: String,
    pub from: String,
    pub to: String,
}

/// Another issue or pull request mentioned this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineReference {
    pub actor: String,
    pub created_at: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub pull_request: bool,
    /// `owner/name` of the repository the reference is in.
    pub repository: String,
    pub cross_repository: bool,
}

/// One entry of the Activity Timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TimelineItem {
    Comment(TimelineComment),
    Review(TimelineReview),
    Commit(TimelineCommit),
    ForcePush(TimelineForcePush),
    Assigned(TimelinePerson),
    Unassigned(TimelinePerson),
    Labeled(TimelineLabel),
    Unlabeled(TimelineLabel),
    ReviewRequested(TimelinePerson),
    ReviewRequestRemoved(TimelinePerson),
    Closed(TimelineClosed),
    Reopened(TimelineAction),
    Merged(TimelineMerge),
    ConvertedToDraft(TimelineAction),
    ReadyForReview(TimelineAction),
    Renamed(TimelineRename),
    HeadRefDeleted(TimelineAction),
    HeadRefRestored(TimelineAction),
    CrossReferenced(TimelineReference),
}

/// What the timeline query adds to a detail view.
#[derive(Debug, Default)]
pub(super) struct Timeline {
    /// The GraphQL node id of the issue or pull request.
    pub node_id: String,
    pub participants: Vec<String>,
    /// The reactions on the description.
    pub reactions: Vec<ReactionGroup>,
    pub items: Vec<TimelineItem>,
    /// Signed URLs for the user attachments of the description, comments and reviews.
    pub signed_images: Vec<SignedImage>,
    /// Whether GitHub holds more entries than the pages read.
    pub truncated: bool,
}

/// Which kind of number the query asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Subject {
    Issue,
    PullRequest,
}

/// The timeline entries one page holds, GitHub's maximum.
const PAGE_SIZE: u32 = 100;
/// The pages read at most, so a very long conversation costs a bounded number of round trips.
const MAX_PAGES: usize = 5;

/// How long the pages after the first, from the last full read, stand in for themselves when
/// a poll reads only the first: under the few minutes GitHub's signed image URLs in their
/// bodies stay valid, and a poll past it reads every page again.
const LATER_PAGES_TTL: Duration = Duration::from_secs(4 * 60);
/// The timelines whose later pages are kept at most.
const LATER_PAGES_KEPT: usize = 16;

/// The entries after the first page of the timelines read in full lately, so a background poll
/// (every few seconds while checks run) costs one GraphQL round trip instead of up to
/// [`MAX_PAGES`]. Only comments and reviews are sure to be current in what a poll returns
/// (the detail view adds those from `gh`); newer events past the first page wait for the next
/// full read.
#[derive(Default)]
pub(super) struct LaterPages(Mutex<HashMap<(PathBuf, Subject, u32), Later>>);

struct Later {
    read_at: Instant,
    /// The end cursor of the first page they follow: a first page that changed starts afresh.
    after: String,
    nodes: Vec<serde_json::Value>,
    /// Whether GitHub held more than the pages read.
    more: bool,
}

impl LaterPages {
    fn get(
        &self,
        key: &(PathBuf, Subject, u32),
        after: &str,
    ) -> Option<(Vec<serde_json::Value>, bool)> {
        let pages = self.0.lock_recover();
        let later = pages.get(key)?;
        (later.after == after && later.read_at.elapsed() < LATER_PAGES_TTL)
            .then(|| (later.nodes.clone(), later.more))
    }

    fn keep(&self, key: (PathBuf, Subject, u32), later: Option<Later>) {
        let mut pages = self.0.lock_recover();
        pages.retain(|_, l| l.read_at.elapsed() < LATER_PAGES_TTL);
        match later {
            Some(later) => {
                if pages.len() >= LATER_PAGES_KEPT && !pages.contains_key(&key) {
                    pages.clear();
                }
                pages.insert(key, later);
            }
            None => {
                pages.remove(&key);
            }
        }
    }

    /// Forgets every timeline, e.g. when `gh` changes account.
    pub(super) fn clear(&self) {
        self.0.lock_recover().clear();
    }
}

const ACTOR: &str = "actor{login} createdAt";

/// The fields read for each kind of timeline entry; a kind not listed is skipped.
fn item_fields(subject: Subject) -> String {
    let mut fields = format!(
        "__typename \
         ... on IssueComment{{id author{{login}} body bodyHTML createdAt {REACTION_FIELDS}}} \
         ... on AssignedEvent{{{ACTOR} assignee{{... on User{{login}} ... on Bot{{login}} ... on Mannequin{{login}} ... on Organization{{login}}}}}} \
         ... on UnassignedEvent{{{ACTOR} assignee{{... on User{{login}} ... on Bot{{login}} ... on Mannequin{{login}} ... on Organization{{login}}}}}} \
         ... on LabeledEvent{{{ACTOR} label{{name color}}}} \
         ... on UnlabeledEvent{{{ACTOR} label{{name color}}}} \
         ... on ClosedEvent{{{ACTOR} stateReason}} \
         ... on ReopenedEvent{{{ACTOR}}} \
         ... on RenamedTitleEvent{{{ACTOR} previousTitle currentTitle}} \
         ... on CrossReferencedEvent{{{ACTOR} isCrossRepository source{{__typename \
           ... on Issue{{number title url state repository{{nameWithOwner}}}} \
           ... on PullRequest{{number title url state repository{{nameWithOwner}}}}}}}}"
    );
    if let Subject::PullRequest = subject {
        fields.push_str(&format!(
            " ... on PullRequestReview{{id author{{login}} body bodyHTML state createdAt submittedAt {REACTION_FIELDS}}} \
             ... on PullRequestCommit{{commit{{oid abbreviatedOid messageHeadline committedDate url \
               author{{name user{{login}}}} signature{{isValid}} statusCheckRollup{{state}}}}}} \
             ... on HeadRefForcePushedEvent{{{ACTOR} ref{{name}} beforeCommit{{oid abbreviatedOid}} afterCommit{{oid abbreviatedOid}}}} \
             ... on ReviewRequestedEvent{{{ACTOR} requestedReviewer{{... on User{{login}} ... on Team{{name}} ... on Mannequin{{login}} ... on Bot{{login}}}}}} \
             ... on ReviewRequestRemovedEvent{{{ACTOR} requestedReviewer{{... on User{{login}} ... on Team{{name}} ... on Mannequin{{login}} ... on Bot{{login}}}}}} \
             ... on MergedEvent{{{ACTOR} mergeRefName commit{{abbreviatedOid}}}} \
             ... on ConvertToDraftEvent{{{ACTOR}}} \
             ... on ReadyForReviewEvent{{{ACTOR}}} \
             ... on HeadRefDeletedEvent{{{ACTOR}}} \
             ... on HeadRefRestoredEvent{{{ACTOR}}}"
        ));
    }
    fields
}

/// One page of the timeline query: the first also reads the node's own fields, the next ones
/// only the entries after `cursor`.
fn timeline_page(
    gh: &Gh,
    cwd: &Path,
    subject: Subject,
    number: u32,
    cursor: Option<&str>,
) -> Option<serde_json::Value> {
    let field = match subject {
        Subject::Issue => "issue",
        Subject::PullRequest => "pullRequest",
    };
    let head = if cursor.is_none() {
        format!("id url bodyHTML {REACTION_FIELDS} participants(first:50){{nodes{{login}}}} ")
    } else {
        String::new()
    };
    let query = format!(
        "query=query($owner:String!,$name:String!,$number:Int!,$cursor:String){{\
         repository(owner:$owner,name:$name){{{field}(number:$number){{{head}\
         timelineItems(first:{PAGE_SIZE},after:$cursor){{pageInfo{{hasNextPage endCursor}} \
         nodes{{{}}}}}}}}}}}",
        item_fields(subject)
    );
    let number = format!("number={number}");
    let cursor = cursor.map(|cursor| format!("cursor={cursor}"));
    let jq = format!(".data.repository.{field}");
    let mut args = vec![
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "name={repo}",
        "-F",
        &number,
        "-f",
        &query,
    ];
    if let Some(cursor) = &cursor {
        // GitHub's opaque cursor, a string field: never `-F`, which would read `@file`.
        args.extend(["-f", cursor.as_str()]);
    }
    args.extend(["--jq", &jq]);
    let out = gh.run(cwd, &args).map_err(crate::Error::from);
    oxide_platform::diag::best_effort("timeline query", out.as_ref().map(|_| ()));
    let parsed = super::parse(&out.ok()?);
    oxide_platform::diag::best_effort("timeline response", parsed.as_ref().map(|_| ()));
    parsed.ok()
}

/// The cursor of the page after the one `info` describes, if GitHub holds one.
fn next_cursor(info: &serde_json::Value) -> Option<&str> {
    info["endCursor"]
        .as_str()
        .filter(|c| info["hasNextPage"].as_bool() == Some(true) && !c.is_empty())
}

/// The timeline, node id and participants of issue or pull request `number`, up to
/// [`MAX_PAGES`] pages of entries. A `poll` reads only the first page and reuses the later
/// ones of a full read made in the last few minutes ([`LaterPages`]). Best effort: `None` when
/// GitHub refuses the query, so the detail view still shows what `gh` gave.
pub(super) fn timeline(
    gh: &Gh,
    cwd: &Path,
    subject: Subject,
    number: u32,
    poll: bool,
) -> Option<Timeline> {
    let mut node = timeline_page(gh, cwd, subject, number, None)?;
    let mut items = list(&node["timelineItems"]["nodes"]).to_vec();
    let key = (cwd.to_path_buf(), subject, number);
    let mut truncated = false;
    if let Some(after) = next_cursor(&node["timelineItems"]["pageInfo"]).map(str::to_string) {
        let reused = if poll {
            gh.timeline_pages.get(&key, &after)
        } else {
            None
        };
        let (later, more) = reused.unwrap_or_else(|| {
            let (later, more, complete) = later_pages(gh, cwd, subject, number, &after);
            gh.timeline_pages.keep(
                key,
                complete.then(|| Later {
                    read_at: Instant::now(),
                    after,
                    nodes: later.clone(),
                    more,
                }),
            );
            (later, more)
        });
        items.extend(later);
        truncated = more;
    } else {
        gh.timeline_pages.keep(key, None);
    }
    node["timelineItems"]["nodes"] = serde_json::Value::Array(items);
    Some(Timeline {
        truncated,
        ..timeline_from(&node)
    })
}

/// The entries after `cursor`, up to [`MAX_PAGES`] pages counting the first, whether GitHub
/// holds more still, and whether every page asked for was read.
fn later_pages(
    gh: &Gh,
    cwd: &Path,
    subject: Subject,
    number: u32,
    cursor: &str,
) -> (Vec<serde_json::Value>, bool, bool) {
    let mut items = Vec::new();
    let mut cursor = cursor.to_string();
    for _ in 1..MAX_PAGES {
        let Some(page) = timeline_page(gh, cwd, subject, number, Some(&cursor)) else {
            return (items, true, false);
        };
        items.extend(list(&page["timelineItems"]["nodes"]).iter().cloned());
        match next_cursor(&page["timelineItems"]["pageInfo"]) {
            Some(next) => cursor = next.to_string(),
            None => return (items, false, true),
        }
    }
    (items, true, true)
}

impl TimelineItem {
    /// When it happened, as GitHub's ISO 8601 timestamp.
    pub fn at(&self) -> &str {
        match self {
            TimelineItem::Comment(c) => &c.created_at,
            TimelineItem::Review(r) => &r.created_at,
            TimelineItem::Commit(c) => &c.committed_at,
            TimelineItem::ForcePush(e) => &e.created_at,
            TimelineItem::Assigned(e)
            | TimelineItem::Unassigned(e)
            | TimelineItem::ReviewRequested(e)
            | TimelineItem::ReviewRequestRemoved(e) => &e.created_at,
            TimelineItem::Labeled(e) | TimelineItem::Unlabeled(e) => &e.created_at,
            TimelineItem::Closed(e) => &e.created_at,
            TimelineItem::Reopened(e)
            | TimelineItem::ConvertedToDraft(e)
            | TimelineItem::ReadyForReview(e)
            | TimelineItem::HeadRefDeleted(e)
            | TimelineItem::HeadRefRestored(e) => &e.created_at,
            TimelineItem::Merged(e) => &e.created_at,
            TimelineItem::Renamed(e) => &e.created_at,
            TimelineItem::CrossReferenced(e) => &e.created_at,
        }
    }

    /// What tells a comment or a review apart: its node id, or its author and time when
    /// GitHub gave no id.
    fn conversation_key(&self) -> Option<String> {
        let (id, author, at) = match self {
            TimelineItem::Comment(c) => (&c.id, &c.author, &c.created_at),
            TimelineItem::Review(r) => (&r.id, &r.author, &r.created_at),
            _ => return None,
        };
        Some(if id.is_empty() {
            format!("{author}\n{at}")
        } else {
            id.clone()
        })
    }
}

/// Adds to `items` each comment and review of `conversation` (oldest first, as `gh` read them)
/// that the timeline query did not return, in its place by time, so none can go missing when
/// the timeline was cut short or could not be read.
pub(super) fn merge_conversation(items: &mut Vec<TimelineItem>, conversation: Vec<TimelineItem>) {
    let known: std::collections::HashSet<String> = items
        .iter()
        .filter_map(TimelineItem::conversation_key)
        .collect();
    let mut from = 0;
    for entry in conversation {
        if entry
            .conversation_key()
            .is_some_and(|key| known.contains(&key))
        {
            continue;
        }
        let at = items
            .iter()
            .skip(from)
            .position(|item| item.at() > entry.at())
            .map_or(items.len(), |i| from + i);
        items.insert(at, entry);
        from = at + 1;
    }
}

fn list(value: &serde_json::Value) -> &[serde_json::Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn timeline_from(node: &serde_json::Value) -> Timeline {
    // `https://github.com/<owner>/<repo>/pull/<n>` without its last two segments.
    let url = https(&node["url"]);
    let repository = url
        .rsplitn(3, '/')
        .nth(2)
        .filter(|_| !url.is_empty())
        .unwrap_or_default();
    let items = list(&node["timelineItems"]["nodes"]);
    let mut images = Vec::new();
    for html in std::iter::once(node).chain(items).map(|n| &n["bodyHTML"]) {
        signed_images(html.as_str().unwrap_or_default(), &mut images);
    }
    Timeline {
        node_id: text(&node["id"]),
        participants: list(&node["participants"]["nodes"])
            .iter()
            .map(|p| text(&p["login"]))
            .filter(|login| !login.is_empty())
            .collect(),
        reactions: reactions_from(node),
        items: items
            .iter()
            .filter_map(|item| item_from(item, repository))
            .collect(),
        signed_images: images,
        truncated: false,
    }
}

/// A login that may be a user, a bot or a team (which has a `name`). Deleted accounts are
/// `null` on GitHub, shown as its `ghost`.
fn login(value: &serde_json::Value) -> String {
    let login = value["login"]
        .as_str()
        .or_else(|| value["name"].as_str())
        .unwrap_or_default();
    if login.is_empty() { "ghost" } else { login }.to_string()
}

fn https(value: &serde_json::Value) -> String {
    Some(text(value))
        .filter(|url| url.starts_with("https://"))
        .unwrap_or_default()
}

fn item_from(v: &serde_json::Value, repository: &str) -> Option<TimelineItem> {
    let actor = || login(&v["actor"]);
    let created_at = || text(&v["createdAt"]);
    let action = || TimelineAction {
        actor: actor(),
        created_at: created_at(),
    };
    let person = |key: &str| TimelinePerson {
        actor: actor(),
        created_at: created_at(),
        login: login(&v[key]),
    };
    let label = || TimelineLabel {
        actor: actor(),
        created_at: created_at(),
        label: PullRequestLabel {
            name: text(&v["label"]["name"]),
            color: text(&v["label"]["color"]),
        },
    };
    Some(match v["__typename"].as_str()? {
        "IssueComment" => TimelineItem::Comment(TimelineComment {
            id: text(&v["id"]),
            author: login(&v["author"]),
            body: text(&v["body"]),
            created_at: created_at(),
            reactions: reactions_from(v),
        }),
        "PullRequestReview" => {
            let state = review_state_from(v["state"].as_str())?;
            let body = text(&v["body"]);
            // A comment-only review with no text holds only inline comments, shown elsewhere.
            if body.trim().is_empty() && state == ReviewState::Commented {
                return None;
            }
            TimelineItem::Review(TimelineReview {
                id: text(&v["id"]),
                author: login(&v["author"]),
                body,
                created_at: v["submittedAt"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(created_at),
                state,
                reactions: reactions_from(v),
            })
        }
        "PullRequestCommit" => {
            let c = &v["commit"];
            TimelineItem::Commit(TimelineCommit {
                oid: text(&c["oid"]),
                abbreviated_oid: text(&c["abbreviatedOid"]),
                headline: text(&c["messageHeadline"]),
                author: c["author"]["user"]["login"]
                    .as_str()
                    .or_else(|| c["author"]["name"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                committed_at: text(&c["committedDate"]),
                verified: c["signature"]["isValid"].as_bool().unwrap_or(false),
                status: match c["statusCheckRollup"]["state"].as_str() {
                    Some("SUCCESS") => Some(CheckState::Success),
                    Some("PENDING" | "EXPECTED") => Some(CheckState::Pending),
                    Some("FAILURE" | "ERROR") => Some(CheckState::Failure),
                    _ => None,
                },
                url: https(&c["url"]),
            })
        }
        "HeadRefForcePushedEvent" => {
            let before = text(&v["beforeCommit"]["oid"]);
            let after = text(&v["afterCommit"]["oid"]);
            let known = |oid: &str| !oid.is_empty() && oid.bytes().all(|b| b.is_ascii_hexdigit());
            TimelineItem::ForcePush(TimelineForcePush {
                actor: actor(),
                created_at: created_at(),
                branch: text(&v["ref"]["name"]),
                before: text(&v["beforeCommit"]["abbreviatedOid"]),
                after: text(&v["afterCommit"]["abbreviatedOid"]),
                compare_url: if known(&before) && known(&after) && !repository.is_empty() {
                    format!("{repository}/compare/{before}..{after}")
                } else {
                    String::new()
                },
            })
        }
        "AssignedEvent" => TimelineItem::Assigned(person("assignee")),
        "UnassignedEvent" => TimelineItem::Unassigned(person("assignee")),
        "LabeledEvent" => TimelineItem::Labeled(label()),
        "UnlabeledEvent" => TimelineItem::Unlabeled(label()),
        "ReviewRequestedEvent" => TimelineItem::ReviewRequested(person("requestedReviewer")),
        "ReviewRequestRemovedEvent" => {
            TimelineItem::ReviewRequestRemoved(person("requestedReviewer"))
        }
        "ClosedEvent" => TimelineItem::Closed(TimelineClosed {
            actor: actor(),
            created_at: created_at(),
            state_reason: text(&v["stateReason"]),
        }),
        "ReopenedEvent" => TimelineItem::Reopened(action()),
        "MergedEvent" => TimelineItem::Merged(TimelineMerge {
            actor: actor(),
            created_at: created_at(),
            commit: text(&v["commit"]["abbreviatedOid"]),
            base: text(&v["mergeRefName"]),
        }),
        "ConvertToDraftEvent" => TimelineItem::ConvertedToDraft(action()),
        "ReadyForReviewEvent" => TimelineItem::ReadyForReview(action()),
        "RenamedTitleEvent" => TimelineItem::Renamed(TimelineRename {
            actor: actor(),
            created_at: created_at(),
            from: text(&v["previousTitle"]),
            to: text(&v["currentTitle"]),
        }),
        "HeadRefDeletedEvent" => TimelineItem::HeadRefDeleted(action()),
        "HeadRefRestoredEvent" => TimelineItem::HeadRefRestored(action()),
        "CrossReferencedEvent" => {
            let s = &v["source"];
            TimelineItem::CrossReferenced(TimelineReference {
                actor: actor(),
                created_at: created_at(),
                number: s["number"].as_u64().unwrap_or(0) as u32,
                title: text(&s["title"]),
                url: https(&s["url"]),
                state: text(&s["state"]),
                pull_request: s["__typename"].as_str() == Some("PullRequest"),
                repository: text(&s["repository"]["nameWithOwner"]),
                cross_repository: v["isCrossRepository"].as_bool().unwrap_or(false),
            })
        }
        _ => return None,
    })
}
