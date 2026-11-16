//! A folder's own Git configuration must not run programs when Oxide only looks at it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]

use oxide_core::{Core, DiffScope, ProjectSummary};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Hostile {
    _tmp: TempDir,
    core: Core,
    work: PathBuf,
    marker: PathBuf,
}

fn executable(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A checkout whose own `.git/config` and hooks all point at a script that writes a marker.
fn hostile() -> Hostile {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let work = root.join("scan").join("work");
    std::fs::create_dir_all(&work).unwrap();
    let marker = root.join("MARKER");
    let script = root.join("evil.sh");
    let body = format!("#!/bin/sh\necho ran >> '{}'\nexit 1\n", marker.display());
    executable(&script, &body);

    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);
    let script = script.to_string_lossy().into_owned();
    for (key, value) in [
        ("core.fsmonitor", script.as_str()),
        ("core.sshCommand", script.as_str()),
        ("diff.evil.textconv", script.as_str()),
        ("remote.origin.url", "ssh://example.invalid/repo.git"),
    ] {
        git(&work, &["config", key, value]);
    }
    executable(&work.join(".git/hooks/post-checkout"), &body);
    // Uncommitted change, so that Diff has something to convert.
    std::fs::write(work.join("a.txt"), "two\n").unwrap();

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    Hostile {
        _tmp: tmp,
        core,
        work,
        marker,
    }
}

fn add(h: &Hostile) -> ProjectSummary {
    h.core.add_project(&h.work.to_string_lossy()).unwrap()
}

#[test]
fn looking_at_an_untrusted_project_runs_nothing() {
    let h = hostile();
    let project = add(&h);

    h.core.git_status_in(project.id, None).unwrap();
    h.core.list_branches_in(project.id, None).unwrap();
    h.core
        .diff_in(project.id, None, DiffScope::Uncommitted)
        .unwrap();
    // The automatic fetch must not reach the remote before the user acts.
    assert!(!h.core.fetch_project_at(project.id, Instant::now()).unwrap());

    assert!(!h.marker.exists(), "a program named by the repository ran");
}
