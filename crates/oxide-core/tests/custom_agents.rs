#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]

mod support;

use crossbeam_channel::Receiver;
use oxide_core::custom_agents::CustomAgent;
use oxide_core::{Core, ProjectSummary, TerminalIssue, TerminalLaunch, ThreadStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use support::wait_until;
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
    assert!(out.status.success(), "git {args:?}");
}

/// A stand-in for an unknown agent CLI: prints where it runs, then echoes what it is typed.
const COMMAND: &str = r#"echo "CWD:$(pwd)"; echo "ARGC:$#"; printf '\033[?2004h'; echo READY; while IFS= read -r line; do echo "ECHO:$line"; done"#;

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
}

fn agent(id: &str, name: &str, command: &str) -> CustomAgent {
    CustomAgent {
        id: id.into(),
        name: name.into(),
        command: command.into(),
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let work: PathBuf = tmp.path().join("scan").join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "committed\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let core = Core::open(tmp.path().join("oxide-home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    let mut settings = core.settings().settings;
    settings.custom_agents = vec![agent("mine", "My agent", COMMAND)];
    core.save_settings(&settings).unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project,
    }
}

fn custom() -> TerminalLaunch {
    TerminalLaunch {
        provider: Some("custom:mine".into()),
        ..Default::default()
    }
}

fn read_until(feed: &Receiver<Vec<u8>>, mut seen: Vec<u8>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        match feed.recv_timeout(left) {
            Ok(chunk) => seen.extend(chunk),
            Err(_) => panic!(
                "never saw {needle:?}; got {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

fn screen(f: &Fixture, thread_id: u32, needle: &str) -> String {
    let attachment = f.core.attach_agent_terminal(thread_id).unwrap();
    read_until(&attachment.feed, attachment.replay, needle)
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

fn issue() -> TerminalIssue {
    TerminalIssue {
        number: 42,
        title: "Crash on save".into(),
        body: "It crashes when saving.".into(),
        url: None,
        labels: vec![],
    }
}

#[test]
fn a_custom_agent_runs_its_command_through_the_shell_in_a_worktree() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &custom())
        .unwrap();
    assert_eq!(thread.provider, "custom:mine");
    let seen = screen(&f, thread.id, "READY");
    assert!(seen.contains("ARGC:0"), "{seen}");
    let cwd = seen.lines().find(|l| l.starts_with("CWD:")).unwrap();
    assert!(cwd.contains("worktrees"), "{cwd}");
}

#[test]
fn it_shows_running_and_never_needs_input_or_completes_without_osc_7501() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &custom())
        .unwrap();
    screen(&f, thread.id, "READY");
    f.core.write_agent_terminal(thread.id, b"hello\r").unwrap();
    screen(&f, thread.id, "ECHO:hello");
    assert_eq!(status(&f, thread.id), ThreadStatus::Running);
}

#[test]
fn an_issue_prompt_is_never_a_launch_argument_and_is_pasted_only_when_delivered() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_from_issue(f.project.id, &issue(), &custom())
        .unwrap();
    let seen = screen(&f, thread.id, "READY");
    assert!(seen.contains("ARGC:0"), "{seen}");
    assert!(!seen.contains("GitHub issue"), "{seen}");
    let prompt = f.core.issue_prompt_preview(&issue());
    assert!(prompt.contains("#42"));
    f.core.deliver_agent_prompt(thread.id, &prompt).unwrap();
    // The paste carries the bracketed-paste markers and nothing is submitted by Oxide
    // (the Enter-free contract is tested with the paste itself).
    let seen = screen(&f, thread.id, "GitHub issue #42");
    assert!(seen.contains("[200~"), "{seen}");
}

#[test]
fn a_fix_prompt_starts_a_custom_thread_without_any_prompt_argument() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with_fix(f.project.id, &custom(), "Fix the thing", false)
        .unwrap();
    let seen = screen(&f, thread.id, "READY");
    assert!(seen.contains("ARGC:0"), "{seen}");
    assert!(!seen.contains("Fix the thing"), "{seen}");
}

#[test]
fn removing_the_agent_keeps_its_threads_and_offers_no_relaunch() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &custom())
        .unwrap();
    screen(&f, thread.id, "READY");
    f.core.stop_agent(thread.id).unwrap();
    assert!(wait_until(Duration::from_secs(10), || status(
        &f, thread.id
    )
        == ThreadStatus::Stopped));

    let mut settings = f.core.settings().settings;
    settings.custom_agents.clear();
    f.core.save_settings(&settings).unwrap();

    let listed = f.core.list_threads(f.project.id).unwrap();
    assert!(listed.iter().any(|t| t.id == thread.id));
    let error = f.core.restart_agent(thread.id).unwrap_err();
    assert!(error.to_string().contains("removed"), "{error}");
    f.core.open_agent(thread.id).unwrap();
    assert!(!f.core.agent_is_running(thread.id));
    assert_eq!(status(&f, thread.id), ThreadStatus::Stopped);
}

#[test]
fn opening_a_stopped_custom_thread_does_not_relaunch_it_but_restart_does() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &custom())
        .unwrap();
    screen(&f, thread.id, "READY");
    f.core.stop_agent(thread.id).unwrap();
    assert!(wait_until(Duration::from_secs(10), || status(
        &f, thread.id
    )
        == ThreadStatus::Stopped));
    f.core.open_agent(thread.id).unwrap();
    assert!(!f.core.agent_is_running(thread.id));
    f.core.restart_agent(thread.id).unwrap();
    screen(&f, thread.id, "READY");
    assert!(f.core.agent_is_running(thread.id));
}

#[test]
fn an_unknown_custom_agent_is_refused_before_anything_is_created() {
    let f = fixture();
    for provider in ["custom:nope", "custom:", "custom:MINE", "custom:../x"] {
        let error = f
            .core
            .start_terminal_thread_with(
                f.project.id,
                &TerminalLaunch {
                    provider: Some(provider.into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("Custom agent"), "{error}");
    }
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn saving_refuses_a_bad_name_or_command_and_keeps_the_settings_in_effect() {
    let f = fixture();
    for (name, command) in [
        ("", "run"),
        ("Bad;name", "run"),
        ("Agent", ""),
        ("Agent", "run\nrm -rf ~"),
        ("Agent", &"x".repeat(1000)),
    ] {
        let mut settings = f.core.settings().settings;
        settings.custom_agents = vec![agent("a", name, command)];
        assert!(
            f.core.save_settings(&settings).is_err(),
            "{name:?} {command:?}"
        );
    }
    assert_eq!(f.core.settings().settings.custom_agents.len(), 1);
}

#[test]
fn a_hand_edited_settings_file_with_a_bad_agent_reports_it_and_launches_nothing() {
    let f = fixture();
    let home = f._tmp.path().join("oxide-home");
    let path = home.join("settings.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    value["customAgents"] =
        serde_json::json!([{"id": "mine", "name": "Mine", "command": "run\nsecond"}]);
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    assert!(wait_until(Duration::from_secs(10), || {
        f.core
            .settings()
            .errors
            .iter()
            .any(|e| e.path == "customAgents.0.command")
    }));
}

#[test]
fn a_prompt_is_not_pasted_into_an_agent_that_never_turned_on_bracketed_paste() {
    let f = fixture();
    let mut settings = f.core.settings().settings;
    settings.custom_agents.push(agent(
        "plain",
        "Plain",
        r#"echo READY; while IFS= read -r line; do echo "ECHO:$line"; done"#,
    ));
    f.core.save_settings(&settings).unwrap();
    let thread = f
        .core
        .start_terminal_thread_with(
            f.project.id,
            &TerminalLaunch {
                provider: Some("custom:plain".into()),
                ..Default::default()
            },
        )
        .unwrap();
    screen(&f, thread.id, "READY");

    let refused = f
        .core
        .deliver_agent_prompt(thread.id, "line one\nline two")
        .unwrap_err();

    assert!(refused.to_string().contains("bracketed paste"), "{refused}");
    // The newline never reached the agent as an Enter.
    f.core.write_agent_terminal(thread.id, b"ping\r").unwrap();
    let seen = screen(&f, thread.id, "ECHO:ping");
    assert!(!seen.contains("ECHO:line"), "{seen}");
}

#[test]
fn an_oversized_prompt_is_refused_before_it_is_built() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &custom())
        .unwrap();
    screen(&f, thread.id, "READY");
    let huge = "x".repeat(2 * 1024 * 1024);
    assert!(f.core.deliver_agent_prompt(thread.id, &huge).is_err());
}
