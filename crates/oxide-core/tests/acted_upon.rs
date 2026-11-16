//! Oxide does not contact a Project's remote on its own until the user has acted in it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
use oxide_core::{Core, PermissionMode};
use oxide_provider::FakeProvider;
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

struct Fixture {
    tmp: TempDir,
    core: Core,
    work: PathBuf,
    remote: PathBuf,
}

/// A checkout cloned from a local bare remote, not yet added as a Project.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let remote = root.join("remote.git");
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let work = root.join("scan").join("work");
    std::fs::create_dir_all(work.parent().unwrap()).unwrap();
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );
    git(&work, &["checkout", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);
    git(&work, &["push", "-q", "-u", "origin", "main"]);
    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    Fixture {
        tmp,
        core,
        work,
        remote,
    }
}

fn fetches(f: &Fixture, project: u32) -> bool {
    f.core.fetch_project_at(project, Instant::now()).unwrap()
}

#[test]
fn a_newly_added_project_is_not_fetched_until_the_user_acts() {
    let f = fixture();
    let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();

    assert!(!f.core.project_acted_upon(project.id).unwrap());
    assert!(!fetches(&f, project.id));
}

#[test]
fn pull_and_push_are_actions() {
    for push in [false, true] {
        let f = fixture();
        let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();
        if push {
            f.core.push_in(project.id, None, true).unwrap();
        } else {
            f.core.pull_in(project.id, None).unwrap();
        }
        assert!(f.core.project_acted_upon(project.id).unwrap());
        assert!(fetches(&f, project.id), "push: {push}");
    }
}

#[test]
fn a_failed_pull_still_counts_as_acting() {
    let f = fixture();
    let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();
    git(&f.work, &["remote", "set-url", "origin", "/nonexistent"]);
    assert!(f.core.pull_in(project.id, None).is_err());
    assert!(f.core.project_acted_upon(project.id).unwrap());
}

#[test]
fn the_first_prompt_is_an_action() {
    let f = fixture();
    let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();
    let thread = f
        .core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    assert!(!f.core.project_acted_upon(project.id).unwrap());
    f.core
        .register_fake_provider(thread.id, FakeProvider::default());
    f.core.send_prompt(thread.id, "go").unwrap();
    assert!(f.core.project_acted_upon(project.id).unwrap());
}

#[cfg(unix)]
#[test]
fn a_terminal_command_is_an_action() {
    let f = fixture();
    let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();
    let terminal = f.core.start_terminal(project.id, None).unwrap();
    assert!(
        !f.core.project_acted_upon(project.id).unwrap(),
        "opening a terminal runs nothing yet"
    );
    f.core.write_terminal(terminal.id, b"true\n").unwrap();
    assert!(f.core.project_acted_upon(project.id).unwrap());
    f.core.close_terminal(terminal.id).unwrap();
}

#[test]
fn the_flag_survives_a_restart() {
    let f = fixture();
    let project = f.core.add_project(&f.work.to_string_lossy()).unwrap();
    f.core.pull_in(project.id, None).unwrap();
    let home = f.tmp.path().join("home");
    drop(f.core);

    let reopened = Core::open(home).unwrap();
    assert!(reopened.project_acted_upon(project.id).unwrap());
}

#[test]
fn projects_oxide_created_or_cloned_start_acted_upon() {
    let f = fixture();
    let parent = f.tmp.path().join("projects");
    std::fs::create_dir_all(&parent).unwrap();

    let created = f
        .core
        .create_project(&parent.to_string_lossy(), "fresh")
        .unwrap();
    assert!(f.core.project_acted_upon(created.id).unwrap());

    let cloned = f
        .core
        .clone_project(&f.remote.to_string_lossy(), &parent.to_string_lossy())
        .unwrap();
    assert!(f.core.project_acted_upon(cloned.id).unwrap());
    assert!(fetches(&f, cloned.id));
}
