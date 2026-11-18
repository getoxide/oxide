#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]

mod support;

use oxide_core::{BoardEvent, Core, ProjectSummary, ThreadStatus};
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
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The answer Oxide must give to the OSC 7501 feature query.
const REPLY_LEN: usize = 80;

/// A stand-in for Claude Code that asks the feature query, shows the answer it got, then
/// reports the state it is told to: `work`, `ask`, `finish`, `fail`, `burst`.
const REPORTING_AGENT: &str = r#"#!/bin/sh
printf '\033]7501;?\033\\'
stty -icanon -echo min 1
reply=$(dd bs=1 count=80 2>/dev/null | cat -v)
echo "REPLY:$reply"
printf '\033[?2004h'
echo READY
while IFS= read -r line; do
  case "$line" in
    work) printf '\033]7501;state=working:app=claude\033\\'; echo WORKING ;;
    ask) printf '\033]7501;state=blocked:kind=permission:app=claude\033\\'; echo ASKING ;;
    finish) printf '\033]7501;state=done:app=claude\033\\'; echo FINISHED ;;
    fail) printf '\033]7501;state=error:app=claude\033\\'; echo FAILED ;;
    burst) printf '\033]7501;state=working\033\\\033]7501;state=blocked\033\\\033]7501;state=working\033\\\033]7501;state=blocked\033\\\033]7501;state=working\033\\\033]7501;state=done\033\\'; echo BURST ;;
    bad) printf '\033]7501;state=exploding\033\\\033]7501;garbage\007'; echo BAD ;;
    quit) exit 0 ;;
  esac
done
"#;

/// Prints ordinary lines and never reports anything.
const SILENT_AGENT: &str = r#"#!/bin/sh
printf '\033[?2004h'
echo READY
while IFS= read -r line; do
  echo "ECHO:$line"
done
"#;

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    work: PathBuf,
    home: PathBuf,
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
        work,
        home,
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

fn screen_has(f: &Fixture, thread_id: u32, needle: &str) -> String {
    let attachment = f.core.attach_agent_terminal(thread_id).unwrap();
    let mut seen = attachment.replay;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        match attachment.feed.recv_timeout(left) {
            Ok(chunk) => seen.extend(chunk),
            Err(_) => panic!(
                "never saw {needle:?}; got {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

fn turns(f: &Fixture, thread_id: u32) -> Vec<(u32, String, bool, String)> {
    let db = rusqlite::Connection::open(f.home.join("oxide.db")).unwrap();
    let mut stmt = db
        .prepare("SELECT turn_index, status, completed_at IS NOT NULL, prompt FROM turns WHERE thread_id = ?1 ORDER BY turn_index")
        .unwrap();
    stmt.query_map([thread_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

fn checkpoints(f: &Fixture, thread_id: u32) -> Vec<String> {
    git(
        &f.work,
        &[
            "for-each-ref",
            "--format=%(refname)",
            &format!("refs/oxide/checkpoints/{thread_id}/"),
        ],
    )
    .lines()
    .map(|l| {
        l.trim_start_matches(&format!("refs/oxide/checkpoints/{thread_id}/"))
            .to_string()
    })
    .collect()
}

fn type_into(f: &Fixture, thread_id: u32, line: &str) {
    f.core
        .write_agent_terminal(thread_id, format!("{line}\n").as_bytes())
        .unwrap();
}

#[test]
fn the_feature_query_is_answered_so_the_provider_starts_reporting() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();

    let out = screen_has(&f, thread.id, "READY");

    assert!(
        out.contains("REPLY:^[]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth^[\\"),
        "{out}"
    );
    // The reply is exactly what the fake agent waited for.
    assert_eq!(
        "\u{1b}]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\u{1b}\\"
            .len(),
        REPLY_LEN
    );
}

#[test]
fn the_sidebar_status_follows_working_blocked_and_done_and_each_turn_is_recorded() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    assert_eq!(status(&f, thread.id), ThreadStatus::Running);
    assert_eq!(turns(&f, thread.id), []);
    assert_eq!(checkpoints(&f, thread.id), ["thread-start"]);

    type_into(&f, thread.id, "work");
    wait_status(&f, thread.id, ThreadStatus::Working);
    assert_eq!(turns(&f, thread.id).len(), 1);
    assert!(!turns(&f, thread.id)[0].2, "the Turn is still running");

    type_into(&f, thread.id, "ask");
    wait_status(&f, thread.id, ThreadStatus::NeedsInput);
    assert_eq!(turns(&f, thread.id).len(), 1, "an Approval is no new Turn");

    type_into(&f, thread.id, "work");
    wait_status(&f, thread.id, ThreadStatus::Working);
    type_into(&f, thread.id, "finish");
    wait_status(&f, thread.id, ThreadStatus::Completed);

    // Oxide records a Turn's start and end only, never what was asked.
    assert_eq!(
        turns(&f, thread.id),
        [(0, "completed".to_string(), true, String::new())]
    );
    let mut refs = checkpoints(&f, thread.id);
    refs.sort();
    assert_eq!(refs, ["0/end", "0/start", "thread-start"]);

    type_into(&f, thread.id, "work");
    type_into(&f, thread.id, "fail");
    wait_status(&f, thread.id, ThreadStatus::Error);
    let recorded = turns(&f, thread.id);
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[1].0, 1);
    assert_eq!(recorded[1].1, "error");
    assert!(recorded[1].2);
}

#[test]
fn a_blocked_thread_is_the_one_the_waiting_shortcut_goes_to() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");

    type_into(&f, thread.id, "ask");

    wait_status(&f, thread.id, ThreadStatus::NeedsInput);
    let (cards, _) = f.core.subscribe_board(f.project.id).unwrap();
    let waiting: Vec<_> = cards
        .iter()
        .filter(|c| c.thread.status == ThreadStatus::NeedsInput)
        .map(|c| c.thread.id)
        .collect();
    assert_eq!(waiting, [thread.id]);
}

#[test]
fn rapid_reports_do_not_flicker_the_sidebar() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    let (_, events) = f.core.subscribe_board(f.project.id).unwrap();

    type_into(&f, thread.id, "burst");

    wait_status(&f, thread.id, ThreadStatus::Completed);
    std::thread::sleep(Duration::from_millis(700));
    let seen: Vec<ThreadStatus> = events
        .try_iter()
        .filter_map(|e| match e {
            BoardEvent::ThreadChanged(card) => Some(card.thread.status),
            BoardEvent::ThreadDeleted(_) => None,
        })
        .collect();
    // Six reports in a blink publish a first status at once and the last one after it.
    assert!(seen.len() <= 2, "{seen:?}");
    assert_eq!(seen.last(), Some(&ThreadStatus::Completed));
}

#[test]
fn malformed_reports_change_nothing() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");

    type_into(&f, thread.id, "bad");

    screen_has(&f, thread.id, "BAD");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(status(&f, thread.id), ThreadStatus::Running);
    assert_eq!(turns(&f, thread.id), []);
}

#[test]
fn an_agent_that_reports_nothing_stays_running_and_makes_no_turns() {
    let f = fixture(SILENT_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");

    type_into(&f, thread.id, "hello");

    screen_has(&f, thread.id, "ECHO:hello");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(status(&f, thread.id), ThreadStatus::Running);
    assert_eq!(turns(&f, thread.id), []);
    // Its start is still a point Restore can go back to.
    assert_eq!(checkpoints(&f, thread.id), ["thread-start"]);
}

#[test]
fn an_agent_that_ends_during_a_turn_closes_the_turn_and_shows_stopped() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    type_into(&f, thread.id, "work");
    wait_status(&f, thread.id, ThreadStatus::Working);

    type_into(&f, thread.id, "quit");

    wait_status(&f, thread.id, ThreadStatus::Stopped);
    let recorded = turns(&f, thread.id);
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].1, "interrupted");
    assert!(recorded[0].2);
}

#[test]
fn a_restarted_agent_continues_the_turn_numbering() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    type_into(&f, thread.id, "work");
    type_into(&f, thread.id, "finish");
    wait_status(&f, thread.id, ThreadStatus::Completed);
    f.core.stop_agent(thread.id).unwrap();
    wait_status(&f, thread.id, ThreadStatus::Stopped);

    f.core.restart_agent(thread.id).unwrap();
    screen_has(&f, thread.id, "READY");
    type_into(&f, thread.id, "work");
    wait_status(&f, thread.id, ThreadStatus::Working);

    let indexes: Vec<u32> = turns(&f, thread.id).iter().map(|t| t.0).collect();
    assert_eq!(indexes, [0, 1]);
    // Resuming is not a new start of the Thread.
    assert_eq!(
        checkpoints(&f, thread.id)
            .iter()
            .filter(|r| *r == "thread-start")
            .count(),
        1
    );
}

#[test]
fn a_thread_that_last_reported_working_or_completed_reopens_as_stopped_not_interrupted() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");
    type_into(&f, thread.id, "work");
    wait_status(&f, thread.id, ThreadStatus::Working);
    f.core.shutdown();
    let Fixture {
        core,
        home,
        project,
        ..
    } = f;
    drop(core);
    // Whatever it last reported, the agent is gone.
    rusqlite::Connection::open(home.join("oxide.db"))
        .unwrap()
        .execute(
            "UPDATE threads SET status = 'working' WHERE id = ?1",
            [thread.id],
        )
        .unwrap();

    let core = Core::open(&home).unwrap();
    let again = core
        .list_threads(project.id)
        .unwrap()
        .into_iter()
        .find(|t| t.id == thread.id)
        .unwrap();
    assert_eq!(again.status, ThreadStatus::Stopped);
}

#[test]
fn delivery_is_refused_while_the_agent_waits_for_an_answer_and_allowed_after() {
    let f = fixture(REPORTING_AGENT);
    let thread = f.core.start_terminal_thread(f.project.id).unwrap();
    screen_has(&f, thread.id, "READY");

    type_into(&f, thread.id, "ask");
    wait_status(&f, thread.id, ThreadStatus::NeedsInput);

    let refused = f
        .core
        .deliver_agent_prompt(thread.id, "Fix the failing check")
        .unwrap_err();
    assert!(
        refused.to_string().contains("waiting for an answer"),
        "{refused}"
    );

    type_into(&f, thread.id, "finish");
    wait_status(&f, thread.id, ThreadStatus::Completed);
    f.core
        .deliver_agent_prompt(thread.id, "Fix the failing check")
        .unwrap();
}
