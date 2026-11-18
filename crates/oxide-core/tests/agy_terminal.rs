#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]
//! Antigravity CLI (`agy`) in a Terminal Thread (ADR-0017): launch flags, status from OSC 7501,
//! the conversation id learned by the per-launch status line command, the user's own status line,
//! resume and the fresh-session offer. No real `agy` runs.

mod support;

use oxide_core::agent_reporter::run_status_line;
use oxide_core::{Core, PermissionMode, ProjectSummary, TerminalLaunch, ThreadStatus};
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

const SESSION: &str = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_SESSION: &str = "223e4567-e89b-42d3-a456-426614174999";

/// A stand-in for `agy`: reports how it was started, the `--settings` it was given and the
/// reporter's environment, reports status over OSC 7501 and echoes what it is typed. Resuming
/// a conversation that is gone prints agy's warning and carries on in a new conversation.
const FAKE_AGY: &str = r#"#!/bin/sh
echo "ARGS:$*"
case "$1" in --settings) printf 'SETTINGS:%s\n' "$2";; esac
echo "SOCK:$OXIDE_REPORTER_SOCKET"
echo "TOKEN:$OXIDE_REPORTER_TOKEN"
if [ -f gone ]; then
  case "$*" in *--conversation*) echo 'warning: conversation "x" not found';; esac
fi
echo "READY"
while IFS= read -r line; do
  case "$line" in
    work) printf '\033]7501;state=working:app=agy\033\\'; echo WORKING ;;
    ask) printf '\033]7501;state=blocked:kind=permission:app=agy\033\\'; echo ASKING ;;
    finish) printf '\033]7501;state=done:app=agy\033\\'; echo FINISHED ;;
    quit) exit 0 ;;
    *) echo "ECHO:$line" ;;
  esac
done
"#;

struct Fixture {
    tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    home: PathBuf,
    user_home: PathBuf,
}

fn open(tmp: &Path, home: &Path, user_home: &Path) -> Core {
    let core = Core::open_with_user_home(home, user_home).unwrap();
    core.set_real_time_ticker(false);
    core.set_agent_search_path(Some(vec![
        tmp.join("bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/bin"),
    ]));
    core.set_reporter_executable(Some(PathBuf::from("/opt/oxide/oxide")));
    core
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("oxide-home");
    let user_home = tmp.path().join("user");
    std::fs::create_dir_all(&user_home).unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let agy = bin.join("agy");
    std::fs::write(&agy, FAKE_AGY).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&agy, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let work = tmp.path().join("scan").join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "committed\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let core = open(tmp.path(), &home, &user_home);
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    Fixture {
        tmp,
        core,
        project,
        home,
        user_home,
    }
}

fn choice(mode: Option<PermissionMode>) -> TerminalLaunch {
    TerminalLaunch {
        provider: Some("antigravity".into()),
        model: Some("gemini-3-pro".into()),
        effort: Some("high".into()),
        permission_mode: mode,
    }
}

fn read_until(
    feed: &crossbeam_channel::Receiver<Vec<u8>>,
    mut seen: Vec<u8>,
    needle: &str,
) -> String {
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

fn screen(core: &Core, thread_id: u32, needle: &str) -> String {
    let attachment = core.attach_agent_terminal(thread_id).unwrap();
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

fn wait_status(f: &Fixture, thread_id: u32, wanted: ThreadStatus) {
    assert!(
        wait_until(Duration::from_secs(10), || status(f, thread_id) == wanted),
        "status stayed {:?}, wanted {wanted:?}",
        status(f, thread_id)
    );
}

fn stored_session(home: &Path, thread_id: u32) -> Option<String> {
    rusqlite::Connection::open(home.join("oxide.db"))
        .unwrap()
        .query_row(
            "SELECT provider_session_id FROM threads WHERE id = ?1",
            [thread_id],
            |r| r.get(0),
        )
        .unwrap()
}

fn line<'a>(screen: &'a str, prefix: &str) -> &'a str {
    screen
        .lines()
        .find_map(|l| l.trim_end().strip_prefix(prefix))
        .unwrap_or_else(|| panic!("no {prefix} line in {screen}"))
}

/// What the fake `agy` was launched with: the status line command of its `--settings` and the
/// reporter environment it was given.
struct StatusLine {
    command: String,
    socket: String,
    token: String,
}

fn status_line_of(screen: &str) -> StatusLine {
    let settings: serde_json::Value = serde_json::from_str(line(screen, "SETTINGS:")).unwrap();
    let status_line = &settings["statusLine"];
    assert_eq!(status_line["type"], "command");
    StatusLine {
        command: status_line["command"].as_str().unwrap().to_string(),
        socket: line(screen, "SOCK:").to_string(),
        token: line(screen, "TOKEN:").to_string(),
    }
}

/// Plays `agy` running its status line command: the reporter with the user's own command (the
/// last word of the launch command, when it has one) and `agy`'s JSON on its input.
fn run_status_line_of(
    status_line: &StatusLine,
    user: Option<&str>,
    session: &str,
) -> (i32, String) {
    let input = format!(r#"{{"conversation_id":"{session}","agent_state":"idle","cwd":"/x"}}"#);
    let (socket, token) = (status_line.socket.clone(), status_line.token.clone());
    let mut out = Vec::new();
    let code = run_status_line(
        user,
        input.as_bytes(),
        &move |name| match name {
            "OXIDE_REPORTER_SOCKET" => Some(socket.clone()),
            "OXIDE_REPORTER_TOKEN" => Some(token.clone()),
            _ => None,
        },
        &mut out,
    );
    (code, String::from_utf8(out).unwrap())
}

#[test]
fn an_agy_thread_launches_in_its_worktree_with_the_chosen_model_and_permission_mode() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::AutoEdit)))
        .unwrap();

    assert_eq!(thread.provider, "antigravity");
    assert!(thread.terminal);
    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(args.contains("--model gemini-3-pro"), "{args}");
    assert!(args.contains("--effort high"), "{args}");
    assert!(args.contains("--mode accept-edits"), "{args}");
    assert!(!args.contains("dangerously"), "{args}");
    assert!(args.starts_with("--settings "), "{args}");
    assert_eq!(stored_session(&f.home, thread.id), None);
    let worktree = thread.worktree_path.unwrap();
    assert!(Path::new(&worktree).join("a.txt").exists());
}

#[test]
fn full_access_skips_permissions_and_ask_is_refused() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::FullAccess)))
        .unwrap();
    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(args.contains("--dangerously-skip-permissions"), "{args}");
    assert!(!args.contains(" --mode "), "{args}");

    let before = f.core.list_threads(f.project.id).unwrap().len();
    let error = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::Ask)))
        .unwrap_err();
    assert!(error.to_string().contains("Ask"), "{error}");
    assert_eq!(f.core.list_threads(f.project.id).unwrap().len(), before);
}

#[test]
fn agy_status_comes_from_osc_7501() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    screen(&f.core, thread.id, "READY");
    for (word, wanted) in [
        ("work", ThreadStatus::Working),
        ("ask", ThreadStatus::NeedsInput),
        ("finish", ThreadStatus::Completed),
    ] {
        f.core
            .write_agent_terminal(thread.id, format!("{word}\n").as_bytes())
            .unwrap();
        wait_status(&f, thread.id, wanted);
    }
}

#[test]
fn the_status_line_teaches_oxide_the_conversation_id_and_it_is_never_replaced() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let status_line = status_line_of(&screen(&f.core, thread.id, "READY"));
    assert_eq!(
        status_line.command,
        "'/opt/oxide/oxide' --oxide-reporter status-line"
    );
    assert_eq!(
        Path::new(&status_line.socket),
        f.core.reporter_socket().unwrap().as_path()
    );

    let (code, shown) = run_status_line_of(&status_line, None, SESSION);
    assert_eq!((code, shown.as_str()), (0, ""));
    assert!(
        wait_until(Duration::from_secs(10), || stored_session(
            &f.home, thread.id
        )
        .as_deref()
            == Some(SESSION)),
        "the conversation id was not stored"
    );
    run_status_line_of(&status_line, None, OTHER_SESSION);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
}

#[test]
fn a_report_with_another_launchs_token_is_refused() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let mut status_line = status_line_of(&screen(&f.core, thread.id, "READY"));
    status_line.token = "0".repeat(64);
    run_status_line_of(&status_line, None, SESSION);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stored_session(&f.home, thread.id), None);
}

#[test]
fn the_users_own_status_line_still_runs_and_agys_settings_are_never_written() {
    let f = fixture();
    let agy_home = f.user_home.join(".gemini").join("antigravity-cli");
    std::fs::create_dir_all(&agy_home).unwrap();
    let settings = r#"{"model":"x","statusLine":{"type":"command","command":"echo mine:$(cat | wc -c | tr -d ' ')","padding":1}}"#;
    std::fs::write(agy_home.join("settings.json"), settings).unwrap();
    let before = std::fs::metadata(agy_home.join("settings.json"))
        .unwrap()
        .modified()
        .unwrap();

    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let out = screen(&f.core, thread.id, "READY");
    let launch: serde_json::Value = serde_json::from_str(line(&out, "SETTINGS:")).unwrap();
    let launch_line = &launch["statusLine"];
    assert_eq!(launch_line["padding"], 1, "the user's options are kept");
    let command = launch_line["command"].as_str().unwrap().to_string();
    assert!(
        command.starts_with("'/opt/oxide/oxide' --oxide-reporter status-line 'echo mine:"),
        "{command}"
    );

    let status_line = status_line_of(&out);
    let (code, shown) = run_status_line_of(
        &status_line,
        Some("echo mine:$(cat | wc -c | tr -d ' ')"),
        SESSION,
    );
    assert_eq!(code, 0);
    assert!(shown.starts_with("mine:"), "{shown}");
    assert!(
        wait_until(Duration::from_secs(10), || stored_session(
            &f.home, thread.id
        )
        .is_some()),
        "the conversation id was not stored"
    );
    assert_eq!(
        std::fs::read_to_string(agy_home.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::metadata(agy_home.join("settings.json"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(std::fs::read_dir(&agy_home).unwrap().count(), 1);
}

#[test]
fn after_a_relaunch_the_thread_resumes_the_same_conversation() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::AutoEdit)))
        .unwrap();
    let status_line = status_line_of(&screen(&f.core, thread.id, "READY"));
    run_status_line_of(&status_line, None, SESSION);
    assert!(wait_until(Duration::from_secs(10), || stored_session(
        &f.home, thread.id
    )
    .is_some()));
    f.core.shutdown();
    let Fixture {
        tmp,
        core,
        project,
        home,
        user_home,
    } = f;
    drop(core);
    let core = open(tmp.path(), &home, &user_home);
    let f = Fixture {
        tmp,
        core,
        project,
        home,
        user_home,
    };

    f.core.open_agent(thread.id).unwrap();

    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(
        args.ends_with(&format!("--conversation {SESSION}")),
        "{args}"
    );
    assert!(args.contains("--mode accept-edits"), "{args}");
    assert!(!args.contains("prompt-interactive"), "{args}");
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
}

#[test]
fn a_thread_that_never_named_a_conversation_starts_a_new_one_when_reopened() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    screen(&f.core, thread.id, "READY");
    f.core.stop_agent(thread.id).unwrap();
    wait_status(&f, thread.id, ThreadStatus::Stopped);

    f.core.restart_agent(thread.id).unwrap();

    let out = screen(&f.core, thread.id, "READY");
    assert!(!line(&out, "ARGS:").contains("--conversation"), "{out}");
}

#[test]
fn a_conversation_that_is_gone_stops_agy_and_offers_a_fresh_one_in_the_same_checkout() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let status_line = status_line_of(&screen(&f.core, thread.id, "READY"));
    run_status_line_of(&status_line, None, SESSION);
    assert!(wait_until(Duration::from_secs(10), || stored_session(
        &f.home, thread.id
    )
    .is_some()));
    f.core.stop_agent(thread.id).unwrap();
    wait_status(&f, thread.id, ThreadStatus::Stopped);
    let worktree = thread.worktree_path.clone().unwrap();
    std::fs::write(Path::new(&worktree).join("gone"), "").unwrap();

    // agy warns and carries on in a new conversation; Oxide ends it so the user decides.
    f.core.restart_agent(thread.id).unwrap();

    assert!(
        wait_until(Duration::from_secs(10), || f
            .core
            .agent_session_gone(thread.id)
            .unwrap()),
        "the missing conversation was not noticed"
    );
    assert!(!f.core.agent_is_running(thread.id));
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
    std::fs::remove_file(Path::new(&worktree).join("gone")).unwrap();

    f.core.start_fresh_agent_session(thread.id).unwrap();

    let out = screen(&f.core, thread.id, "READY");
    assert!(!line(&out, "ARGS:").contains("--conversation"), "{out}");
    assert_eq!(stored_session(&f.home, thread.id), None);
}

#[test]
fn an_agy_that_is_not_installed_is_refused_before_anything_is_created() {
    let f = fixture();
    std::fs::remove_file(f.tmp.path().join("bin").join("agy")).unwrap();
    let error = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap_err();
    assert!(error.to_string().contains("Antigravity"), "{error}");
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn the_agy_first_prompt_is_the_interactive_prompt_option_not_a_positional_argument() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_from_issue(
            f.project.id,
            &oxide_core::TerminalIssue {
                number: 9,
                title: "--yolo".into(),
                body: "text".into(),
                url: None,
                labels: Vec::new(),
            },
            &choice(None),
        )
        .unwrap();
    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(
        args.contains(" --prompt-interactive=Work on GitHub issue #9"),
        "{args}"
    );
    assert!(!args.contains(" -- "), "{args}");
}
