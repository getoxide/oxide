#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::disallowed_methods,
    reason = "integration tests: a failed unwrap or panic is a test failure; fixtures start their own repositories and share state through plain mutexes"
)]
use oxide_core::{
    Core, GithubAvailability, IssueCloseReason, IssueEdit, ProjectSummary, PullRequestInput, System,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

#[path = "../fixtures/gh/install.rs"]
mod fake_gh;

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

fn commit_file(dir: &Path, name: &str, content: &str, message: &str) {
    std::fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", message]);
}

#[derive(Default)]
struct RecordingSystem {
    opened: Mutex<Vec<String>>,
}

impl System for RecordingSystem {
    fn open_url(&self, url: &str) {
        self.opened.lock().unwrap().push(url.to_string());
    }
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    remote: PathBuf,
    work: PathBuf,
    /// The directory holding the fake `gh`, the only entry on its PATH.
    gh_dir: PathBuf,
    system: Arc<RecordingSystem>,
}

impl Fixture {
    fn set_gh(&self, state: &serde_json::Value) {
        std::fs::write(self.gh_dir.join("state.json"), state.to_string()).unwrap();
    }

    /// Every `gh` invocation so far, as its argument list.
    fn gh_calls(&self) -> Vec<Vec<String>> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.gh_dir.join("calls"))
            .map(|dir| dir.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default();
        // Named by time, so by order of invocation.
        files.sort();
        files
            .iter()
            .map(|file| {
                let v: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
                v["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_string())
                    .collect()
            })
            .collect()
    }

    /// The `GIT_CONFIG_*` variables each `gh` invocation ran with.
    fn gh_git_config(&self) -> Vec<std::collections::BTreeMap<String, String>> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.gh_dir.join("calls"))
            .map(|dir| dir.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default();
        files.sort();
        files
            .iter()
            .map(|file| {
                let v: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
                serde_json::from_value(v["git_config"].clone()).unwrap()
            })
            .collect()
    }

    fn create_calls(&self) -> Vec<Vec<String>> {
        self.gh_calls()
            .into_iter()
            .filter(|c| c[..2] == ["pr", "create"])
            .collect()
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let remote = root.join("remote.git");
    let scan = root.join("scan");
    std::fs::create_dir_all(&scan).unwrap();
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let seed = root.join("seed");
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            seed.to_str().unwrap(),
        ],
    );
    git(&seed, &["checkout", "-q", "-b", "main"]);
    commit_file(&seed, "a.txt", "one\n", "Seed");
    git(&seed, &["push", "-q", "-u", "origin", "main"]);
    let work = scan.join("work");
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );
    git(&work, &["config", "user.name", "T"]);
    git(&work, &["config", "user.email", "t@example.com"]);

    let gh_dir = root.join("bin");
    std::fs::create_dir_all(&gh_dir).unwrap();

    let core = Core::open(root.join("home")).unwrap();
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    let system = Arc::new(RecordingSystem::default());
    core.set_system(system.clone());
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    Fixture {
        _tmp: tmp,
        core,
        project,
        remote,
        work,
        gh_dir,
        system,
    }
}

fn install_gh(f: &Fixture, state: &serde_json::Value) {
    fake_gh::install(&f.gh_dir, state);
}

fn ok_state() -> serde_json::Value {
    serde_json::json!({"auth": "ok", "default_branch": "main", "next_number": 7, "prs": {}})
}

fn input(title: &str, base: &str, draft: bool) -> PullRequestInput {
    input_from("feature", title, base, draft)
}

fn input_from(head: &str, title: &str, base: &str, draft: bool) -> PullRequestInput {
    PullRequestInput {
        title: title.into(),
        body: "Body".into(),
        base: base.into(),
        head: head.into(),
        draft,
    }
}

/// Commits on `branch` (created from the checked-out commit when new) at a fixed commit
/// time, then returns to the branch checked out before.
fn commit_on(dir: &Path, branch: &str, name: &str, message: &str, epoch: u64) {
    let back = git(dir, &["branch", "--show-current"]).trim().to_string();
    if git(dir, &["branch", "--list", branch]).trim().is_empty() {
        git(dir, &["checkout", "-q", "-b", branch]);
    } else {
        git(dir, &["checkout", "-q", branch]);
    }
    std::fs::write(dir.join(name), message).unwrap();
    git(dir, &["add", name]);
    let date = format!("@{epoch} +0000");
    let out = Command::new("git")
        .args(["commit", "-qm", message])
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    git(dir, &["checkout", "-q", &back]);
}

#[test]
fn pr_base_branches_come_from_github_and_request_all_pages() {
    let f = fixture();
    git(&f.work, &["checkout", "-q", "-b", "local-only"]);
    let mut state = ok_state();
    state["branches"] = serde_json::json!(["release/next", "main", "develop", "main"]);
    install_gh(&f, &state);
    assert_eq!(
        f.core.pull_request_base_branches(f.project.id).unwrap(),
        vec!["develop", "main", "release/next"]
    );
    assert!(f.gh_calls().iter().any(|call| call
        == &[
            "api",
            "repos/{owner}/{repo}/branches?per_page=100",
            "--paginate",
            "--jq",
            ".[].name"
        ]));
}

#[test]
fn gh_runs_with_the_git_hardening_in_its_environment() {
    let f = fixture();
    install_gh(&f, &ok_state());
    f.core.pull_request_base_branches(f.project.id).unwrap();

    let calls = f.gh_git_config();
    assert!(!calls.is_empty());
    for config in calls {
        assert_eq!(config["GIT_CONFIG_COUNT"], "3");
        assert_eq!(config["GIT_CONFIG_KEY_0"], "core.fsmonitor");
        assert_eq!(config["GIT_CONFIG_VALUE_0"], "false");
        assert_eq!(config["GIT_CONFIG_KEY_1"], "core.untrackedCache");
        assert_eq!(config["GIT_CONFIG_VALUE_1"], "false");
        assert_eq!(config["GIT_CONFIG_KEY_2"], "protocol.ext.allow");
        assert_eq!(config["GIT_CONFIG_VALUE_2"], "never");
    }
}

#[test]
fn pr_base_branch_errors_are_not_reported_as_an_empty_list() {
    let f = fixture();
    let mut state = ok_state();
    state["branches_error"] = serde_json::json!("HTTP 403: Resource not accessible");
    install_gh(&f, &state);
    assert!(
        f.core
            .pull_request_base_branches(f.project.id)
            .unwrap_err()
            .to_string()
            .contains("403")
    );
}

#[test]
fn gh_errors_do_not_show_credentials_embedded_in_a_url() {
    let f = fixture();
    let mut state = ok_state();
    state["branches_error"] =
        serde_json::json!("fatal: unable to access 'https://user:synthetic-secret@host/r.git/'");
    install_gh(&f, &state);
    let message = f
        .core
        .pull_request_base_branches(f.project.id)
        .unwrap_err()
        .to_string();
    assert!(message.contains("https://host/r.git"), "{message}");
    assert!(!message.contains("synthetic-secret"), "{message}");
}

#[test]
fn missing_gh_is_reported_with_install_guidance_and_git_still_works() {
    let f = fixture(); // nothing on the PATH
    let state = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::Missing);
    assert!(state.guidance.unwrap().contains("Install"));
    assert_eq!(
        git(&f.work, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "main"
    );
}

#[test]
fn logged_out_gh_is_reported_with_login_guidance_and_git_still_works() {
    let f = fixture();
    install_gh(&f, &serde_json::json!({"auth": "logged_out"}));
    let state = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::LoggedOut);
    assert!(state.guidance.unwrap().contains("gh auth login"));
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    assert_eq!(
        git(&f.work, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "feature"
    );
}

#[cfg(windows)]
#[test]
fn gh_is_available_through_a_bat_shim() {
    let f = fixture();
    install_gh(&f, &ok_state());
    std::fs::rename(f.gh_dir.join("gh.cmd"), f.gh_dir.join("gh.bat")).unwrap();
    let state = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::Ready);
    assert_eq!(
        f.core.pull_request_draft(f.project.id, None).unwrap().base,
        "main"
    );
}

#[cfg(windows)]
#[test]
fn gh_uses_pathext_order_when_multiple_shims_are_installed() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let first = extensions
        .split(';')
        .find(|e| e.eq_ignore_ascii_case(".BAT") || e.eq_ignore_ascii_case(".CMD"))
        .unwrap();
    let other = if first.eq_ignore_ascii_case(".BAT") {
        "cmd"
    } else {
        "bat"
    };
    if other != "cmd" {
        std::fs::copy(
            f.gh_dir.join("gh.cmd"),
            f.gh_dir.join(format!("gh.{other}")),
        )
        .unwrap();
    }
    std::fs::write(
        f.gh_dir.join(format!("gh{first}")),
        "@echo off\r\nexit /b 1\r\n",
    )
    .unwrap();
    assert_eq!(
        f.core.issues_state(f.project.id).unwrap().availability,
        GithubAvailability::LoggedOut
    );
}

#[test]
fn reloading_the_surface_reuses_auth_status_and_default_branch() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    f.core.pull_request_draft(f.project.id, None).unwrap();
    f.core.list_pull_requests(f.project.id, false, "").unwrap();
    let before = f.gh_calls().len();

    f.core.pull_request_draft(f.project.id, None).unwrap();
    f.core.list_pull_requests(f.project.id, false, "").unwrap();

    let again: Vec<_> = f.gh_calls()[before..]
        .iter()
        .map(|c| c[..2].join(" "))
        .collect();
    assert_eq!(
        again,
        ["pr list"],
        "auth status and the default branch are reused"
    );
}

fn auth_checks(f: &Fixture) -> usize {
    f.gh_calls()
        .iter()
        .filter(|c| c[..2] == ["auth", "status"])
        .count()
}

/// Asks for the Issues state from several threads at once, as startup preloading does.
fn issues_state_at_once(f: &Fixture) -> Vec<GithubAvailability> {
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    f.core.issues_state(f.project.id).unwrap().availability
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

#[test]
fn concurrent_cold_starts_share_one_auth_check() {
    let f = fixture();
    install_gh(&f, &ok_state());
    assert_eq!(
        issues_state_at_once(&f),
        [GithubAvailability::Ready; 3].to_vec()
    );
    assert_eq!(auth_checks(&f), 1);
}

#[test]
fn concurrent_checks_of_a_logged_out_gh_share_one_call_but_a_later_ask_checks_again() {
    let f = fixture();
    install_gh(&f, &serde_json::json!({"auth": "logged_out"}));
    assert_eq!(
        issues_state_at_once(&f),
        [GithubAvailability::LoggedOut; 3].to_vec()
    );
    assert_eq!(auth_checks(&f), 1);

    // Logging in afterwards is noticed: a failed check is never cached.
    f.set_gh(&ok_state());
    assert_eq!(
        f.core.issues_state(f.project.id).unwrap().availability,
        GithubAvailability::Ready
    );
    assert_eq!(auth_checks(&f), 2);
}

#[test]
fn a_hung_auth_check_does_not_hold_up_changing_where_gh_is_found() {
    let f = fixture();
    // The old check hangs far longer than the bound below, so a slow runner (Windows CI spawns
    // gh through a .cmd shim and Python) still tells "did not wait" from "waited".
    let hang = std::time::Duration::from_secs(10);
    let bound = hang / 2;
    let mut state = ok_state();
    state["auth_delay"] = hang.as_secs().into();
    install_gh(&f, &state);
    std::thread::scope(|scope| {
        let slow = scope.spawn(|| f.core.issues_state(f.project.id).unwrap().availability);
        while auth_checks(&f) == 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        f.set_gh(&ok_state());

        let started = std::time::Instant::now();
        f.core.set_gh_search_path(Some(vec![f.gh_dir.clone()]));
        assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        // A check asked after the change runs on its own instead of queueing behind the old one.
        assert_eq!(
            f.core.issues_state(f.project.id).unwrap().availability,
            GithubAvailability::Ready
        );
        assert!(started.elapsed() < bound, "{:?}", started.elapsed());
        assert_eq!(slow.join().unwrap(), GithubAvailability::Ready);
    });
}

#[test]
fn reloading_a_pull_request_reuses_the_repository_and_viewer_metadata() {
    let f = fixture();
    install_gh(&f, &state_with_prs(&[detailed_pr()]));
    f.core.pull_request_detail(f.project.id, 5).unwrap();
    let before = f.gh_calls().len();

    let again = f.core.pull_request_detail(f.project.id, 5).unwrap();

    assert_eq!(again.viewer, "me");
    let calls = &f.gh_calls()[before..];
    let kinds: Vec<String> = calls
        .iter()
        .map(|c| {
            if c.iter().any(|a| a.contains("viewerDefaultMergeMethod")) {
                "default merge method".to_string()
            } else if c.iter().any(|a| a.contains("isRequired")) {
                "required checks".to_string()
            } else if c.iter().any(|a| a.contains("timelineItems")) {
                "timeline".to_string()
            } else {
                c[..2].join(" ")
            }
        })
        .collect();
    let mut kinds = kinds;
    kinds.sort();
    assert_eq!(
        kinds,
        ["pr view", "required checks", "timeline"],
        "merge settings, the viewer's login and default merge method are reused"
    );
}

#[test]
fn each_project_reads_its_own_viewer_login() {
    let f = fixture();
    let other_work = f.work.with_file_name("other");
    git(
        f.work.parent().unwrap(),
        &[
            "clone",
            "-q",
            f.remote.to_str().unwrap(),
            other_work.to_str().unwrap(),
        ],
    );
    let other = f.core.add_project(&other_work.to_string_lossy()).unwrap();
    let mut state = state_with_prs(&[detailed_pr()]);
    install_gh(&f, &state);
    assert_eq!(
        f.core.pull_request_detail(f.project.id, 5).unwrap().viewer,
        "me"
    );

    // The other Project's checkout is signed in to GitHub as someone else.
    state["viewer"] = "someone".into();
    f.set_gh(&state);
    assert_eq!(
        f.core.pull_request_detail(other.id, 5).unwrap().viewer,
        "someone"
    );
}

#[test]
fn draft_is_prefilled_from_the_commits_against_the_default_branch() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "add-things"]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    let one = f.core.pull_request_draft(f.project.id, None).unwrap();
    assert_eq!(one.title, "Add b");
    assert_eq!(one.base, "main");
    assert_eq!(one.head, "add-things");

    commit_file(&f.work, "c.txt", "c\n", "Add c");
    let two = f.core.pull_request_draft(f.project.id, None).unwrap();
    assert_eq!(two.title, "Add things");
    assert_eq!(two.body, "- Add b\n- Add c");
}

#[test]
fn draft_counts_the_commits_beyond_the_default_branch() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    let empty = f.core.pull_request_draft(f.project.id, None).unwrap();
    assert_eq!(empty.commits_beyond, Some(0));
    assert!(!empty.protected);

    commit_file(&f.work, "b.txt", "b\n", "Add b");
    commit_file(&f.work, "c.txt", "c\n", "Add c");
    assert_eq!(
        f.core
            .pull_request_draft(f.project.id, None)
            .unwrap()
            .commits_beyond,
        Some(2)
    );
}

#[test]
fn commits_beyond_any_base_are_counted_locally() {
    let f = fixture();
    install_gh(&f, &serde_json::json!({"auth": "logged_out"}));
    git(&f.work, &["checkout", "-q", "-b", "develop"]);
    commit_file(&f.work, "d.txt", "d\n", "Add d");
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");

    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "feature", "main")
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "feature", "develop")
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "feature", "feature")
            .unwrap(),
        Some(0)
    );
    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "feature", "release/unknown")
            .unwrap(),
        None
    );
    // Local Git only: GitHub is never asked.
    assert!(f.gh_calls().is_empty());
}

#[test]
fn commits_beyond_refuses_a_base_that_is_not_a_branch_name() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let long = "b".repeat(256);
    for base in [
        "",
        " ",
        "-n",
        "--output=/tmp/x",
        "main..HEAD",
        "main HEAD",
        "main\n",
        "main@{1}",
        "main^",
        "main~1",
        "main:x",
        "ma*n",
        "ma?n",
        "[main]",
        "main\\x",
        "/main",
        "main/",
        "main.lock",
        long.as_str(),
    ] {
        let err = f
            .core
            .pull_request_commits_beyond(f.project.id, "feature", base)
            .unwrap_err();
        assert!(err.to_string().contains("branch name"), "{base:?}: {err}");
    }
    assert!(f.gh_calls().is_empty());
}

#[test]
fn commits_beyond_refuses_an_unknown_project() {
    let f = fixture();
    install_gh(&f, &ok_state());
    assert!(
        f.core
            .pull_request_commits_beyond(9999, "feature", "main")
            .is_err()
    );
}

#[test]
fn draft_on_the_main_branch_reports_it_is_protected() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let draft = f.core.pull_request_draft(f.project.id, None).unwrap();
    assert_eq!(draft.head, "main");
    assert!(draft.protected);
    assert_eq!(draft.commits_beyond, Some(0));
}

#[test]
fn create_pushes_when_needed_and_calls_gh_with_the_chosen_title_base_and_draft() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    assert!(
        git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("My PR", "main", true))
        .unwrap();

    assert_eq!(pr.number, 7);
    assert!(pr.draft);
    // The branch reached the remote before gh was asked to open the PR.
    assert!(
        !git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );
    assert_eq!(
        f.create_calls(),
        [[
            "pr", "create", "--title", "My PR", "--body", "Body", "--base", "main", "--head",
            "feature", "--draft"
        ]]
    );
    // The new PR is listed by the Surface.
    let listed = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert_eq!(numbers(&listed), [7]);
}

#[test]
fn create_is_refused_when_the_branch_has_no_commits_beyond_the_base() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);

    let err = f
        .core
        .create_pull_request(f.project.id, &input("Empty", "main", false))
        .unwrap_err();

    assert!(
        err.to_string().contains("no commits beyond `main`"),
        "{err}"
    );
    assert!(f.create_calls().is_empty());
    assert!(
        git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );
}

#[test]
fn create_refuses_a_base_that_is_not_a_branch_name() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");

    for base in [
        "--output=/tmp/x",
        "-n",
        "main..HEAD",
        "main@{1}",
        "main^",
        "main:x",
    ] {
        let err = f
            .core
            .create_pull_request(f.project.id, &input("T", base, false))
            .unwrap_err();
        assert!(err.to_string().contains("branch name"), "{base:?}: {err}");
    }
    assert!(f.create_calls().is_empty());
    assert!(
        git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );
}

#[test]
fn create_without_draft_omits_the_flag_and_skips_the_push_when_published() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    git(&f.work, &["push", "-q", "-u", "origin", "feature"]);
    let before = git(&f.remote, &["rev-parse", "feature"]);

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("Ready", "develop", false))
        .unwrap();

    assert!(!pr.draft);
    assert_eq!(pr.base, "develop");
    assert!(!f.create_calls()[0].contains(&"--draft".to_string()));
    assert_eq!(git(&f.remote, &["rev-parse", "feature"]), before);
}

#[test]
fn create_from_a_head_already_on_origin_opens_the_pull_request_without_pushing() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "feature", "b.txt", "Add b", 1_800_000_000);
    git(&f.work, &["push", "-q", "origin", "feature"]);
    let before = git(&f.remote, &["rev-parse", "feature"]);
    // A push URL that cannot be reached proves no push is attempted.
    let unreachable = f.work.parent().unwrap().join("no-such-remote.git");
    git(
        &f.work,
        &[
            "config",
            "remote.origin.pushurl",
            unreachable.to_str().unwrap(),
        ],
    );

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("Published", "main", false))
        .unwrap();

    assert_eq!(pr.number, 7);
    assert_eq!(git(&f.remote, &["rev-parse", "feature"]), before);
    assert_eq!(f.create_calls().len(), 1);
}

#[test]
fn create_from_a_head_diverged_from_origin_is_refused_before_gh() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "feature", "b.txt", "Add b", 1_800_000_000);
    git(&f.work, &["push", "-q", "origin", "feature"]);
    // Someone else pushes to origin/feature while the local branch moves on.
    let other = f.work.parent().unwrap().join("other");
    git(
        f.work.parent().unwrap(),
        &[
            "clone",
            "-q",
            f.remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.name", "T"]);
    git(&other, &["config", "user.email", "t@example.com"]);
    git(&other, &["branch", "-q", "feature", "origin/feature"]);
    commit_on(&other, "feature", "c.txt", "Add c", 1_800_000_100);
    git(&other, &["push", "-q", "origin", "feature"]);
    commit_on(&f.work, "feature", "d.txt", "Add d", 1_800_000_200);
    git(&f.work, &["fetch", "-q", "origin"]);
    let before = git(&f.remote, &["rev-parse", "feature"]);

    let err = f
        .core
        .create_pull_request(f.project.id, &input("Diverged", "main", false))
        .unwrap_err();

    assert!(err.to_string().contains("behind and ahead"), "{err}");
    assert!(f.create_calls().is_empty());
    assert_eq!(git(&f.remote, &["rev-parse", "feature"]), before);
}

#[test]
fn create_is_refused_from_the_protected_branch_and_without_gh() {
    let f = fixture();
    let err = f
        .core
        .create_pull_request(f.project.id, &input("T", "main", false))
        .unwrap_err();
    assert!(err.to_string().contains("Install"), "{err}");

    install_gh(&f, &ok_state());
    let err = f
        .core
        .create_pull_request(f.project.id, &input_from("main", "T", "develop", false))
        .unwrap_err();
    assert!(err.to_string().contains("main"), "{err}");
    assert!(f.create_calls().is_empty());

    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    let err = f
        .core
        .create_pull_request(f.project.id, &input("  ", "main", false))
        .unwrap_err();
    assert!(err.to_string().contains("title"), "{err}");
}

#[test]
fn draft_while_on_main_offers_local_feature_branches_most_recent_first() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "older", "o.txt", "Add older", 1_700_000_000);
    commit_on(&f.work, "newer", "n.txt", "Add newer", 1_800_000_000);
    git(&f.work, &["branch", "master"]);

    let draft = f.core.pull_request_draft(f.project.id, None).unwrap();

    assert_eq!(
        draft.heads,
        ["newer", "older"],
        "main branches are never offered"
    );
    assert_eq!(draft.head, "newer");
    assert!(!draft.protected);
    assert_eq!(draft.title, "Add newer");
    assert_eq!(draft.commits_beyond, Some(1));
    assert_eq!(git(&f.work, &["branch", "--show-current"]).trim(), "main");
}

#[test]
fn draft_prefers_the_checked_out_feature_branch_and_follows_a_chosen_head() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "newer", "n.txt", "Add newer", 1_800_000_000);
    commit_on(&f.work, "older", "o.txt", "Add older", 1_700_000_000);
    git(&f.work, &["checkout", "-q", "older"]);

    assert_eq!(
        f.core.pull_request_draft(f.project.id, None).unwrap().head,
        "older"
    );
    let chosen = f
        .core
        .pull_request_draft(f.project.id, Some("newer"))
        .unwrap();
    assert_eq!(chosen.head, "newer");
    assert_eq!(chosen.title, "Add newer");
    assert_eq!(git(&f.work, &["branch", "--show-current"]).trim(), "older");
}

#[test]
fn draft_refuses_a_head_that_is_invalid_unknown_or_protected() {
    let f = fixture();
    install_gh(&f, &ok_state());
    for head in [
        "--output=/tmp/x",
        "main..HEAD",
        "main@{1}",
        "",
        " feature",
        "nope",
        "main",
    ] {
        assert!(
            f.core.pull_request_draft(f.project.id, Some(head)).is_err(),
            "{head:?}"
        );
    }
}

#[test]
fn draft_on_main_without_feature_branches_reports_it_is_protected() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let draft = f.core.pull_request_draft(f.project.id, None).unwrap();
    assert!(draft.heads.is_empty());
    assert!(draft.protected);
}

#[test]
fn create_from_a_branch_not_checked_out_pushes_it_and_opens_its_pull_request() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "feature", "b.txt", "Add b", 1_800_000_000);
    let local = git(&f.work, &["rev-parse", "feature"]);

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("From main", "main", false))
        .unwrap();

    assert_eq!(pr.number, 7);
    assert_eq!(pr.head, "feature");
    assert_eq!(git(&f.remote, &["rev-parse", "feature"]), local);
    assert_eq!(
        f.create_calls(),
        [[
            "pr",
            "create",
            "--title",
            "From main",
            "--body",
            "Body",
            "--base",
            "main",
            "--head",
            "feature"
        ]]
    );
    // The checkout never moved.
    assert_eq!(git(&f.work, &["branch", "--show-current"]).trim(), "main");
}

#[test]
fn create_refuses_a_head_that_is_invalid_unknown_protected_or_the_base() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "feature", "b.txt", "Add b", 1_800_000_000);
    git(&f.work, &["branch", "master"]);
    for (head, base, says) in [
        ("--output=/tmp/x", "main", "branch name"),
        ("feature..main", "main", "branch name"),
        ("feature@{1}", "main", "branch name"),
        ("", "main", "branch name"),
        (" feature", "main", "branch name"),
        ("feature ", "main", "branch name"),
        ("nope", "main", "no local branch"),
        ("main", "feature", "main branch"),
        ("master", "main", "main branch"),
        ("feature", "feature", "other than"),
    ] {
        let err = f
            .core
            .create_pull_request(f.project.id, &input_from(head, "T", base, false))
            .unwrap_err();
        assert!(err.to_string().contains(says), "{head:?}: {err}");
    }
    assert!(f.create_calls().is_empty());
    assert!(
        git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );
}

#[test]
fn commits_beyond_counts_the_chosen_head_and_refuses_a_bad_one() {
    let f = fixture();
    install_gh(&f, &ok_state());
    commit_on(&f.work, "feature", "b.txt", "Add b", 1_800_000_000);
    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "feature", "main")
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        f.core
            .pull_request_commits_beyond(f.project.id, "main", "feature")
            .unwrap(),
        Some(0)
    );
    for head in [
        "",
        " feature",
        "-n",
        "main..HEAD",
        "main@{1}",
        "main^",
        "main:x",
    ] {
        let err = f
            .core
            .pull_request_commits_beyond(f.project.id, head, "main")
            .unwrap_err();
        assert!(err.to_string().contains("branch name"), "{head:?}: {err}");
    }
    let err = f
        .core
        .pull_request_commits_beyond(f.project.id, "nope", "main")
        .unwrap_err();
    assert!(err.to_string().contains("no local branch"), "{err}");
    assert!(f.gh_calls().is_empty());
}

#[test]
fn gh_is_only_called_when_asked_so_there_is_no_polling() {
    let f = fixture();
    install_gh(&f, &ok_state());
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    assert!(f.gh_calls().is_empty());
    f.core.list_pull_requests(f.project.id, false, "").unwrap();
    let after_one = f.gh_calls().len();
    assert!(after_one > 0);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(f.gh_calls().len(), after_one);
}

fn pr_json(number: u32, title: &str, head: &str, author: &str) -> serde_json::Value {
    serde_json::json!({
        "number": number, "title": title, "state": "OPEN", "isDraft": false,
        "url": format!("https://github.com/fake/repo/pull/{number}"),
        "baseRefName": "main", "headRefName": head, "author": {"login": author},
    })
}

fn state_with_prs(prs: &[serde_json::Value]) -> serde_json::Value {
    let by_head: serde_json::Map<String, serde_json::Value> = prs
        .iter()
        .map(|p| (p["headRefName"].as_str().unwrap().to_string(), p.clone()))
        .collect();
    serde_json::json!({"auth": "ok", "default_branch": "main", "prs": by_head})
}

fn detailed_pr() -> serde_json::Value {
    let mut pr = pr_json(5, "Add b", "add-b", "other");
    pr["body"] = "Adds b.".into();
    pr["changedFiles"] = 4.into();
    pr["comments"] = serde_json::json!([
        {"author": {"login": "reviewer"}, "body": "Looks good", "createdAt": "2026-05-01T10:00:00Z"}
    ]);
    pr["statusCheckRollup"] = serde_json::json!([
        {"__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"__typename": "CheckRun", "name": "web", "status": "COMPLETED", "conclusion": "FAILURE"},
        {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": ""},
        {"__typename": "StatusContext", "context": "ci/legacy", "state": "SUCCESS"},
    ]);
    pr
}

fn numbers(prs: &[oxide_core::PullRequest]) -> Vec<u32> {
    prs.iter().map(|p| p.number).collect()
}

#[test]
fn list_shows_open_pull_requests_mine_or_all_and_searches_them() {
    let f = fixture();
    let mut merged = pr_json(3, "Old", "old", "me");
    merged["state"] = "MERGED".into();
    install_gh(
        &f,
        &state_with_prs(&[
            pr_json(1, "Fix login", "fix-login", "me"),
            pr_json(2, "Add search", "add-search", "other"),
            merged,
        ]),
    );
    let all = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert_eq!(numbers(&all), [1, 2]);
    assert_eq!(all[1].author, "other");
    assert_eq!(all[0].head, "fix-login");

    let mine = f.core.list_pull_requests(f.project.id, true, "").unwrap();
    assert_eq!(numbers(&mine), [1]);

    let found = f
        .core
        .list_pull_requests(f.project.id, false, "search")
        .unwrap();
    assert_eq!(numbers(&found), [2]);
}

#[test]
fn list_without_gh_explains_how_to_get_it() {
    let f = fixture();
    let err = f
        .core
        .list_pull_requests(f.project.id, false, "")
        .unwrap_err();
    assert!(err.to_string().contains("Install"), "{err}");
}

#[test]
fn detail_has_description_checks_comments_and_changed_files() {
    let f = fixture();
    install_gh(&f, &state_with_prs(&[detailed_pr()]));
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();

    assert_eq!(detail.pull_request.title, "Add b");
    assert_eq!(detail.body, "Adds b.");
    let checks: Vec<(&str, &str)> = detail
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state.as_str()))
        .collect();
    assert_eq!(
        checks,
        [
            ("rust", "success"),
            ("web", "failure"),
            ("e2e", "pending"),
            ("ci/legacy", "success")
        ]
    );
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].author, "reviewer");
    assert_eq!(detail.comments[0].body, "Looks good");
    assert_eq!(detail.changed_files, 4);

    let calls = f.gh_calls();
    assert!(
        !calls
            .iter()
            .any(|c| c.starts_with(&["pr".into(), "diff".into()])),
        "pull_request_detail must not spawn `gh pr diff`, calls were: {calls:?}"
    );
    let view_call = calls
        .iter()
        .find(|c| c.starts_with(&["pr".into(), "view".into()]))
        .expect("gh pr view call");
    let json_fields = view_call
        .windows(2)
        .find(|w| w[0] == "--json")
        .map(|w| w[1].as_str())
        .unwrap_or("");
    assert!(
        json_fields.split(',').any(|field| field == "changedFiles"),
        "expected changedFiles in gh pr view --json fields, got: {json_fields}"
    );
}

#[test]
fn pull_request_detail_interleaves_commits_force_pushes_reviews_and_events() {
    use oxide_core::{
        CheckState, ReviewState, TimelineAction, TimelineCommit, TimelineForcePush, TimelineItem,
        TimelineMerge, TimelinePerson, TimelineReview,
    };
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["timelines"] = serde_json::json!({"5": {
        "id": "PR_kwDO5",
        "url": "https://github.com/fake/repo/pull/5",
        "participants": {"nodes": [{"login": "other"}, {"login": "reviewer"}]},
        "timelineItems": {"nodes": [
            {"__typename": "PullRequestCommit", "commit": {
                "oid": "1111111aaaaaaa", "abbreviatedOid": "1111111", "messageHeadline": "Add b",
                "committedDate": "2026-05-01T09:00:00Z", "url": "https://github.com/fake/repo/commit/1111111aaaaaaa",
                "author": {"name": "Other Person", "user": {"login": "other"}},
                "signature": {"isValid": true}, "statusCheckRollup": {"state": "SUCCESS"}}},
            {"__typename": "PullRequestCommit", "commit": {
                "oid": "2222222bbbbbbb", "abbreviatedOid": "2222222", "messageHeadline": "Unsigned",
                "committedDate": "2026-05-01T09:05:00Z", "url": "javascript:alert(1)",
                "author": {"name": "Someone", "user": null}, "signature": null, "statusCheckRollup": null}},
            {"__typename": "ReviewRequestedEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T09:10:00Z",
             "requestedReviewer": {"login": "reviewer"}},
            {"__typename": "ReviewRequestedEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T09:11:00Z",
             "requestedReviewer": {"name": "core-team"}},
            {"__typename": "PullRequestReview", "id": "PRR_1", "author": {"login": "reviewer"}, "body": "",
             "state": "COMMENTED", "createdAt": "2026-05-01T09:20:00Z", "submittedAt": "2026-05-01T09:20:00Z"},
            {"__typename": "PullRequestReview", "id": "PRR_2", "author": {"login": "reviewer"}, "body": "Rename it",
             "state": "CHANGES_REQUESTED", "createdAt": "2026-05-01T09:29:00Z", "submittedAt": "2026-05-01T09:30:00Z"},
            {"__typename": "HeadRefForcePushedEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T09:40:00Z",
             "ref": {"name": "add-b"}, "beforeCommit": {"oid": "2222222bbbbbbb", "abbreviatedOid": "2222222"},
             "afterCommit": {"oid": "3333333ccccccc", "abbreviatedOid": "3333333"}},
            {"__typename": "ConvertToDraftEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T09:50:00Z"},
            {"__typename": "ReadyForReviewEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T09:55:00Z"},
            {"__typename": "MergedEvent", "actor": {"login": "other"}, "createdAt": "2026-05-01T10:30:00Z",
             "mergeRefName": "main", "commit": {"abbreviatedOid": "4444444"}},
            {"__typename": "HeadRefDeletedEvent", "actor": null, "createdAt": "2026-05-01T10:31:00Z"}
        ]}
    }});
    install_gh(&f, &state);

    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.node_id, "PR_kwDO5");
    assert_eq!(detail.participants, ["other", "reviewer"]);
    let action = |actor: &str, at: &str| TimelineAction {
        actor: actor.into(),
        created_at: at.into(),
    };
    let requested = |login: &str, at: &str| {
        TimelineItem::ReviewRequested(TimelinePerson {
            actor: "other".into(),
            created_at: at.into(),
            login: login.into(),
        })
    };
    assert_eq!(
        detail.timeline,
        vec![
            TimelineItem::Commit(TimelineCommit {
                oid: "1111111aaaaaaa".into(),
                abbreviated_oid: "1111111".into(),
                headline: "Add b".into(),
                author: "other".into(),
                committed_at: "2026-05-01T09:00:00Z".into(),
                verified: true,
                status: Some(CheckState::Success),
                url: "https://github.com/fake/repo/commit/1111111aaaaaaa".into(),
            }),
            TimelineItem::Commit(TimelineCommit {
                oid: "2222222bbbbbbb".into(),
                abbreviated_oid: "2222222".into(),
                headline: "Unsigned".into(),
                author: "Someone".into(),
                committed_at: "2026-05-01T09:05:00Z".into(),
                verified: false,
                status: None,
                url: String::new(),
            }),
            requested("reviewer", "2026-05-01T09:10:00Z"),
            requested("core-team", "2026-05-01T09:11:00Z"),
            TimelineItem::Review(TimelineReview {
                id: "PRR_2".into(),
                author: "reviewer".into(),
                body: "Rename it".into(),
                created_at: "2026-05-01T09:30:00Z".into(),
                state: ReviewState::ChangesRequested,
            }),
            TimelineItem::ForcePush(TimelineForcePush {
                actor: "other".into(),
                created_at: "2026-05-01T09:40:00Z".into(),
                branch: "add-b".into(),
                before: "2222222".into(),
                after: "3333333".into(),
                compare_url: "https://github.com/fake/repo/compare/2222222bbbbbbb..3333333ccccccc"
                    .into(),
            }),
            TimelineItem::ConvertedToDraft(action("other", "2026-05-01T09:50:00Z")),
            TimelineItem::ReadyForReview(action("other", "2026-05-01T09:55:00Z")),
            TimelineItem::Merged(TimelineMerge {
                actor: "other".into(),
                created_at: "2026-05-01T10:30:00Z".into(),
                commit: "4444444".into(),
                base: "main".into(),
            }),
            TimelineItem::HeadRefDeleted(action("ghost", "2026-05-01T10:31:00Z")),
        ]
    );
}

#[test]
fn pull_request_detail_falls_back_to_comments_and_reviews_when_the_timeline_query_fails() {
    use oxide_core::{ReviewState, TimelineComment, TimelineItem, TimelineReview};
    let f = fixture();
    let mut pr = detailed_pr();
    pr["comments"] = serde_json::json!([
        {"id": "IC_1", "author": {"login": "reviewer"}, "body": "Looks good", "createdAt": "2026-05-01T10:00:00Z"}
    ]);
    pr["reviews"] = serde_json::json!([
        {"id": "PRR_1", "author": {"login": "bob"}, "body": "Ship it", "state": "APPROVED", "submittedAt": "2026-05-01T09:00:00Z"}
    ]);
    install_gh(&f, &state_with_prs(&[pr]));
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.node_id, "");
    assert_eq!(
        detail.timeline,
        vec![
            TimelineItem::Review(TimelineReview {
                id: "PRR_1".into(),
                author: "bob".into(),
                body: "Ship it".into(),
                created_at: "2026-05-01T09:00:00Z".into(),
                state: ReviewState::Approved,
            }),
            TimelineItem::Comment(TimelineComment {
                id: "IC_1".into(),
                author: "reviewer".into(),
                body: "Looks good".into(),
                created_at: "2026-05-01T10:00:00Z".into(),
            }),
        ]
    );
}

#[test]
fn detail_offers_only_the_merge_methods_the_repository_allows() {
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({
        "mergeCommitAllowed": false, "squashMergeAllowed": true,
        "rebaseMergeAllowed": false, "deleteBranchOnMerge": true,
    });
    install_gh(&f, &state);
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.merge_methods, [oxide_core::MergeMethod::Squash]);
    assert!(detail.delete_branch_on_merge);
}

#[test]
fn comment_sends_the_body_and_shows_up_on_the_next_view() {
    let f = fixture();
    install_gh(&f, &state_with_prs(&[detailed_pr()]));
    f.core
        .comment_pull_request(f.project.id, 5, "  Thanks!  ")
        .unwrap();
    assert!(
        f.gh_calls().contains(
            &["pr", "comment", "5", "--body", "Thanks!"]
                .map(String::from)
                .to_vec()
        )
    );
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.comments.last().unwrap().body, "Thanks!");

    let before = f.gh_calls().len();
    assert!(f.core.comment_pull_request(f.project.id, 5, "  ").is_err());
    assert_eq!(f.gh_calls().len(), before);
}

#[test]
fn merge_uses_an_allowed_method_and_can_delete_the_branch() {
    use oxide_core::MergeMethod;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({"rebaseMergeAllowed": false});
    install_gh(&f, &state);
    let merge_calls = || -> Vec<Vec<String>> {
        f.gh_calls()
            .into_iter()
            .filter(|c| c[..2] == ["pr", "merge"])
            .collect()
    };

    let err = f
        .core
        .merge_pull_request(f.project.id, 5, MergeMethod::Rebase, false, false)
        .unwrap_err();
    assert!(err.to_string().contains("rebase"), "{err}");
    assert!(merge_calls().is_empty());
    // The settings were just read, not cached: refusing does not read them a second time.
    let settings_reads = f
        .gh_calls()
        .iter()
        .filter(|c| {
            c[..2] == ["repo", "view"] && c.iter().any(|a| a.contains("rebaseMergeAllowed"))
        })
        .count();
    assert_eq!(settings_reads, 1);

    f.core
        .merge_pull_request(f.project.id, 5, MergeMethod::Squash, true, false)
        .unwrap();
    assert_eq!(
        merge_calls(),
        [["pr", "merge", "5", "--squash", "--delete-branch"]]
    );
    f.core
        .merge_pull_request(f.project.id, 5, MergeMethod::Squash, true, true)
        .unwrap();
    assert_eq!(merge_calls()[1], ["pr", "merge", "5", "--squash", "--auto"]);
    // Merged pull requests leave the open list.
    let open = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert!(open.is_empty());
}

#[test]
fn closing_a_pull_request_leaves_the_open_list_without_merging() {
    let f = fixture();
    install_gh(&f, &state_with_prs(&[detailed_pr()]));
    f.core.close_pull_request(f.project.id, 5).unwrap();
    let closes: Vec<_> = f
        .gh_calls()
        .into_iter()
        .filter(|c| c[..2] == ["pr", "close"])
        .collect();
    assert_eq!(closes, [["pr", "close", "5"]]);
    assert!(f.gh_calls().iter().all(|c| c[..2] != ["pr", "merge"]));
    let open = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert!(open.is_empty());
}

#[test]
fn detail_reports_who_reviews_who_is_assigned_and_whether_it_can_merge() {
    use oxide_core::{MergeState, ReviewDecision, ReviewState};
    let f = fixture();
    let mut pr = detailed_pr();
    pr["createdAt"] = "2026-05-01T09:00:00Z".into();
    pr["mergeable"] = "CONFLICTING".into();
    pr["mergeStateStatus"] = "DIRTY".into();
    pr["reviewDecision"] = "CHANGES_REQUESTED".into();
    pr["additions"] = 10.into();
    pr["deletions"] = 4.into();
    pr["assignees"] = serde_json::json!([{"login": "lorenzo"}]);
    pr["labels"] = serde_json::json!([{"name": "bug", "color": "d73a4a"}]);
    pr["reviewRequests"] = serde_json::json!([
        {"__typename": "User", "login": "ana"},
        {"__typename": "Team", "name": "core", "slug": "core"},
    ]);
    pr["latestReviews"] = serde_json::json!([
        {"author": {"login": "bob"}, "state": "CHANGES_REQUESTED"},
        {"author": {"login": "ana"}, "state": "APPROVED"},
    ]);
    pr["reviews"] = serde_json::json!([
        {"author": {"login": "bob"}, "state": "CHANGES_REQUESTED", "body": "Rename it",
         "submittedAt": "2026-05-01T11:00:00Z"},
        {"author": {"login": "ana"}, "state": "COMMENTED", "body": "", "submittedAt": "2026-05-01T12:00:00Z"},
    ]);
    let mut state = state_with_prs(&[pr]);
    state["viewer"] = "lorenzo".into();
    state["default_merge"] = "SQUASH".into();
    install_gh(&f, &state);
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();

    assert_eq!(detail.pull_request.created_at, "2026-05-01T09:00:00Z");
    assert_eq!(detail.merge_state, MergeState::Conflicting);
    assert_eq!(
        detail.review_decision,
        Some(ReviewDecision::ChangesRequested)
    );
    assert_eq!((detail.additions, detail.deletions), (10, 4));
    assert_eq!(detail.assignees, ["lorenzo"]);
    assert_eq!(detail.labels[0].name, "bug");
    assert_eq!(detail.viewer, "lorenzo");
    assert_eq!(
        detail.default_merge_method,
        Some(oxide_core::MergeMethod::Squash)
    );
    let reviewers: Vec<(&str, ReviewState)> = detail
        .reviewers
        .iter()
        .map(|r| (r.login.as_str(), r.state))
        .collect();
    // A new request overrides the earlier verdict.
    assert_eq!(
        reviewers,
        [
            ("bob", ReviewState::ChangesRequested),
            ("ana", ReviewState::Requested),
            ("core", ReviewState::Requested),
        ]
    );
    // The review with a body joins the conversation, in order; the empty comment-only one does not.
    let thread: Vec<(&str, Option<ReviewState>)> = detail
        .comments
        .iter()
        .map(|c| (c.author.as_str(), c.review))
        .collect();
    assert_eq!(
        thread,
        [
            ("reviewer", None),
            ("bob", Some(ReviewState::ChangesRequested))
        ]
    );
}

#[test]
fn checks_carry_the_link_to_their_run() {
    let f = fixture();
    let mut pr = detailed_pr();
    pr["statusCheckRollup"] = serde_json::json!([
        {"__typename": "CheckRun", "name": "web", "status": "COMPLETED", "conclusion": "FAILURE",
         "detailsUrl": "https://github.com/fake/repo/actions/runs/1"},
        {"__typename": "StatusContext", "context": "ci/legacy", "state": "FAILURE",
         "targetUrl": "https://ci.example.com/build/9"},
        {"__typename": "StatusContext", "context": "ci/odd", "state": "FAILURE",
         "targetUrl": "javascript:alert(1)"},
    ]);
    install_gh(&f, &state_with_prs(&[pr]));
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    let urls: Vec<Option<&str>> = detail.checks.iter().map(|c| c.url.as_deref()).collect();
    assert_eq!(
        urls,
        [
            Some("https://github.com/fake/repo/actions/runs/1"),
            Some("https://ci.example.com/build/9"),
            None
        ]
    );
}

#[test]
fn checks_keep_github_s_exact_conclusion() {
    use oxide_core::CheckState;
    let f = fixture();
    let mut pr = detailed_pr();
    let run = |name: &str, status: &str, conclusion: &str| serde_json::json!({"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion});
    let status = |context: &str, state: &str| serde_json::json!({"__typename": "StatusContext", "context": context, "state": state});
    pr["statusCheckRollup"] = serde_json::json!([
        run("success", "COMPLETED", "SUCCESS"),
        run("neutral", "COMPLETED", "NEUTRAL"),
        run("skipped", "COMPLETED", "SKIPPED"),
        run("failure", "COMPLETED", "FAILURE"),
        run("timed out", "COMPLETED", "TIMED_OUT"),
        run("cancelled", "COMPLETED", "CANCELLED"),
        run("action required", "COMPLETED", "ACTION_REQUIRED"),
        run("stale", "COMPLETED", "STALE"),
        run("queued", "QUEUED", ""),
        run("in progress", "IN_PROGRESS", ""),
        status("status success", "SUCCESS"),
        status("status pending", "PENDING"),
        status("status expected", "EXPECTED"),
        status("status failure", "FAILURE"),
        status("status error", "ERROR"),
    ]);
    install_gh(&f, &state_with_prs(&[pr]));
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    let states: Vec<(&str, CheckState)> = detail
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state))
        .collect();
    assert_eq!(
        states,
        [
            ("success", CheckState::Success),
            ("neutral", CheckState::Neutral),
            ("skipped", CheckState::Skipped),
            ("failure", CheckState::Failure),
            ("timed out", CheckState::Failure),
            ("cancelled", CheckState::Failure),
            ("action required", CheckState::Failure),
            ("stale", CheckState::Failure),
            ("queued", CheckState::Pending),
            ("in progress", CheckState::Pending),
            ("status success", CheckState::Success),
            ("status pending", CheckState::Pending),
            ("status expected", CheckState::Pending),
            ("status failure", CheckState::Failure),
            ("status error", CheckState::Failure),
        ]
    );
}

#[test]
fn the_default_merge_method_is_github_s_pick_only_when_the_repository_allows_it() {
    use oxide_core::MergeMethod;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["default_merge"] = "SQUASH".into();
    state["repo"] = serde_json::json!({"squashMergeAllowed": false});
    install_gh(&f, &state);
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.default_merge_method, None);
    assert!(detail.merge_methods.contains(&MergeMethod::Merge));
}

#[test]
fn after_a_merge_the_next_pull_request_preselects_the_method_just_used() {
    use oxide_core::MergeMethod;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr(), pr_json(6, "Add c", "add-c", "other")]);
    state["default_merge"] = "MERGE".into();
    install_gh(&f, &state);
    let detail = f.core.pull_request_detail(f.project.id, 6).unwrap();
    assert_eq!(detail.default_merge_method, Some(MergeMethod::Merge));

    f.core
        .merge_pull_request(f.project.id, 5, MergeMethod::Squash, false, false)
        .unwrap();

    let detail = f.core.pull_request_detail(f.project.id, 6).unwrap();
    assert_eq!(detail.default_merge_method, Some(MergeMethod::Squash));
}

#[test]
fn merge_rereads_the_repository_settings_before_refusing_a_method() {
    use oxide_core::MergeMethod;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({"rebaseMergeAllowed": false});
    install_gh(&f, &state);
    f.core.pull_request_detail(f.project.id, 5).unwrap();

    // The repository allows rebase merges since the detail was read.
    state["repo"] = serde_json::json!({"rebaseMergeAllowed": true});
    f.set_gh(&state);
    f.core
        .merge_pull_request(f.project.id, 5, MergeMethod::Rebase, false, false)
        .unwrap();
    assert!(
        f.gh_calls()
            .iter()
            .any(|c| c[..] == ["pr", "merge", "5", "--rebase"])
    );
}

#[test]
fn a_draft_is_marked_ready_and_back_through_gh() {
    let f = fixture();
    let mut pr = detailed_pr();
    pr["isDraft"] = true.into();
    install_gh(&f, &state_with_prs(&[pr]));
    f.core
        .set_pull_request_draft(f.project.id, 5, false)
        .unwrap();
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.phase, oxide_core::PullRequestPhase::Open);
    f.core
        .set_pull_request_draft(f.project.id, 5, true)
        .unwrap();
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.phase, oxide_core::PullRequestPhase::Draft);
    let ready: Vec<Vec<String>> = f
        .gh_calls()
        .into_iter()
        .filter(|c| c[..2] == ["pr", "ready"])
        .collect();
    assert_eq!(
        ready,
        [vec!["pr", "ready", "5"], vec!["pr", "ready", "5", "--undo"]]
    );
}

#[test]
fn settings_edit_reviewers_assignees_and_labels_in_one_call() {
    use oxide_core::PullRequestEdit;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({
        "assignableUsers": [{"login": "Zed"}, {"login": "ana"}],
        "labels": [{"name": "bug", "color": "d73a4a"}],
    });
    install_gh(&f, &state);
    let candidates = f.core.pull_request_candidates(f.project.id).unwrap();
    assert_eq!(candidates.users, ["ana", "Zed"]);
    assert_eq!(candidates.labels[0].name, "bug");

    f.core
        .edit_pull_request(
            f.project.id,
            5,
            &PullRequestEdit {
                add_reviewers: vec!["ana".into(), "bob".into()],
                add_assignees: vec!["ana".into()],
                add_labels: vec!["bug".into()],
                ..Default::default()
            },
        )
        .unwrap();
    let edits: Vec<Vec<String>> = f
        .gh_calls()
        .into_iter()
        .filter(|c| c[..2] == ["pr", "edit"])
        .collect();
    assert_eq!(
        edits,
        [[
            "pr",
            "edit",
            "5",
            "--add-reviewer",
            "ana,bob",
            "--add-assignee",
            "ana",
            "--add-label",
            "bug"
        ]]
    );
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.assignees, ["ana"]);

    // Nothing to change, nothing to ask GitHub.
    let before = f.gh_calls().len();
    f.core
        .edit_pull_request(f.project.id, 5, &PullRequestEdit::default())
        .unwrap();
    assert_eq!(f.gh_calls().len(), before);
}

#[test]
fn only_https_links_reach_the_browser() {
    let f = fixture();
    install_gh(&f, &ok_state());
    f.core
        .open_link("https://github.com/fake/repo/actions/runs/1")
        .unwrap();
    assert!(f.core.open_link("file:///etc/passwd").is_err());
    assert!(f.core.open_link("http://example.com").is_err());
    assert_eq!(f.system.opened.lock().unwrap().len(), 1);
}

#[test]
fn a_link_to_a_foreign_host_opens_only_after_confirmation() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let error = f.core.open_link("https://evil.example/x").unwrap_err();
    assert!(error.to_string().contains("evil.example"), "{error}");
    assert!(f.system.opened.lock().unwrap().is_empty());
    f.core
        .open_confirmed_link("https://evil.example/x")
        .unwrap();
    assert!(
        f.core
            .open_confirmed_link("https://github.com@evil.example/")
            .is_err()
    );
    assert_eq!(f.system.opened.lock().unwrap().len(), 1);
}

#[test]
fn list_and_search_issues_against_fake_gh() {
    let f = fixture();
    install_gh(
        &f,
        &serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 3,
            "issues": [
                {
                    "number": 1,
                    "title": "First issue",
                    "body": "Body 1",
                    "state": "OPEN",
                    "author": {"login": "alice"},
                    "url": "https://github.com/fake/repo/issues/1",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "comments": []
                },
                {
                    "number": 2,
                    "title": "Bug in parser",
                    "body": "Details",
                    "state": "OPEN",
                    "author": {"login": "bob"},
                    "url": "https://github.com/fake/repo/issues/2",
                    "createdAt": "2026-01-02T00:00:00Z",
                    "comments": [{"author": {"login": "alice"}, "body": "me too", "createdAt": "2026-01-02T01:00:00Z"}]
                }
            ]
        }),
    );

    let all = f.core.list_issues(f.project.id, false, false, "").unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].number, 1);
    assert_eq!(all[0].title, "First issue");
    assert_eq!(all[0].comments_count, 0);
    assert_eq!(all[1].number, 2);
    assert_eq!(all[1].comments_count, 1);

    let searched = f
        .core
        .list_issues(f.project.id, false, false, "parser")
        .unwrap();
    assert_eq!(searched.len(), 1);
    assert_eq!(searched[0].number, 2);
}

#[test]
fn view_issue_detail_with_comments() {
    let f = fixture();
    install_gh(
        &f,
        &serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 3,
            "issues": [
                {
                    "number": 42,
                    "title": "Bug in lexer",
                    "body": "It crashes on null byte",
                    "state": "OPEN",
                    "author": {"login": "charlie"},
                    "url": "https://github.com/fake/repo/issues/42",
                    "createdAt": "2026-01-03T10:00:00Z",
                    "comments": [
                        {
                            "author": {"login": "dave"},
                            "body": "Can confirm on macOS",
                            "createdAt": "2026-01-03T10:30:00Z"
                        }
                    ]
                }
            ]
        }),
    );

    let detail = f.core.issue_detail(f.project.id, 42).unwrap();
    assert_eq!(detail.number, 42);
    assert_eq!(detail.title, "Bug in lexer");
    assert_eq!(detail.body, "It crashes on null byte");
    assert_eq!(detail.author, "charlie");
    assert_eq!(detail.state, "OPEN");
    assert_eq!(detail.url, "https://github.com/fake/repo/issues/42");
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].author, "dave");
    assert_eq!(detail.comments[0].body, "Can confirm on macOS");
}

fn issue_42() -> serde_json::Value {
    serde_json::json!({
        "number": 42,
        "title": "Bug in lexer",
        "body": "It crashes",
        "state": "OPEN",
        "author": {"login": "charlie"},
        "url": "https://github.com/fake/repo/issues/42",
        "createdAt": "2026-01-03T10:00:00Z",
        "comments": [
            {"id": "IC_1", "author": {"login": "dave"}, "body": "Can confirm", "createdAt": "2026-01-03T10:30:00Z"}
        ]
    })
}

#[test]
fn issue_detail_interleaves_activity_with_comments_from_graphql() {
    use oxide_core::{
        PullRequestLabel, TimelineAction, TimelineClosed, TimelineComment, TimelineItem,
        TimelineLabel, TimelinePerson, TimelineReference, TimelineRename,
    };
    let f = fixture();
    let mut state = ok_state();
    state["issues"] = serde_json::json!([issue_42()]);
    state["timelines"] = serde_json::json!({"42": {
        "id": "I_kwDO42",
        "participants": {"nodes": [{"login": "charlie"}, {"login": "dave"}]},
        "timelineItems": {"nodes": [
            {"__typename": "LabeledEvent", "actor": {"login": "charlie"}, "createdAt": "2026-01-03T10:01:00Z",
             "label": {"name": "bug", "color": "d73a4a"}},
            {"__typename": "AssignedEvent", "actor": {"login": "charlie"}, "createdAt": "2026-01-03T10:02:00Z",
             "assignee": {"login": "dave"}},
            {"__typename": "IssueComment", "id": "IC_1", "author": {"login": "dave"}, "body": "Can confirm",
             "createdAt": "2026-01-03T10:30:00Z"},
            {"__typename": "UnlabeledEvent", "actor": {"login": "dave"}, "createdAt": "2026-01-03T10:40:00Z",
             "label": {"name": "bug", "color": "d73a4a"}},
            {"__typename": "UnassignedEvent", "actor": {"login": "dave"}, "createdAt": "2026-01-03T10:41:00Z",
             "assignee": {"login": "dave"}},
            {"__typename": "RenamedTitleEvent", "actor": {"login": "charlie"}, "createdAt": "2026-01-03T11:00:00Z",
             "previousTitle": "Lexer bug", "currentTitle": "Bug in lexer"},
            {"__typename": "CrossReferencedEvent", "actor": {"login": "erin"}, "createdAt": "2026-01-03T12:00:00Z",
             "isCrossRepository": true,
             "source": {"__typename": "PullRequest", "number": 9, "title": "Fix lexer", "state": "MERGED",
                        "url": "https://github.com/other/repo/pull/9", "repository": {"nameWithOwner": "other/repo"}}},
            {"__typename": "ClosedEvent", "actor": {"login": "charlie"}, "createdAt": "2026-01-04T09:00:00Z",
             "stateReason": "NOT_PLANNED"},
            {"__typename": "ReopenedEvent", "actor": {"login": "dave"}, "createdAt": "2026-01-05T09:00:00Z"},
            {"__typename": "SomethingNew", "createdAt": "2026-01-06T09:00:00Z"}
        ]}
    }});
    install_gh(&f, &state);

    let detail = f.core.issue_detail(f.project.id, 42).unwrap();
    assert_eq!(detail.node_id, "I_kwDO42");
    assert_eq!(detail.participants, ["charlie", "dave"]);
    let person = |actor: &str, at: &str, login: &str| TimelinePerson {
        actor: actor.into(),
        created_at: at.into(),
        login: login.into(),
    };
    let bug = PullRequestLabel {
        name: "bug".into(),
        color: "d73a4a".into(),
    };
    assert_eq!(
        detail.timeline,
        vec![
            TimelineItem::Labeled(TimelineLabel {
                actor: "charlie".into(),
                created_at: "2026-01-03T10:01:00Z".into(),
                label: bug.clone(),
            }),
            TimelineItem::Assigned(person("charlie", "2026-01-03T10:02:00Z", "dave")),
            TimelineItem::Comment(TimelineComment {
                id: "IC_1".into(),
                author: "dave".into(),
                body: "Can confirm".into(),
                created_at: "2026-01-03T10:30:00Z".into(),
            }),
            TimelineItem::Unlabeled(TimelineLabel {
                actor: "dave".into(),
                created_at: "2026-01-03T10:40:00Z".into(),
                label: bug,
            }),
            TimelineItem::Unassigned(person("dave", "2026-01-03T10:41:00Z", "dave")),
            TimelineItem::Renamed(TimelineRename {
                actor: "charlie".into(),
                created_at: "2026-01-03T11:00:00Z".into(),
                from: "Lexer bug".into(),
                to: "Bug in lexer".into(),
            }),
            TimelineItem::CrossReferenced(TimelineReference {
                actor: "erin".into(),
                created_at: "2026-01-03T12:00:00Z".into(),
                number: 9,
                title: "Fix lexer".into(),
                url: "https://github.com/other/repo/pull/9".into(),
                state: "MERGED".into(),
                pull_request: true,
                repository: "other/repo".into(),
                cross_repository: true,
            }),
            TimelineItem::Closed(TimelineClosed {
                actor: "charlie".into(),
                created_at: "2026-01-04T09:00:00Z".into(),
                state_reason: "NOT_PLANNED".into(),
            }),
            TimelineItem::Reopened(TimelineAction {
                actor: "dave".into(),
                created_at: "2026-01-05T09:00:00Z".into(),
            }),
        ]
    );
    // One GraphQL round trip, numbered, with the user's values passed as typed fields.
    let call = f
        .gh_calls()
        .into_iter()
        .find(|c| c[..2] == ["api", "graphql"] && c.iter().any(|a| a.contains("timelineItems")))
        .expect("a timeline query");
    assert!(call.contains(&"number=42".to_string()), "{call:?}");
}

#[test]
fn issue_detail_falls_back_to_its_comments_when_the_timeline_query_fails() {
    use oxide_core::{TimelineComment, TimelineItem};
    let f = fixture();
    let mut state = ok_state();
    state["issues"] = serde_json::json!([issue_42()]);
    install_gh(&f, &state);
    let detail = f.core.issue_detail(f.project.id, 42).unwrap();
    assert_eq!(detail.node_id, "");
    assert_eq!(
        detail.timeline,
        vec![TimelineItem::Comment(TimelineComment {
            id: "IC_1".into(),
            author: "dave".into(),
            body: "Can confirm".into(),
            created_at: "2026-01-03T10:30:00Z".into(),
        })]
    );
}

#[test]
fn create_comment_and_close_issue_calling_gh() {
    let f = fixture();
    install_gh(
        &f,
        &serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 10,
            "issues": []
        }),
    );

    // Create, with an assignee and a label
    let created = f
        .core
        .create_issue(
            f.project.id,
            "New Feature",
            "Feature description",
            &["alice".to_string()],
            &["bug".to_string()],
        )
        .unwrap();
    assert_eq!(created.number, 10);
    assert_eq!(created.title, "New Feature");
    assert_eq!(created.url, "https://github.com/fake/repo/issues/10");
    assert_eq!(created.assignees, ["alice"]);
    assert_eq!(created.labels[0].name, "bug");

    // List after create shows it
    let list = f.core.list_issues(f.project.id, false, false, "").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].number, 10);

    // Comment
    f.core
        .comment_issue(f.project.id, 10, "First thought")
        .unwrap();
    let detail = f.core.issue_detail(f.project.id, 10).unwrap();
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].body, "First thought");

    // Close: it leaves the open list and shows in the closed one, with its reason
    f.core
        .close_issue(
            f.project.id,
            10,
            IssueCloseReason::NotPlanned,
            "Out of scope",
        )
        .unwrap();
    assert!(
        f.core
            .list_issues(f.project.id, false, false, "")
            .unwrap()
            .is_empty()
    );
    let closed = f
        .core
        .list_issues(f.project.id, true, false, "Feature")
        .unwrap();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].state, "CLOSED");
    assert_eq!(closed[0].state_reason, "NOT_PLANNED");
    assert_eq!(closed[0].comments_count, 2);

    // Reopen
    f.core.reopen_issue(f.project.id, 10).unwrap();
    assert_eq!(
        f.core
            .list_issues(f.project.id, false, false, "")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn edit_issue_changes_text_assignees_and_labels() {
    let f = fixture();
    install_gh(
        &f,
        &serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "viewer": "me",
            "next_number": 4,
            "issues": [
                {
                    "number": 3,
                    "title": "Old title",
                    "body": "Old body",
                    "state": "OPEN",
                    "author": {"login": "me"},
                    "url": "https://github.com/fake/repo/issues/3",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "comments": [],
                    "assignees": [{"login": "bob"}],
                    "labels": [{"name": "bug", "color": "d73a4a"}]
                },
                {
                    "number": 2,
                    "title": "Someone else's",
                    "body": "",
                    "state": "OPEN",
                    "author": {"login": "carol"},
                    "url": "https://github.com/fake/repo/issues/2",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "comments": []
                }
            ]
        }),
    );

    f.core
        .edit_issue(
            f.project.id,
            3,
            &IssueEdit {
                title: Some("New title".into()),
                body: Some("New body".into()),
                add_assignees: vec!["alice".into()],
                remove_assignees: vec!["bob".into()],
                add_labels: vec!["docs".into()],
                remove_labels: vec!["bug".into()],
            },
        )
        .unwrap();
    let detail = f.core.issue_detail(f.project.id, 3).unwrap();
    assert_eq!(detail.title, "New title");
    assert_eq!(detail.body, "New body");
    assert_eq!(detail.assignees, ["alice"]);
    assert_eq!(detail.labels.len(), 1);
    assert_eq!(detail.labels[0].name, "docs");
    assert_eq!(detail.viewer, "me");

    // A blank title is refused before `gh` is asked
    let err = f
        .core
        .edit_issue(
            f.project.id,
            3,
            &IssueEdit {
                title: Some("  ".into()),
                ..IssueEdit::default()
            },
        )
        .unwrap_err();
    assert!(err.to_string().contains("title"), "{err}");

    // "Mine" lists only what the signed-in user opened
    let mine = f.core.list_issues(f.project.id, false, true, "").unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].number, 3);
}

#[test]
fn issues_state_reports_guidance_when_missing_or_logged_out() {
    let f = fixture();
    let missing = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(missing.availability, GithubAvailability::Missing);
    assert!(missing.guidance.as_ref().unwrap().contains("Install"));

    install_gh(&f, &serde_json::json!({"auth": "logged_out"}));
    let logged_out = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(logged_out.availability, GithubAvailability::LoggedOut);
    assert!(
        logged_out
            .guidance
            .as_ref()
            .unwrap()
            .contains("gh auth login")
    );

    f.set_gh(&serde_json::json!({"auth": "ok", "issues": []}));
    let ready = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(ready.availability, GithubAvailability::Ready);
    assert!(ready.guidance.is_none());
}

#[test]
fn issue_templates_are_read_from_github_and_a_missing_directory_means_none() {
    let f = fixture();
    install_gh(&f, &ok_state());
    assert!(f.core.issue_templates(f.project.id).unwrap().is_empty());

    let mut state = ok_state();
    state["issue_templates"] = serde_json::json!({
        "bug_report.yml": "name: Bug report\n",
        "config.yml": "blank_issues_enabled: false\n",
        "notes.txt": "not a template",
    });
    install_gh(&f, &state);
    let files = f.core.issue_templates(f.project.id).unwrap();
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["bug_report.yml", "config.yml"]);
    // The fake `gh` prints through Python, which ends lines with CRLF on Windows.
    assert_eq!(files[0].content.replace("\r\n", "\n"), "name: Bug report\n");
}

#[test]
fn checks_know_whether_branch_protection_requires_them() {
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["required_checks"] = serde_json::json!(["rust", "web"]);
    install_gh(&f, &state);
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    let required: Vec<(&str, bool)> = detail
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.required))
        .collect();
    assert_eq!(
        required,
        [
            ("rust", true),
            ("web", true),
            ("e2e", false),
            ("ci/legacy", false)
        ]
    );
}

#[test]
fn issue_detail_resolves_private_user_attachments_from_body_html() {
    use oxide_core::SignedImage;
    let f = fixture();
    let mut state = ok_state();
    state["issues"] = serde_json::json!([issue_42()]);
    let signed = |id: &str| {
        format!("https://private-user-images.githubusercontent.com/7/9-{id}.png?jwt=eyJ.{id}")
    };
    let a = "84ccda0a-5c4a-4fe4-b897-ed3f90e852b2";
    let b = "e427716d-a14d-43fa-b17e-d41ae0701097";
    state["timelines"] = serde_json::json!({"42": {
        "id": "I_kwDO42",
        "url": "https://github.com/fake/repo/issues/42",
        "bodyHTML": format!(
            "<p><a href=\"{0}\"><img src=\"{0}&amp;x=1\" alt=\"image\"></a> \
             <img src=\"https://evil.example/7/9-{a}.png\"> \
             <img src=\"https://private-user-images.githubusercontent.com/7/no-id.png?jwt=1\"></p>",
            signed(a)
        ),
        "participants": {"nodes": []},
        "timelineItems": {"nodes": [
            {"__typename": "IssueComment", "id": "IC_1", "author": {"login": "dave"},
             "body": format!("![shot](https://github.com/user-attachments/assets/{b})"),
             "bodyHTML": format!("<p><img src='{}' alt='shot'></p>", signed(b)),
             "createdAt": "2026-01-03T10:30:00Z"}
        ]}
    }});
    install_gh(&f, &state);

    let detail = f.core.issue_detail(f.project.id, 42).unwrap();
    assert_eq!(
        detail.signed_images,
        vec![
            SignedImage {
                url: format!("https://github.com/user-attachments/assets/{a}"),
                signed_url: format!("{}&x=1", signed(a)),
            },
            SignedImage {
                url: format!("https://github.com/user-attachments/assets/{b}"),
                signed_url: signed(b),
            },
        ]
    );
    let query = f
        .gh_calls()
        .into_iter()
        .flatten()
        .find(|a| a.contains("timelineItems"))
        .unwrap();
    assert_eq!(query.matches("bodyHTML").count(), 2, "{query}");
}

#[test]
fn fetch_github_image_refuses_unknown_projects_and_non_github_urls_without_a_request() {
    let f = fixture();
    install_gh(&f, &ok_state());
    let asset = "https://github.com/user-attachments/assets/84ccda0a-5c4a-4fe4-b897-ed3f90e852b2";
    assert!(
        f.core
            .fetch_github_image(f.project.id + 100, asset)
            .is_err()
    );
    for url in [
        "http://user-images.githubusercontent.com/1/2-x.png",
        "https://user:pw@github.com/user-attachments/assets/x",
        "https://127.0.0.1/a.png",
        "https://localhost/a.png",
        "https://evil.example/a.png",
        "https://raw.githubusercontent.com:8443/fake/repo/main/a.png",
        "https://github.com/settings/tokens",
        "data:image/svg+xml,<svg/>",
        "",
    ] {
        let error = f.core.fetch_github_image(f.project.id, url).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("only shows images hosted on GitHub"),
            "{url}: {error}"
        );
    }
    assert!(f.gh_calls().is_empty(), "no gh call for a refused URL");
}
