//! Git for a Project's main checkout, through the `git` CLI: argument arrays,
//! never a shell. Reads run concurrently; mutating commands are serialized
//! per checkout.

use crate::git_command::GitCommand;
use crate::{Error, Result};
use oxide_platform::sync::LockExt as _;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Minimum time between two background fetches of one checkout.
pub const FETCH_INTERVAL: Duration = Duration::from_secs(20);

/// Untracked files larger than this are not line-counted for the dirty chip.
pub(crate) const MAX_COUNTED_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `None` while HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Lines added by uncommitted changes, untracked files included.
    pub added: u32,
    pub removed: u32,
    /// Files with uncommitted changes, untracked included.
    pub changed_files: u32,
    /// Why the branch picker is disabled, if it is.
    pub picker_disabled_reason: Option<String>,
    /// A branch pushing to which needs the user's explicit consent.
    pub protected: bool,
    /// On a branch with commits that has no upstream yet, while an `origin`
    /// exists: the first push will publish it.
    pub unpublished: bool,
}

/// Branches that Oxide never pushes to without being told to.
const PROTECTED_BRANCHES: [&str; 2] = ["main", "master"];

/// Per-checkout locks for mutating Git commands, and the throttle for
/// background fetches.
#[derive(Default)]
pub struct GitState {
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    last_fetch: Mutex<HashMap<PathBuf, Instant>>,
}

impl GitState {
    pub fn mutate<T>(&self, cwd: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let lock = Arc::clone(
            self.locks
                .lock_recover()
                .entry(cwd.to_path_buf())
                .or_default(),
        );
        let _guard = lock.lock_recover();
        f()
    }

    /// Fetches unless the last fetch of this checkout was under
    /// [`FETCH_INTERVAL`] before `now`; returns whether it fetched. A failed
    /// fetch does not start a new interval.
    pub fn fetch(&self, cwd: &Path, now: Instant) -> Result<bool> {
        let due = |last: Option<&Instant>| {
            last.is_none_or(|last| now.saturating_duration_since(*last) >= FETCH_INTERVAL)
        };
        if !due(self.last(cwd).as_ref()) {
            return Ok(false);
        }
        self.mutate(cwd, || {
            // Another caller may have fetched while this one waited.
            if !due(self.last(cwd).as_ref()) {
                return Ok(false);
            }
            run(cwd, &["fetch", "--prune"])?;
            self.last_fetch
                .lock_recover()
                .insert(cwd.to_path_buf(), now);
            Ok(true)
        })
    }

    fn last(&self, cwd: &Path) -> Option<Instant> {
        self.last_fetch.lock_recover().get(cwd).copied()
    }
}

/// A read-only Git invocation: hooks off, hardening on.
pub(crate) fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    run_with_env(cwd, args, &[])
}

pub(crate) fn run_with_env(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
    GitCommand::read_only(cwd)
        .args(args)
        .envs(env.iter().copied())
        .run()
}

/// A Git invocation the user asked for (commit, checkout, pull, push, clone):
/// their hooks and helpers run, as in a terminal. Hardening stays on.
pub(crate) fn run_user(cwd: &Path, args: &[&str]) -> Result<String> {
    GitCommand::user_initiated(cwd).args(args).run()
}

pub(crate) fn succeeds(cwd: &Path, args: &[&str]) -> bool {
    run(cwd, args).is_ok()
}

/// Whether HEAD holds a commit no remote-tracking branch has.
fn has_unpushed_commits(cwd: &Path) -> bool {
    run(cwd, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
        .ok()
        .and_then(|n| n.trim().parse::<u32>().ok())
        .is_none_or(|n| n > 0)
}

/// The longest base branch name accepted from the webview.
const MAX_BRANCH_NAME: usize = 255;

/// A branch name from the webview, checked against the rules of
/// `git check-ref-format --branch` that matter here: nothing that Git could read
/// as an option, a range, a reflog entry or a revision expression.
pub(crate) fn valid_branch_name(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name.len() <= MAX_BRANCH_NAME
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && name != "@"
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.contains("/.")
        && !name.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        });
    if ok {
        Ok(name)
    } else {
        Err(Error::Git(format!(
            "{:?} is not a valid branch name.",
            name.chars().take(64).collect::<String>()
        )))
    }
}

/// How many commits the local branch `head` has beyond `base`, preferring the base's
/// remote-tracking branch; `None` when neither exists locally, so the caller cannot tell.
/// Both names must already be valid branch names.
pub(crate) fn commits_beyond(cwd: &Path, head: &str, base: &str) -> Option<u32> {
    let reference = base_reference(cwd, base)?;
    count(cwd, &format!("{reference}..refs/heads/{head}"))
}

/// `origin/<base>` when it exists locally, else the local `base`, else `None`.
pub(crate) fn base_reference(cwd: &Path, base: &str) -> Option<String> {
    [
        format!("refs/remotes/origin/{base}"),
        format!("refs/heads/{base}"),
    ]
    .into_iter()
    .find(|name| ref_exists(cwd, name))
}

fn count(cwd: &Path, range: &str) -> Option<u32> {
    run(cwd, &["rev-list", "--count", range, "--"])
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Whether `branch` is one Oxide never opens a pull request from or pushes to unasked.
pub(crate) fn is_protected(branch: &str) -> bool {
    PROTECTED_BRANCHES.contains(&branch)
}

/// Local branches, most recently committed first.
pub(crate) fn local_branches(cwd: &Path) -> Result<Vec<String>> {
    Ok(run(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:lstrip=2)",
            "refs/heads/",
        ],
    )?
    .lines()
    .filter(|name| !name.is_empty())
    .map(str::to_owned)
    .collect())
}

/// A valid branch name from the webview that names an existing local branch.
pub(crate) fn existing_local_branch(cwd: &Path, name: &str) -> Result<String> {
    let name = valid_branch_name(name)?;
    if ref_exists(cwd, &format!("refs/heads/{name}")) {
        Ok(name.to_string())
    } else {
        Err(Error::Git(format!("There is no local branch `{name}`.")))
    }
}

/// Pushes the local branch `branch` to the same name on `origin` and tracks it, without
/// checking it out, unless `origin` already has all of it. There is no force: a rejected
/// push stays rejected. Refuses a protected branch and one
/// that has diverged from `origin`. `branch` must be an existing, valid branch name.
/// A `pre-push` hook runs with HEAD on the checked-out branch, not on the pushed `branch`.
pub(crate) fn push_branch_if_needed(cwd: &Path, branch: &str) -> Result<()> {
    if is_protected(branch) {
        return Err(Error::Git(format!(
            "`{branch}` is protected; push a new branch instead."
        )));
    }
    let local = format!("refs/heads/{branch}");
    let remote = format!("refs/remotes/origin/{branch}");
    if ref_exists(cwd, &remote) {
        let ahead = count(cwd, &format!("{remote}..{local}")).unwrap_or(1);
        if ahead == 0 {
            return Ok(());
        }
        if count(cwd, &format!("{local}..{remote}")).unwrap_or(0) > 0 {
            return Err(Error::Git(format!(
                "`{branch}` is behind and ahead of `origin/{branch}`. Pull (fast-forward) before pushing."
            )));
        }
    }
    run_user(cwd, &["push", "-u", "origin", &format!("{local}:{local}")])?;
    Ok(())
}

pub(crate) fn ref_exists(cwd: &Path, name: &str) -> bool {
    succeeds(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{name}^{{commit}}"),
        ],
    )
}

pub fn status(cwd: &Path) -> Result<GitStatus> {
    let porcelain = run(
        cwd,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut status = GitStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        added: 0,
        removed: 0,
        changed_files: 0,
        picker_disabled_reason: None,
        protected: false,
        unpublished: false,
    };
    let mut untracked = Vec::new();
    let mut tracked = 0;
    let mut records = porcelain.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            match header.split_once(' ') {
                Some(("branch.head", head)) if head != "(detached)" => {
                    status.branch = Some(head.to_string())
                }
                Some(("branch.upstream", upstream)) => status.upstream = Some(upstream.to_string()),
                Some(("branch.ab", ab)) => {
                    let mut counts = ab.split(' ').map(|n| n[1..].parse().unwrap_or(0));
                    status.ahead = counts.next().unwrap_or(0);
                    status.behind = counts.next().unwrap_or(0);
                }
                _ => {}
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            untracked.push(path.to_string());
        } else if record.starts_with("2 ") {
            // Renames carry the original path as a separate record.
            records.next();
            tracked += 1;
        } else if record.starts_with("1 ") || record.starts_with("u ") {
            tracked += 1;
        }
    }
    status.changed_files = tracked + untracked.len() as u32;

    let has_head = succeeds(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    status.protected = status.branch.as_deref().is_some_and(is_protected);
    status.unpublished = has_head
        && status.branch.is_some()
        && status.upstream.is_none()
        && succeeds(cwd, &["config", "--get", "remote.origin.url"])
        // A branch cut from main with no commit of its own has nothing to publish.
        && has_unpushed_commits(cwd);

    let base = if has_head {
        "HEAD".to_string()
    } else {
        // No commits yet: diff against the empty tree.
        run(cwd, &["hash-object", "-t", "tree", "/dev/null"]).unwrap_or_default()
    };
    if !base.trim().is_empty() {
        let numstat = run(
            cwd,
            &[
                "--no-optional-locks",
                "diff",
                "--numstat",
                "--no-renames",
                base.trim(),
                "--",
            ],
        )?;
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            // Binary files report `-`.
            status.added += cols.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            status.removed += cols.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }
    use rayon::prelude::*;

    status.added += untracked
        .par_iter()
        .map(|p| count_lines(&cwd.join(p)))
        .sum::<u32>();
    Ok(status)
}

/// Lines in a text file, as `git diff` counts them; 0 for binary, oversized
/// or unreadable files.
fn count_lines(path: &Path) -> u32 {
    let read = || -> std::io::Result<Option<u32>> {
        // Symlinks may point outside the checkout; never read through them.
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_file() || meta.len() > MAX_COUNTED_BYTES {
            return Ok(None);
        }
        let file = File::open(path)?;
        let mut bytes = Vec::with_capacity(meta.len().min(MAX_COUNTED_BYTES) as usize);
        file.take(MAX_COUNTED_BYTES).read_to_end(&mut bytes)?;
        if bytes[..bytes.len().min(8000)].contains(&0) {
            return Ok(None);
        }
        let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
        let unterminated = bytes.last().is_some_and(|b| *b != b'\n');
        Ok(Some(newlines + u32::from(unterminated)))
    };
    read().ok().flatten().unwrap_or(0)
}
