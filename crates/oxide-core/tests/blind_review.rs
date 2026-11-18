#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
use oxide_core::blind_review::{BlindReviewRequest, BlindReviewRun, BlindReviewStatus};
use oxide_core::{Core, Error, FindingDecision, PermissionMode};
use oxide_provider::FakeProvider;
use oxide_provider::oneshot::OneShotRequest;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

struct Fixture {
    _tmp: tempfile::TempDir,
    core: Core,
    work: PathBuf,
    project_id: u32,
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git failed");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.name", "Oxide Test"]);
    git(&work, &["config", "user.email", "test@oxide.local"]);
    git(&work, &["config", "commit.gpgsign", "false"]);
    std::fs::write(work.join("hello.rs"), "fn hello() {}\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "initial commit"]);

    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();

    Fixture {
        _tmp: tmp,
        core,
        work,
        project_id: project.id,
    }
}

struct Reviewed {
    fixture: Fixture,
    original: u32,
    run: BlindReviewRun,
}

/// An original Thread with a one-line change, and a Blind review of it whose Provider replies with
/// `reply` as its closing message.
fn reviewed(reply: &str) -> Reviewed {
    let fixture = fixture();
    let original = original_with_change(&fixture);
    install_runner(&fixture.core, Ok(reply.to_string()));
    let run = fixture
        .core
        .run_blind_review(request(&fixture, original, "fake"))
        .unwrap();
    Reviewed {
        fixture,
        original,
        run,
    }
}

fn request(fixture: &Fixture, thread_id: u32, provider: &str) -> BlindReviewRequest {
    BlindReviewRequest {
        project_id: fixture.project_id,
        thread_id: Some(thread_id),
        provider: provider.into(),
        model: None,
        effort: None,
        scope: "uncommitted".into(),
        turn_index: None,
        issue: Some("Add a greeting".into()),
    }
}

/// A Thread whose checkout has an uncommitted one-line change. It has been given a prompt, so
/// there is a Transcript the review must never see.
fn original_with_change(fixture: &Fixture) -> u32 {
    let original = fixture
        .core
        .create_thread(fixture.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    fixture
        .core
        .register_fake_provider(original.id, FakeProvider::scripted());
    fixture
        .core
        .send_prompt(original.id, "implement with secret reasoning")
        .unwrap();
    let checkout = PathBuf::from(
        fixture
            .core
            .checkout_path(fixture.project_id, Some(original.id))
            .unwrap(),
    );
    std::fs::write(
        checkout.join("hello.rs"),
        "fn hello() { println!(\"world\"); }\n",
    )
    .unwrap();
    original.id
}

/// Replaces the CLI launch with a fake that records what it was asked and replies with `reply`.
fn install_runner(core: &Core, reply: Result<String, String>) -> Arc<Mutex<Vec<OneShotRequest>>> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    core.set_one_shot_runner(Arc::new(move |request: &OneShotRequest| {
        seen.lock().unwrap().push(request.clone());
        reply
            .clone()
            .map_err(oxide_provider::ProviderError::CommandFailed)
    }));
    requests
}

#[test]
fn findings_are_parsed_from_the_closing_message_and_anchored_to_the_reviewed_diff() {
    let r = reviewed(
        r#"```json
        [
          {"path": "hello.rs", "line": 1, "body": "Why print here?"}
        ]
        ```"#,
    );
    assert_eq!(r.run.status, BlindReviewStatus::Finished);
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 1, "one finding was parsed");
    let finding = &findings[0];
    assert_eq!(finding.provider, "fake");
    assert_eq!(finding.review_id, r.run.id);
    assert_eq!(finding.path.as_deref(), Some("hello.rs"));
    assert_eq!(finding.line, Some(1));
    assert_eq!(finding.side, Some(oxide_core::CommentSide::New));
    assert!(finding.code.contains("println!"));
    assert_eq!(finding.body, "Why print here?");
    assert!(!finding.plain);
    assert_eq!(finding.decision, FindingDecision::Pending);
}

#[test]
fn a_reply_that_cannot_be_parsed_is_kept_as_plain_text_never_dropped() {
    let r = reviewed("I could not format this as JSON. Line 1 looks odd.");
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 1);
    assert!(findings[0].plain);
    assert_eq!(findings[0].decision, FindingDecision::Pending);
    assert!(
        findings[0].body.contains("I could not format this as JSON"),
        "the reply must be kept: {:?}",
        findings[0].body
    );
}

#[test]
fn a_finding_that_cannot_be_anchored_is_kept_as_plain_text_beside_the_anchored_ones() {
    let r = reviewed(
        r#"[
          {"path": "hello.rs", "line": 99, "body": "A line that is not in the diff"},
          {"path": "hello.rs", "line": 1, "body": "An anchored finding"}
        ]"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 2, "both findings are kept");
    assert!(findings[0].plain);
    assert_eq!(findings[0].path.as_deref(), Some("hello.rs"));
    assert_eq!(findings[0].line, Some(99));
    assert!(!findings[1].plain);
    assert_eq!(findings[1].body, "An anchored finding");
}

#[test]
fn keeping_a_finding_makes_a_line_comment_and_dismissing_one_never_reaches_the_thread() {
    let r = reviewed(
        r#"[
          {"path": "hello.rs", "line": 1, "body": "Keep this finding"},
          {"path": "hello.rs", "line": 1, "body": "Dismiss this finding"}
        ]"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 2);

    let kept = r
        .fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap()
        .expect("an anchored finding becomes a Line comment");
    assert_eq!(kept.provider.as_deref(), Some("fake"));
    assert_eq!(kept.body, "Keep this finding");

    r.fixture
        .core
        .dismiss_blind_review_finding(findings[1].id)
        .unwrap();

    let drafts = r.fixture.core.list_line_comments(r.original).unwrap();
    assert_eq!(drafts.len(), 1, "only the kept finding is a Line comment");
    assert_eq!(drafts[0].body, "Keep this finding");

    // Keeping twice does not duplicate the Line comment.
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();
    assert_eq!(
        r.fixture.core.list_line_comments(r.original).unwrap().len(),
        1
    );
}

#[test]
fn the_review_creates_no_thread() {
    let f = fixture();
    let original = original_with_change(&f);
    let before = f.core.list_threads(f.project_id).unwrap().len();
    install_runner(&f.core, Ok("[]".into()));
    f.core
        .run_blind_review(request(&f, original, "fake"))
        .unwrap();
    let threads = f.core.list_threads(f.project_id).unwrap();
    assert_eq!(threads.len(), before, "no Thread appears in the sidebar");
    assert!(threads.iter().all(|t| !t.blind_review));
}

#[test]
fn the_reviewer_receives_only_the_diff_and_the_issue_in_a_detached_worktree() {
    let f = fixture();
    let original = original_with_change(&f);
    let checkout = PathBuf::from(f.core.checkout_path(f.project_id, Some(original)).unwrap());
    let requests = install_runner(&f.core, Ok("[]".into()));
    let mut req = request(&f, original, "fake");
    req.model = Some("some-model".into());
    f.core.run_blind_review(req).unwrap();

    let seen = requests.lock().unwrap();
    assert_eq!(seen.len(), 1, "one headless run");
    let run = &seen[0];
    let prompt = &run.prompt;
    assert!(prompt.contains("<issue>") && prompt.contains("Add a greeting"));
    assert!(prompt.contains("<diff>") && prompt.contains("println!"));
    assert!(prompt.contains("```json"));
    assert!(
        !prompt.contains("secret reasoning"),
        "the original Thread's Transcript must not leak"
    );
    assert_eq!(run.provider, "fake");
    assert_eq!(run.model.as_deref(), Some("some-model"));
    assert_ne!(run.working_dir, checkout);
    assert_ne!(run.working_dir, f.work);
    assert!(
        !run.working_dir.exists(),
        "the worktree is removed once the run ends"
    );
}

#[test]
fn the_run_happens_in_a_detached_worktree_that_cannot_reach_the_checkout() {
    let f = fixture();
    let original = original_with_change(&f);
    let checkout = PathBuf::from(f.core.checkout_path(f.project_id, Some(original)).unwrap());
    let observed = Arc::new(Mutex::new(None));
    let seen = observed.clone();
    let (main, co) = (f.work.clone(), checkout.clone());
    f.core
        .set_one_shot_runner(Arc::new(move |request: &OneShotRequest| {
            let dir = &request.working_dir;
            let branch = git(dir, &["branch", "--show-current"]);
            let status = git(dir, &["status"]);
            // A writing reviewer would only reach its own worktree.
            std::fs::write(dir.join("isolation.txt"), "x").unwrap();
            *seen.lock().unwrap() = Some((
                branch,
                status,
                dir.clone(),
                main.join("isolation.txt").exists() || co.join("isolation.txt").exists(),
            ));
            Ok("[]".to_string())
        }));
    f.core
        .run_blind_review(request(&f, original, "fake"))
        .unwrap();
    let (branch, status, dir, leaked) = observed.lock().unwrap().take().unwrap();
    assert!(branch.is_empty(), "no branch, got '{branch}'");
    assert!(status.contains("HEAD detached") || status.contains("Not currently on any branch"));
    assert_ne!(dir, checkout);
    assert!(
        !leaked,
        "a write in the review worktree never reaches the checkout"
    );
}

#[test]
fn a_failed_run_is_reported_and_leaves_no_findings() {
    let f = fixture();
    let original = original_with_change(&f);
    install_runner(&f.core, Err("the CLI crashed".into()));
    let run = f
        .core
        .run_blind_review(request(&f, original, "fake"))
        .unwrap();
    assert_eq!(run.status, BlindReviewStatus::Failed);
    assert!(
        run.error
            .as_deref()
            .unwrap_or("")
            .contains("the CLI crashed")
    );
    assert!(
        f.core
            .list_blind_review_findings(original)
            .unwrap()
            .is_empty()
    );
    let runs = f.core.blind_review_runs(original).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, BlindReviewStatus::Failed);
}

#[test]
fn a_review_that_was_running_when_oxide_quit_is_reported_as_interrupted() {
    let f = fixture();
    let original = original_with_change(&f);
    let prepared = f
        .core
        .prepare_blind_review(request(&f, original, "fake"))
        .unwrap();
    assert_eq!(prepared.run().status, BlindReviewStatus::Running);
    let home = f._tmp.path().join("home");
    f.core.shutdown();
    let core = Core::open(home).unwrap();
    let runs = core.blind_review_runs(original).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, BlindReviewStatus::Failed);
}

#[test]
fn deleting_the_reviewed_thread_with_a_kept_finding_leaves_nothing_behind() {
    let r = reviewed(r#"[{"path": "hello.rs", "line": 1, "body": "Keep me"}]"#);
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();

    r.fixture.core.delete_thread(r.original, true).unwrap();

    assert!(
        r.fixture
            .core
            .blind_review_runs(r.original)
            .unwrap()
            .is_empty()
    );
    assert!(
        r.fixture
            .core
            .list_blind_review_findings(r.original)
            .unwrap()
            .is_empty(),
        "the findings die with the Thread they were about"
    );
}

#[test]
fn agy_cannot_honour_non_writing_and_is_not_offered_for_blind_review() {
    let f = fixture();
    assert!(!f.core.provider_can_honour_non_writing("agy"));
    assert!(!f.core.provider_can_honour_non_writing("antigravity"));
    assert!(f.core.provider_can_honour_non_writing("fake"));
    assert!(f.core.provider_can_honour_non_writing("claude"));
    assert!(f.core.provider_can_honour_non_writing("codex"));

    let options = f.core.blind_review_providers(None);
    assert!(
        !options
            .iter()
            .any(|o| o.provider == "agy" || o.provider == "antigravity")
    );

    let original = original_with_change(&f);
    let err = f
        .core
        .run_blind_review(request(&f, original, "agy"))
        .unwrap_err();
    match err {
        Error::Provider(msg) => {
            assert!(msg.contains("cannot honour a non-writing configuration"));
        }
        other => panic!("unexpected error: {:?}", other),
    }
}

#[test]
fn single_provider_allowed_and_clearly_labelled_as_same_provider() {
    let f = fixture();
    let options = f.core.blind_review_providers(Some("fake"));
    let fake_opt = options
        .iter()
        .find(|o| o.provider == "fake")
        .expect("fake provider present");
    assert!(fake_opt.same_provider);
    assert!(fake_opt.label.contains("same provider"));
}

#[test]
fn a_model_effort_or_scope_that_is_not_plain_is_refused_before_anything_starts() {
    let f = fixture();
    let original = original_with_change(&f);
    let requests = install_runner(&f.core, Ok("[]".into()));
    let long = "a".repeat(200);
    for bad in ["high\"", "-x", long.as_str(), "a b"] {
        let mut req = request(&f, original, "fake");
        req.effort = Some(bad.into());
        assert!(f.core.run_blind_review(req).is_err(), "effort {bad:?}");
        let mut req = request(&f, original, "fake");
        req.model = Some(bad.into());
        assert!(f.core.run_blind_review(req).is_err(), "model {bad:?}");
    }
    let mut req = request(&f, original, "fake");
    req.scope = "everything".into();
    assert!(f.core.run_blind_review(req).is_err());
    assert!(requests.lock().unwrap().is_empty(), "no Provider was run");
}

#[test]
fn a_huge_issue_is_capped_before_the_prompt_is_built() {
    let f = fixture();
    let original = original_with_change(&f);
    let requests = install_runner(&f.core, Ok("[]".into()));
    let mut req = request(&f, original, "fake");
    req.issue = Some("x".repeat(200_000));
    f.core.run_blind_review(req).unwrap();
    let seen = requests.lock().unwrap();
    assert!(seen[0].prompt.len() < 100_000, "{}", seen[0].prompt.len());
    assert!(seen[0].prompt.contains("[issue truncated]"));
}

#[test]
fn a_run_that_could_not_be_recorded_is_marked_failed_without_credentials() {
    let f = fixture();
    let original = original_with_change(&f);
    install_runner(&f.core, Ok("[]".into()));
    let prepared = f
        .core
        .prepare_blind_review(request(&f, original, "fake"))
        .unwrap();
    let id = prepared.run().id;
    assert_eq!(
        f.core.blind_review_runs(original).unwrap()[0].status,
        BlindReviewStatus::Running
    );

    f.core
        .fail_blind_review(id, "clone of https://user:secret@example.com/r.git failed");

    let runs = f.core.blind_review_runs(original).unwrap();
    assert_eq!(runs[0].status, BlindReviewStatus::Failed);
    let error = runs[0].error.clone().unwrap();
    assert!(
        error.contains("example.com") && !error.contains("secret"),
        "{error}"
    );
}

#[test]
fn a_provider_error_is_stored_without_url_credentials() {
    let f = fixture();
    let original = original_with_change(&f);
    install_runner(&f.core, Err("fetch https://u:hunter2@host/x failed".into()));
    let run = f
        .core
        .run_blind_review(request(&f, original, "fake"))
        .unwrap();
    assert!(!run.error.unwrap().contains("hunter2"));
}
