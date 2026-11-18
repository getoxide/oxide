#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]

mod support;

use oxide_core::{Core, ProjectSummary, ThreadStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use support::wait_until;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Reports Turns like Claude Code and edits files on command: `edit1` and `edit2` write files,
/// `work` and `finish` open and close a Turn.
const EDITING_AGENT: &str = r#"#!/bin/sh
printf '\033]7501;?\033\\'
stty -icanon -echo min 1
dd bs=1 count=80 2>/dev/null >/dev/null
echo READY
while IFS= read -r line; do
  case "$line" in
    work) printf '\033]7501;state=working:app=claude\033\\'; echo WORKING ;;
    finish) printf '\033]7501;state=done:app=claude\033\\'; echo FINISHED ;;
    edit1) echo first > one.txt; echo "changed" > a.txt; echo EDITED1 ;;
    edit2) echo second > two.txt; echo "changed again" > a.txt; echo EDITED2 ;;
  esac
done
"#;

/// An agent that never reports a Turn.
const SILENT_AGENT: &str = r#"#!/bin/sh
echo READY
while IFS= read -r line; do
  case "$line" in
    edit1) echo first > one.txt; echo "changed" > a.txt; echo EDITED1 ;;
  esac
done
"#;

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
}

fn fixture(agent: &str) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("oxide-home");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    std::fs::write(&claude, agent).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let work = tmp.path().join("scan").join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "committed\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let core = Core::open(&home).unwrap();
    core.set_real_time_ticker(false);
    core.set_agent_search_path(Some(vec![
        bin,
        PathBuf::from("/bin"),
        PathBuf::from("/usr/bin"),
    ]));
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project,
    }
}

fn status(f: &Fixture, thread_id: u32) -> ThreadStatus {
    f.core
        .list_threads(f.project.id)
        .unwrap()
        .into_iter()
        .find(|t| t.id == thread_id)
        .unwrap()
        .status
}

fn wait_status(f: &Fixture, thread_id: u32, wanted: ThreadStatus) {
    assert!(
        wait_until(Duration::from_secs(10), || status(f, thread_id) == wanted),
        "status stayed {:?}, wanted {wanted:?}",
        status(f, thread_id)
    );
}

fn screen_has(f: &Fixture, thread_id: u32, needle: &str) {
    let attachment = f.core.attach_agent_terminal(thread_id).unwrap();
    let mut seen = attachment.replay;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        match attachment.feed.recv_timeout(left) {
            Ok(chunk) => seen.extend(chunk),
            Err(_) => panic!("never saw {needle:?}"),
        }
    }
}

/// Types a line and waits until the agent has run it.
fn run(f: &Fixture, thread_id: u32, line: &str, echo: &str) {
    f.core
        .write_agent_terminal(thread_id, format!("{line}\n").as_bytes())
        .unwrap();
    screen_has(f, thread_id, echo);
}

/// A file of the Thread's checkout, which may be a worktree of its own.
fn read(f: &Fixture, thread_id: u32, name: &str) -> Option<String> {
    let checkout = f.core.checkout_path(f.project.id, Some(thread_id)).unwrap();
    std::fs::read_to_string(Path::new(&checkout).join(name)).ok()
}

/// Two Turns; the second one edits more.
fn two_turns(f: &Fixture) -> u32 {
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(f, thread.id, "READY");
    run(f, thread.id, "work", "WORKING");
    wait_status(f, thread.id, ThreadStatus::Working);
    run(f, thread.id, "edit1", "EDITED1");
    run(f, thread.id, "finish", "FINISHED");
    wait_status(f, thread.id, ThreadStatus::Completed);
    run(f, thread.id, "work", "WORKING");
    wait_status(f, thread.id, ThreadStatus::Working);
    run(f, thread.id, "edit2", "EDITED2");
    run(f, thread.id, "finish", "FINISHED");
    wait_status(f, thread.id, ThreadStatus::Completed);
    thread.id
}

#[test]
fn restore_goes_back_to_before_a_chosen_turn_and_undo_reverses_it() {
    let f = fixture(EDITING_AGENT);
    let thread = two_turns(&f);

    let picks = f.core.turn_picks(thread).unwrap();
    assert_eq!(picks.len(), 2);
    assert!(picks.iter().all(|p| p.checkpointed && p.prompt.is_empty()));
    assert!(picks.iter().all(|p| !p.started_at.is_empty()));

    let preview = f.core.restore_preview(thread, 1).unwrap();
    assert_eq!(preview.files.len(), 2);
    f.core.restore_turn(thread, 1).unwrap();
    assert_eq!(read(&f, thread, "a.txt").unwrap(), "changed\n");
    assert_eq!(read(&f, thread, "one.txt").unwrap(), "first\n");
    assert_eq!(read(&f, thread, "two.txt"), None);

    f.core.undo_restore(thread).unwrap();
    assert_eq!(read(&f, thread, "a.txt").unwrap(), "changed again\n");
    assert_eq!(read(&f, thread, "two.txt").unwrap(), "second\n");
}

#[test]
fn the_starting_state_is_always_offered_even_without_turns() {
    let f = fixture(SILENT_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    run(&f, thread.id, "edit1", "EDITED1");

    assert!(f.core.turn_picks(thread.id).unwrap().is_empty());
    assert!(f.core.start_state_available(thread.id));

    // A live agent that reports nothing may be mid-turn: files are not put back under it.
    assert!(f.core.restore_start_preview(thread.id).is_err());
    f.core.stop_agent(thread.id).unwrap();
    wait_status(&f, thread.id, ThreadStatus::Stopped);

    let preview = f.core.restore_start_preview(thread.id).unwrap();
    assert_eq!(preview.files.len(), 2);
    f.core.restore_to_start(thread.id).unwrap();
    assert_eq!(read(&f, thread.id, "a.txt").unwrap(), "committed\n");
    assert_eq!(read(&f, thread.id, "one.txt"), None);

    let pending = f.core.pending_restore(thread.id).unwrap().unwrap();
    assert_eq!(pending.files.len(), 2);
    f.core.undo_restore(thread.id).unwrap();
    assert_eq!(read(&f, thread.id, "a.txt").unwrap(), "changed\n");
    assert_eq!(read(&f, thread.id, "one.txt").unwrap(), "first\n");
}

#[test]
fn restore_is_refused_while_the_thread_is_working() {
    let f = fixture(EDITING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    run(&f, thread.id, "work", "WORKING");
    wait_status(&f, thread.id, ThreadStatus::Working);

    assert!(f.core.restore_to_start(thread.id).is_err());
    assert!(f.core.restore_preview(thread.id, 0).is_err());
    assert!(f.core.restore_start_preview(thread.id).is_err());
}
