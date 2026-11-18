//! Blind review: a review of a change by a one-shot headless run of a Provider that receives only
//! the diff and the issue, with no Transcript content, in a throwaway detached worktree at the
//! reviewed state where it cannot touch the user's checkout. The run is not a Thread: its closing
//! message is parsed into findings that the user keeps or dismisses.

use crate::checkpoint;
use crate::git;
use crate::git_diff::{self, DiffKind};
use crate::line_comments::{CommentScope, CommentSide, LineComment};
use crate::worktree::{free_name, slugify};
use crate::{Core, Error, Result};
use oxide_provider::ProviderError;
use oxide_provider::oneshot::{self, OneShotRequest};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewProviderOption {
    pub provider: String,
    pub name: String,
    pub same_provider: bool,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewRequest {
    pub project_id: u32,
    pub thread_id: Option<u32>,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub turn_index: Option<u32>,
    #[serde(default)]
    pub issue: Option<String>,
}

/// How a one-shot Provider run is launched. Core uses the Provider's CLI; tests substitute a fake.
pub type OneShotRunner =
    Arc<dyn Fn(&OneShotRequest) -> std::result::Result<String, ProviderError> + Send + Sync>;

/// Where a Blind review stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlindReviewStatus {
    Running,
    Finished,
    Failed,
}

impl BlindReviewStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "failed" => Self::Failed,
            _ => Self::Finished,
        }
    }
}

/// One Blind review of a Thread's change: which Provider ran it and how far it got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewRun {
    pub id: u32,
    pub thread_id: Option<u32>,
    pub provider: String,
    pub scope: String,
    pub status: BlindReviewStatus,
    /// Why the run failed.
    pub error: Option<String>,
}

/// A Blind review that is set up (row recorded, worktree created, prompt built) but not yet run.
pub struct PreparedBlindReview {
    run: BlindReviewRun,
    root: PathBuf,
    worktree: PathBuf,
    prompt: String,
    diff_text: String,
    model: Option<String>,
    effort: Option<String>,
}

impl PreparedBlindReview {
    pub fn run(&self) -> &BlindReviewRun {
        &self.run
    }
}

/// What the reviewer decided about one finding. Only a kept finding becomes a draft Line comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingDecision {
    Pending,
    Kept,
    Dismissed,
}

impl FindingDecision {
    fn parse(s: &str) -> Self {
        match s {
            "kept" => Self::Kept,
            "dismissed" => Self::Dismissed,
            _ => Self::Pending,
        }
    }
}

/// One finding of a Blind review. A finding that Oxide could not anchor to the reviewed Diff is
/// kept as plain text, never dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewFinding {
    pub id: u32,
    pub review_id: u32,
    /// The reviewing Provider, so the finding is never mistaken for the user's own comment.
    pub provider: String,
    /// The line the finding is about; `None` when it could not be anchored.
    pub path: Option<String>,
    pub side: Option<CommentSide>,
    pub line: Option<u32>,
    /// The quoted code of the anchored line; empty for a plain-text finding.
    pub code: String,
    /// The finding's text, or the reply that could not be parsed.
    pub body: String,
    /// The finding could not be anchored to the reviewed Diff and is shown as plain text.
    pub plain: bool,
    pub decision: FindingDecision,
}

/// The most diff text a Blind review prompt carries.
const MAX_REVIEW_DIFF_BYTES: usize = 512 * 1024;
/// The most issue text a Blind review prompt carries.
const MAX_REVIEW_ISSUE_BYTES: usize = 16 * 1024;

fn truncate_text(mut text: String, max: usize, what: &str) -> String {
    if text.len() <= max {
        return text;
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str(&format!("\n[{what} truncated]\n"));
    text
}

/// Builds the prompt for a Blind review: only the diff, the issue, and the required output
/// format, with diff and issue delimited as data; no Transcript content is included.
pub fn build_blind_review_prompt(issue_text: Option<&str>, diff_text: &str) -> String {
    let issue_content = issue_text
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("No issue description provided.");
    format!(
        "Please review the following code changes against the issue specification. Do not modify any files.\n\
         Provide your findings in the following JSON format:\n\
         ```json\n\
         [\n  {{\n    \"path\": \"path/to/file\",\n    \"line\": 1,\n    \"body\": \"Comment explaining the finding\"\n  }}\n]\n\
         ```\n\
         If there are no findings, reply with an empty array `[]`.\n\n\
         <issue>\n\
         {issue_content}\n\
         </issue>\n\n\
         <diff>\n\
         {diff_text}\n\
         </diff>"
    )
}

fn is_same_provider(a: &str, b: &str) -> bool {
    a == b || (a == "antigravity" && b == "agy") || (a == "agy" && b == "antigravity")
}

fn provider_display_name(id: &str) -> &str {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        "agy" | "antigravity" => "Antigravity",
        "fake" => "Fake",
        other => other,
    }
}

impl Core {
    /// Whether a Provider can run a Blind review: it has a one-shot mode with a read-only setup.
    pub fn provider_can_honour_non_writing(&self, provider: &str) -> bool {
        provider == "fake" || oneshot::supports_one_shot(provider)
    }

    /// The installed Providers that can honour a non-writing configuration.
    /// With a single Provider, a fresh session is allowed and clearly labelled as the same Provider.
    pub fn blind_review_providers(
        &self,
        current_provider: Option<&str>,
    ) -> Vec<BlindReviewProviderOption> {
        let candidates = ["claude", "codex", "agy", "fake"];
        let mut eligible = Vec::new();

        for &id in &candidates {
            let det = self.detect_provider(id);
            if (det.installed || det.available) && self.provider_can_honour_non_writing(id) {
                eligible.push(id);
            }
        }

        let is_single = eligible.len() == 1;

        eligible
            .into_iter()
            .map(|id| {
                let is_same = current_provider.is_some_and(|cp| is_same_provider(cp, id));
                let name = provider_display_name(id);
                let label = if is_same || is_single {
                    format!("{name} (same provider)")
                } else {
                    name.to_string()
                };
                BlindReviewProviderOption {
                    provider: id.to_string(),
                    name: name.to_string(),
                    same_provider: is_same,
                    label,
                }
            })
            .collect()
    }

    /// Creates a worktree detached at `commit_ish` under `home/worktrees/<project-slug>/`.
    pub(crate) fn create_detached_worktree(
        &self,
        root: &Path,
        project_name: &str,
        commit_ish: &str,
        slug: &str,
    ) -> Result<PathBuf> {
        let parent = self
            .home
            .join("worktrees")
            .join(slugify(project_name, "project"));
        std::fs::create_dir_all(&parent).map_err(|source| Error::Io {
            path: parent.clone(),
            source,
        })?;
        let worktree = self.git.mutate(root, || {
            let name = free_name(root, &parent, slug);
            let worktree = parent.join(&name);
            git::run(
                root,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    "-q",
                    &worktree.to_string_lossy(),
                    commit_ish,
                ],
            )?;
            Ok(worktree)
        })?;
        Ok(worktree)
    }

    /// Records a Blind review, creates its throwaway detached worktree at the reviewed state and
    /// builds its prompt, but does not run the Provider yet.
    pub fn prepare_blind_review(&self, request: BlindReviewRequest) -> Result<PreparedBlindReview> {
        let reviewed_thread = request
            .thread_id
            .ok_or_else(|| Error::Git("A Thread is required for a Blind review".into()))?;
        if !self.provider_can_honour_non_writing(&request.provider) {
            return Err(Error::Provider(format!(
                "Provider '{}' cannot honour a non-writing configuration",
                request.provider
            )));
        }

        if !matches!(request.scope.as_str(), "turn" | "branch" | "uncommitted") {
            return Err(Error::Git(format!(
                "Unknown Blind review scope '{}'",
                request.scope.chars().take(32).collect::<String>()
            )));
        }
        let (def_model, def_effort, _) = self.default_settings_for_provider(&request.provider);
        let model = request.model.clone().or(def_model);
        let effort = request.effort.clone().or(def_effort);
        for value in [&model, &effort].into_iter().flatten() {
            if !oneshot::is_flag_value(value) {
                return Err(Error::Provider(
                    "The model or effort of a Blind review is not a plain value".into(),
                ));
            }
        }

        let (root, project_name) = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let (path, name): (String, String) = db.query_row(
                "SELECT path, name FROM projects WHERE id = ?1",
                [request.project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            (PathBuf::from(path), name)
        };

        let checkout = if let Some(tid) = request.thread_id {
            PathBuf::from(self.checkout_path(request.project_id, Some(tid))?)
        } else {
            root.clone()
        };

        let (diff_text, commit_ish) = match request.scope.as_str() {
            "turn" => {
                let tid = request
                    .thread_id
                    .ok_or_else(|| Error::Git("A Thread is required for Turn diff".into()))?;
                let turn_idx = match request.turn_index {
                    Some(idx) => idx,
                    None => {
                        let snapshot = self.storage.get_snapshot(tid, u32::MAX)?;
                        snapshot.turns.last().map(|t| t.turn_index).unwrap_or(0)
                    }
                };

                if let Some((start, end)) = checkpoint::turn_revs(&checkout, tid, turn_idx)? {
                    let diff = git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &start,
                            &end,
                            "--",
                        ],
                    )?;
                    (diff, end)
                } else {
                    let commit = git::run(&checkout, &["rev-parse", "HEAD"])?
                        .trim()
                        .to_string();
                    ("(No diff)".to_string(), commit)
                }
            }
            "branch" => {
                let base = git_diff::base_branch(&checkout).unwrap_or_else(|| "main".to_string());
                let fork = git::run(&checkout, &["merge-base", &base, "HEAD"])
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let commit = git::run(&checkout, &["rev-parse", "HEAD"])?
                    .trim()
                    .to_string();
                let diff = if !fork.is_empty() {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &fork,
                            "HEAD",
                            "--",
                        ],
                    )?
                } else {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &base,
                            "HEAD",
                            "--",
                        ],
                    )
                    .unwrap_or_default()
                };
                (diff, commit)
            }
            _ => {
                // Uncommitted scope (default)
                let has_head = git::run(&checkout, &["rev-parse", "--verify", "HEAD"]).is_ok();
                let commit = if has_head {
                    checkpoint::snapshot(&checkout).unwrap_or_else(|_| {
                        git::run(&checkout, &["rev-parse", "HEAD"])
                            .unwrap_or_default()
                            .trim()
                            .to_string()
                    })
                } else {
                    checkpoint::snapshot(&checkout)?
                };
                let diff = if has_head {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            "HEAD",
                            &commit,
                            "--",
                        ],
                    )
                    .unwrap_or_else(|_| {
                        git::run(
                            &checkout,
                            &[
                                "--no-optional-locks",
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "HEAD",
                                "--",
                            ],
                        )
                        .unwrap_or_default()
                    })
                } else {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &commit,
                            "--",
                        ],
                    )
                    .unwrap_or_default()
                };
                (diff, commit)
            }
        };

        let issue_text = if let Some(explicit) = request.issue.filter(|s| !s.trim().is_empty()) {
            explicit
        } else if let Some(tid) = request.thread_id {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let issue_row: Option<(Option<u32>, Option<String>, Option<String>)> = db
                .query_row(
                    "SELECT issue_number, issue_title, issue_url FROM threads WHERE id = ?1",
                    [tid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            if let Some((Some(n), title, url)) = issue_row {
                let t = title.unwrap_or_default();
                let u = url.unwrap_or_default();
                format!("Issue #{n}: {t}\n{u}")
            } else {
                "No issue description provided.".to_string()
            }
        } else {
            "No issue description provided.".to_string()
        };

        let diff_text = truncate_text(diff_text, MAX_REVIEW_DIFF_BYTES, "diff");
        let issue_text = truncate_text(issue_text, MAX_REVIEW_ISSUE_BYTES, "issue");
        let prompt = build_blind_review_prompt(Some(&issue_text), &diff_text);

        let worktree =
            self.create_detached_worktree(&root, &project_name, &commit_ish, "blind-review")?;

        let inserted = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "INSERT INTO blind_reviews (thread_id, provider, scope, status, worktree)
                 VALUES (?1, ?2, ?3, 'running', ?4)",
                rusqlite::params![
                    reviewed_thread,
                    request.provider,
                    request.scope,
                    worktree.to_string_lossy()
                ],
            )
            .map_err(Error::from)
            .and_then(|_| {
                u32::try_from(db.last_insert_rowid())
                    .map_err(|_| Error::Git("Blind review id out of range".into()))
            })
        };
        let id = match inserted {
            Ok(id) => id,
            Err(error) => {
                self.remove_detached_worktree(&root, &worktree);
                return Err(error);
            }
        };

        Ok(PreparedBlindReview {
            run: BlindReviewRun {
                id,
                thread_id: Some(reviewed_thread),
                provider: request.provider,
                scope: request.scope,
                status: BlindReviewStatus::Running,
                error: None,
            },
            root,
            worktree,
            prompt,
            diff_text,
            model,
            effort,
        })
    }

    /// Replaces how one-shot Provider runs are launched.
    pub fn set_one_shot_runner(&self, runner: OneShotRunner) {
        *self
            .one_shot_runner
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = runner;
    }

    /// Runs a prepared Blind review to its end: launches the Provider once in the throwaway
    /// worktree, records its closing message as findings (or the failure), and removes the
    /// worktree. Blocks until the Provider is done.
    pub fn execute_blind_review(&self, prepared: PreparedBlindReview) -> Result<BlindReviewRun> {
        let runner = self
            .one_shot_runner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut request = OneShotRequest::new(
            prepared.run.provider.clone(),
            prepared.worktree.clone(),
            prepared.prompt.clone(),
        );
        request.model = prepared.model.clone();
        request.effort = prepared.effort.clone();
        let outcome = runner(&request);
        self.remove_detached_worktree(&prepared.root, &prepared.worktree);

        let mut run = prepared.run;
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = crate::db::write_transaction(&db)?;
        match outcome {
            Ok(message) => {
                for finding in parse_findings(&message, &prepared.diff_text) {
                    tx.execute(
                        "INSERT INTO blind_review_findings
                         (review_id, path, side, line, code, body, anchored)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        rusqlite::params![
                            run.id,
                            finding.path,
                            finding.side.map(CommentSide::as_str),
                            finding.line,
                            finding.code,
                            finding.body,
                            finding.anchored as i64,
                        ],
                    )?;
                }
                run.status = BlindReviewStatus::Finished;
            }
            Err(error) => {
                run.status = BlindReviewStatus::Failed;
                run.error = Some(error.to_string());
            }
        }
        tx.execute(
            "UPDATE blind_reviews SET status = ?2, error = ?3, worktree = NULL WHERE id = ?1",
            rusqlite::params![run.id, run.status.as_str(), run.error],
        )?;
        tx.commit()?;
        Ok(run)
    }

    /// Prepares and runs a Blind review, blocking until it ends.
    pub fn run_blind_review(&self, request: BlindReviewRequest) -> Result<BlindReviewRun> {
        let prepared = self.prepare_blind_review(request)?;
        self.execute_blind_review(prepared)
    }

    /// The Blind reviews of a Thread, oldest first.
    pub fn blind_review_runs(&self, thread_id: u32) -> Result<Vec<BlindReviewRun>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT id, thread_id, provider, scope, status, error FROM blind_reviews
             WHERE thread_id = ?1 ORDER BY id",
        )?;
        let runs = stmt
            .query_map([thread_id], |r| {
                Ok(BlindReviewRun {
                    id: r.get(0)?,
                    thread_id: r.get(1)?,
                    provider: r.get(2)?,
                    scope: r.get(3)?,
                    status: BlindReviewStatus::parse(&r.get::<_, String>(4)?),
                    error: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(runs)
    }

    /// Removes a review's throwaway worktree. Best effort: a leftover worktree is only clutter.
    fn remove_detached_worktree(&self, root: &Path, worktree: &Path) {
        let _ = self.git.mutate(root, || {
            git::run(
                root,
                &["worktree", "remove", "--force", &worktree.to_string_lossy()],
            )
            .map(drop)
        });
    }

    /// A review that was running when Oxide quit never finished: report it as failed and remove
    /// its worktree.
    pub(crate) fn recover_interrupted_blind_reviews(&self) {
        let stale: Vec<(u32, Option<String>, Option<String>)> = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let Ok(mut stmt) = db.prepare(
                "SELECT r.id, r.worktree, p.path FROM blind_reviews r
                 LEFT JOIN threads t ON t.id = r.thread_id
                 LEFT JOIN projects p ON p.id = t.project_id
                 WHERE r.status = 'running'",
            ) else {
                return;
            };
            let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))) else {
                return;
            };
            rows.filter_map(std::result::Result::ok).collect()
        };
        for (id, worktree, root) in stale {
            if let (Some(worktree), Some(root)) = (worktree, root) {
                self.remove_detached_worktree(Path::new(&root), Path::new(&worktree));
            }
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db.execute(
                "UPDATE blind_reviews
                 SET status = 'failed', error = 'Oxide quit before the review finished', worktree = NULL
                 WHERE id = ?1",
                [id],
            );
        }
    }

    /// The findings of every Blind review of `thread_id`. They were parsed once when the review
    /// finished, and keep every reply, including one that cannot be parsed, as plain text.
    pub fn list_blind_review_findings(&self, thread_id: u32) -> Result<Vec<BlindReviewFinding>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT f.id, r.id, r.provider, f.path, f.side, f.line, f.code, f.body,
                    f.anchored, f.decision
             FROM blind_review_findings f JOIN blind_reviews r ON r.id = f.review_id
             WHERE r.thread_id = ?1
             ORDER BY r.id, f.id",
        )?;
        let findings = stmt
            .query_map([thread_id], |r| {
                let side: Option<String> = r.get(4)?;
                Ok(BlindReviewFinding {
                    id: r.get(0)?,
                    review_id: r.get(1)?,
                    provider: r.get(2)?,
                    path: r.get(3)?,
                    side: side.map(|s| CommentSide::parse(&s)),
                    line: r.get(5)?,
                    code: r.get(6)?,
                    body: r.get(7)?,
                    plain: r.get::<_, i64>(8)? == 0,
                    decision: FindingDecision::parse(&r.get::<_, String>(9)?),
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(findings)
    }

    /// Keeps one finding. An anchored finding becomes a draft Line comment on the reviewed Thread,
    /// using the same send flow as every other draft; a plain-text finding stays visible but has
    /// no line to attach to. Keeping twice returns the same draft.
    pub fn keep_blind_review_finding(&self, id: u32) -> Result<Option<LineComment>> {
        let (reviewed, scope, provider, path, side, line, code, body, anchored) = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row(
                "SELECT r.thread_id, r.scope, r.provider, f.path, f.side, f.line, f.code, f.body,
                        f.anchored
                 FROM blind_review_findings f JOIN blind_reviews r ON r.id = f.review_id
                 WHERE f.id = ?1",
                [id],
                |r| {
                    let scope: String = r.get(1)?;
                    let side: Option<String> = r.get(4)?;
                    Ok((
                        r.get::<_, Option<u32>>(0)?,
                        CommentScope::parse(&scope),
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        side.map(|s| CommentSide::parse(&s)),
                        r.get::<_, Option<u32>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, i64>(8)? != 0,
                    ))
                },
            )?
        };
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "UPDATE blind_review_findings SET decision = 'kept' WHERE id = ?1",
                [id],
            )?;
        }
        let (Some(thread_id), true, Some(path), Some(side), Some(line)) =
            (reviewed, anchored, path, side, line)
        else {
            return Ok(None);
        };
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let existing = db.query_row(
                "SELECT id, scope, path, side, line, code, body, provider FROM line_comments
                 WHERE finding_id = ?1",
                [id],
                |r| {
                    Ok(LineComment {
                        id: r.get(0)?,
                        thread_id,
                        scope: CommentScope::parse(&r.get::<_, String>(1)?),
                        path: r.get(2)?,
                        side: CommentSide::parse(&r.get::<_, String>(3)?),
                        line: r.get(4)?,
                        code: r.get(5)?,
                        body: r.get(6)?,
                        outdated: false,
                        provider: r.get(7)?,
                    })
                },
            );
            if let Ok(comment) = existing {
                return Ok(Some(comment));
            }
            db.execute(
                "INSERT INTO line_comments
                 (thread_id, scope, path, side, line, code, body, provider, finding_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    thread_id,
                    scope.as_str(),
                    path,
                    side.as_str(),
                    line,
                    code,
                    body,
                    provider,
                    id
                ],
            )?;
            let comment_id = db.last_insert_rowid() as u32;
            Ok(Some(LineComment {
                id: comment_id,
                thread_id,
                scope,
                path,
                side,
                line,
                code,
                body,
                outdated: false,
                provider: Some(provider),
            }))
        }
    }

    /// Dismisses one finding: it never reaches the Thread, and a draft it already made is removed.
    pub fn dismiss_blind_review_finding(&self, id: u32) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "UPDATE blind_review_findings SET decision = 'dismissed' WHERE id = ?1",
            [id],
        )?;
        db.execute("DELETE FROM line_comments WHERE finding_id = ?1", [id])?;
        Ok(())
    }
}

struct ParsedFinding {
    path: Option<String>,
    side: Option<CommentSide>,
    line: Option<u32>,
    code: String,
    body: String,
    anchored: bool,
}

fn diff_anchors(diff_text: &str) -> std::collections::HashMap<(String, CommentSide, u32), String> {
    let mut anchors = std::collections::HashMap::new();
    for file in git_diff::parse_patch(diff_text) {
        for hunk in &file.hunks {
            let Some((mut old, mut new)) = hunk_starts(&hunk.header) else {
                continue;
            };
            for line in &hunk.lines {
                match line.kind {
                    DiffKind::Context => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::New, new),
                            line.text.clone(),
                        );
                        anchors.insert(
                            (file.path.clone(), CommentSide::Old, old),
                            line.text.clone(),
                        );
                        old += 1;
                        new += 1;
                    }
                    DiffKind::Added => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::New, new),
                            line.text.clone(),
                        );
                        new += 1;
                    }
                    DiffKind::Removed => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::Old, old),
                            line.text.clone(),
                        );
                        old += 1;
                    }
                }
            }
        }
    }
    anchors
}

/// The first line number of each side from `@@ -old +new @@`.
fn hunk_starts(header: &str) -> Option<(u32, u32)> {
    let inner = header.strip_prefix("@@ ")?.split(" @@").next()?;
    let mut parts = inner.split(' ');
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    Some((
        old.split(',').next()?.parse().ok()?,
        new.split(',').next()?.parse().ok()?,
    ))
}

fn anchor(
    anchors: &std::collections::HashMap<(String, CommentSide, u32), String>,
    path: &str,
    line: u32,
) -> Option<(String, CommentSide, u32, String)> {
    let mut variants = vec![path.to_string()];
    if let Some(rest) = path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
        variants.push(rest.to_string());
    }
    for candidate in variants {
        for side in [CommentSide::New, CommentSide::Old] {
            if let Some(code) = anchors.get(&(candidate.clone(), side, line)) {
                return Some((candidate, side, line, code.clone()));
            }
        }
    }
    None
}

/// Findings from the closing message, validated against the reviewed Diff. A reply that cannot
/// be parsed, or a finding that cannot be anchored, comes back as plain text.
fn parse_findings(message: &str, diff_text: &str) -> Vec<ParsedFinding> {
    let anchors = diff_anchors(diff_text);
    let Some(values) = extract_json(message) else {
        return vec![ParsedFinding {
            path: None,
            side: None,
            line: None,
            code: String::new(),
            body: message.trim().to_string(),
            anchored: false,
        }];
    };
    let mut findings = Vec::new();
    for value in values {
        let path = value.get("path").and_then(|v| v.as_str());
        let line = value.get("line").and_then(|v| v.as_u64()).map(|n| n as u32);
        let body = value
            .get("body")
            .and_then(|v| v.as_str())
            .or_else(|| value.as_str())
            .map(str::to_string);
        if let (Some(path), Some(line), Some(body)) = (path, line, body.clone()) {
            if let Some((path, side, line, code)) = anchor(&anchors, path, line) {
                findings.push(ParsedFinding {
                    path: Some(path),
                    side: Some(side),
                    line: Some(line),
                    code,
                    body,
                    anchored: true,
                });
                continue;
            }
            findings.push(ParsedFinding {
                path: Some(path.to_string()),
                side: None,
                line: Some(line),
                code: String::new(),
                body,
                anchored: false,
            });
            continue;
        }
        findings.push(ParsedFinding {
            path: path.map(str::to_string),
            side: None,
            line,
            code: String::new(),
            body: body.unwrap_or_else(|| value.to_string()),
            anchored: false,
        });
    }
    findings
}

/// The JSON array in a closing message, whether bare or inside a code fence or prose.
fn extract_json(message: &str) -> Option<Vec<serde_json::Value>> {
    for candidate in json_candidates(message) {
        if let Ok(serde_json::Value::Array(values)) =
            serde_json::from_str::<serde_json::Value>(candidate)
        {
            return Some(values);
        }
    }
    None
}

fn json_candidates(message: &str) -> Vec<&str> {
    let message = message.trim();
    let mut candidates = vec![message];
    let mut rest = message;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let Some(end) = after.find("```") else {
            break;
        };
        candidates.push(after[..end].trim());
        rest = &after[end + 3..];
    }
    if let (Some(start), Some(end)) = (message.find('['), message.rfind(']'))
        && start < end
    {
        candidates.push(&message[start..=end]);
    }
    candidates
}
