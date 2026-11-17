#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]
//! Codex in a Terminal Thread (ADR-0017): launch flags, status from OSC 7501 without a query,
//! the session id learned by the reporter, resume, and the user's own `notify`. No real Codex runs.

mod support;

use oxide_core::agent_reporter::run_reporter;
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

/// A stand-in for Codex: reports how it was started and the reporter's environment, reports
/// status the way Codex does (no query first) and echoes what it is typed.
const FAKE_CODEX: &str = r#"#!/bin/sh
case "$1" in
  resume)
    if [ -f gone ]; then echo "ERROR: No saved session found with ID $(eval echo \${$#})"; exit 1; fi;;
esac
echo "ARGS:$*"
echo "SOCK:$OXIDE_REPORTER_SOCKET"
echo "TOKEN:$OXIDE_REPORTER_TOKEN"
echo "READY"
while IFS= read -r line; do
  case "$line" in
    work) printf '\033]7501;state=working:app=codex\033\\'; echo WORKING ;;
    ask) printf '\033]7501;state=blocked:kind=permission:app=codex\033\\'; echo ASKING ;;
    finish) printf '\033]7501;state=done:app=codex\033\\'; echo FINISHED ;;
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
    let codex = bin.join("codex");
    std::fs::write(&codex, FAKE_CODEX).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
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
        provider: Some("codex".into()),
        model: Some("gpt-5.5".into()),
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

/// What the fake Codex would run as `notify` after a Turn: the `notify` override it was
/// launched with, and the reporter environment it was given.
struct Notify {
    args: Vec<String>,
    socket: String,
    token: String,
}

fn notify_of(screen: &str) -> Notify {
    let args_line = line(screen, "ARGS:");
    let array = args_line
        .split("notify=")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    let args: Vec<String> = serde_json::from_str(&format!("{array}]")).unwrap();
    Notify {
        args,
        socket: line(screen, "SOCK:").to_string(),
        token: line(screen, "TOKEN:").to_string(),
    }
}

/// Plays Codex ending a Turn: runs the reporter with the notify array and Codex's payload.
fn end_turn(notify: &Notify, session: &str) -> i32 {
    let mut args: Vec<String> = notify.args[2..].to_vec();
    args.push(format!(
        r#"{{"type":"agent-turn-complete","thread-id":"{session}","turn-id":"t","cwd":"/x","input-messages":[],"last-assistant-message":"ok"}}"#
    ));
    let (socket, token) = (notify.socket.clone(), notify.token.clone());
    run_reporter(&args, &move |name| match name {
        "OXIDE_REPORTER_SOCKET" => Some(socket.clone()),
        "OXIDE_REPORTER_TOKEN" => Some(token.clone()),
        _ => None,
    })
}

#[test]
fn a_codex_thread_launches_in_its_worktree_with_the_chosen_model_and_permission_mode() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::AutoEdit)))
        .unwrap();

    assert_eq!(thread.provider, "codex");
    assert!(thread.terminal);
    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(args.contains("--no-daemon"), "{args}");
    assert!(args.contains("-m gpt-5.5"), "{args}");
    assert!(args.contains("model_reasoning_effort=\"high\""), "{args}");
    assert!(args.contains("-s workspace-write -a on-request"), "{args}");
    assert!(!args.contains("dangerously"), "{args}");
    assert!(!args.contains("hook-trust"), "{args}");
    assert_eq!(stored_session(&f.home, thread.id), None);
}

#[test]
fn full_access_bypasses_approvals_and_the_sandbox_and_ask_is_refused() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::FullAccess)))
        .unwrap();
    let out = screen(&f.core, thread.id, "READY");
    let args = line(&out, "ARGS:");
    assert!(
        args.contains("--dangerously-bypass-approvals-and-sandbox"),
        "{args}"
    );
    assert!(!args.contains("workspace-write"), "{args}");

    let before = f.core.list_threads(f.project.id).unwrap().len();
    let error = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::Ask)))
        .unwrap_err();
    assert!(error.to_string().contains("Ask"), "{error}");
    assert_eq!(f.core.list_threads(f.project.id).unwrap().len(), before);
}

#[test]
fn a_settings_default_of_ask_becomes_auto_edit_for_codex() {
    let f = fixture();
    let mut settings = f.core.settings().settings;
    settings.providers.codex.permission_mode = PermissionMode::Ask;
    f.core.save_settings(&settings).unwrap();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let out = screen(&f.core, thread.id, "READY");
    assert!(line(&out, "ARGS:").contains("-s workspace-write -a on-request"));
}

#[test]
fn codex_status_comes_from_osc_7501_without_a_query() {
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
fn the_reporter_teaches_oxide_the_session_id_and_it_is_never_replaced() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let notify = notify_of(&screen(&f.core, thread.id, "READY"));
    assert_eq!(notify.args[0], "/opt/oxide/oxide");
    assert_eq!(notify.args[1], "--oxide-reporter");
    assert_eq!(notify.args[2], "0");
    assert_eq!(
        Path::new(&notify.socket),
        f.core.reporter_socket().unwrap().as_path()
    );

    assert_eq!(end_turn(&notify, SESSION), 0);

    assert!(
        wait_until(Duration::from_secs(10), || stored_session(
            &f.home, thread.id
        )
        .as_deref()
            == Some(SESSION)),
        "the session id was not stored"
    );
    end_turn(&notify, OTHER_SESSION);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
}

#[test]
fn a_report_with_another_launchs_token_is_refused() {
    let f = fixture();
    let a = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let b = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let mut notify = notify_of(&screen(&f.core, a.id, "READY"));
    let other = notify_of(&screen(&f.core, b.id, "READY"));
    assert_ne!(notify.token, other.token);
    notify.token = "0".repeat(64);
    end_turn(&notify, SESSION);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stored_session(&f.home, a.id), None);
    assert_eq!(stored_session(&f.home, b.id), None);
}

#[test]
fn the_users_own_notify_still_runs_and_codexs_config_is_never_written() {
    let f = fixture();
    let codex_home = f.user_home.join(".codex");
    std::fs::create_dir_all(&codex_home).unwrap();
    let hook = f.tmp.path().join("hook.sh");
    let marker = f.tmp.path().join("hook-ran");
    std::fs::write(&hook, "#!/bin/sh\nprintf '%s' \"$2\" > \"$1\"\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let config = format!("model = \"x\"\nnotify = [{:?}]\n", hook.to_string_lossy());
    std::fs::write(codex_home.join("config.toml"), &config).unwrap();
    let before = std::fs::metadata(codex_home.join("config.toml"))
        .unwrap()
        .modified()
        .unwrap();

    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let mut notify = notify_of(&screen(&f.core, thread.id, "READY"));
    assert_eq!(notify.args[2], "1");
    assert_eq!(notify.args[3], hook.to_string_lossy());
    // The test passes the marker as the hook's own argument, as a user's command may have some.
    notify.args[2] = "2".into();
    notify.args.insert(4, marker.to_string_lossy().into_owned());
    end_turn(&notify, SESSION);

    let ran = std::fs::read_to_string(&marker).unwrap();
    assert!(ran.contains("agent-turn-complete"), "{ran}");
    assert_eq!(
        std::fs::read_to_string(codex_home.join("config.toml")).unwrap(),
        config
    );
    assert_eq!(
        std::fs::metadata(codex_home.join("config.toml"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    let entries: Vec<_> = std::fs::read_dir(&codex_home).unwrap().collect();
    assert_eq!(entries.len(), 1, "Oxide wrote into Codex's home");
}

#[test]
fn after_a_relaunch_the_thread_resumes_the_same_codex_session() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(Some(PermissionMode::AutoEdit)))
        .unwrap();
    let notify = notify_of(&screen(&f.core, thread.id, "READY"));
    end_turn(&notify, SESSION);
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
    assert!(args.starts_with("resume "), "{args}");
    assert!(args.ends_with(SESSION), "{args}");
    assert!(args.contains("-s workspace-write"), "{args}");
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
}

#[test]
fn a_thread_that_never_finished_a_turn_starts_a_new_session_when_reopened() {
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
    assert!(!line(&out, "ARGS:").starts_with("resume"), "{out}");
}

#[test]
fn a_codex_session_that_is_gone_offers_a_fresh_one_in_the_same_checkout() {
    let f = fixture();
    let thread = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap();
    let notify = notify_of(&screen(&f.core, thread.id, "READY"));
    end_turn(&notify, SESSION);
    assert!(wait_until(Duration::from_secs(10), || stored_session(
        &f.home, thread.id
    )
    .is_some()));
    f.core.stop_agent(thread.id).unwrap();
    wait_status(&f, thread.id, ThreadStatus::Stopped);
    let worktree = thread.worktree_path.clone().unwrap();
    std::fs::write(Path::new(&worktree).join("gone"), "").unwrap();

    f.core.restart_agent(thread.id).unwrap();

    wait_status(&f, thread.id, ThreadStatus::Error);
    assert!(
        wait_until(Duration::from_secs(10), || f
            .core
            .agent_session_gone(thread.id)
            .unwrap()),
        "the missing session was not noticed"
    );
    assert_eq!(stored_session(&f.home, thread.id).as_deref(), Some(SESSION));
    std::fs::remove_file(Path::new(&worktree).join("gone")).unwrap();

    f.core.start_fresh_agent_session(thread.id).unwrap();

    let out = screen(&f.core, thread.id, "READY");
    assert!(!line(&out, "ARGS:").starts_with("resume"), "{out}");
    assert_eq!(stored_session(&f.home, thread.id), None);
}

#[test]
fn a_codex_thread_that_is_not_installed_is_refused_before_anything_is_created() {
    let f = fixture();
    std::fs::remove_file(f.tmp.path().join("bin").join("codex")).unwrap();
    let error = f
        .core
        .start_terminal_thread_with(f.project.id, &choice(None))
        .unwrap_err();
    assert!(error.to_string().contains("Codex"), "{error}");
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn the_codex_first_prompt_is_a_launch_argument_after_a_double_dash() {
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
    assert!(args.contains(" -- "), "{args}");
}
