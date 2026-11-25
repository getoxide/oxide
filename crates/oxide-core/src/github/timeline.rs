//! The Activity Timeline of an issue or a pull request: its comments, reviews, commits and
//! events in the order GitHub shows them, read through one `gh api graphql` round trip.

use super::reactions::{REACTION_FIELDS, ReactionGroup, reactions_from};
use super::{CheckState, Gh, PullRequestLabel, ReviewState, review_state_from, text};
use serde::Serialize;
use std::path::Path;

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
}

/// Which kind of number the query asks for.
#[derive(Debug, Clone, Copy)]
pub(super) enum Subject {
    Issue,
    PullRequest,
}

/// The timeline entries GitHub keeps, as many as one page holds.
const MAX_ITEMS: u32 = 100;

const ACTOR: &str = "actor{login} createdAt";

/// The fields read for each kind of timeline entry; a kind not listed is skipped.
fn item_fields(subject: Subject) -> String {
    let mut fields = format!(
        "__typename \
         ... on IssueComment{{id author{{login}} body createdAt {REACTION_FIELDS}}} \
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
            " ... on PullRequestReview{{id author{{login}} body state createdAt submittedAt {REACTION_FIELDS}}} \
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

/// The timeline, node id and participants of issue or pull request `number`. Best effort:
/// `None` when GitHub refuses the query, so the detail view still shows what `gh` gave.
pub(super) fn timeline(gh: &Gh, cwd: &Path, subject: Subject, number: u32) -> Option<Timeline> {
    let field = match subject {
        Subject::Issue => "issue",
        Subject::PullRequest => "pullRequest",
    };
    let query = format!(
        "query=query($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{\
         {field}(number:$number){{id url {REACTION_FIELDS} participants(first:50){{nodes{{login}}}} \
         timelineItems(first:{MAX_ITEMS}){{nodes{{{}}}}}}}}}}}",
        item_fields(subject)
    );
    let number = format!("number={number}");
    let jq = format!(".data.repository.{field}");
    let out = gh
        .run(
            cwd,
            &[
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
                "--jq",
                &jq,
            ],
        )
        .ok()?;
    let node: serde_json::Value = serde_json::from_str(&out).ok()?;
    Some(timeline_from(&node))
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
    Timeline {
        node_id: text(&node["id"]),
        participants: list(&node["participants"]["nodes"])
            .iter()
            .map(|p| text(&p["login"]))
            .filter(|login| !login.is_empty())
            .collect(),
        reactions: reactions_from(node),
        items: list(&node["timelineItems"]["nodes"])
            .iter()
            .filter_map(|item| item_from(item, repository))
            .collect(),
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
