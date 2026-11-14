use std::time::Duration;

use oxide_core::thread::ThreadStatus;
use oxide_core::{BoardEvent, Core, PermissionMode, TurnStatus};
use oxide_provider::{ApprovalDecision, ApprovalKind, FakeProvider, ProviderEvent};
use tempfile::tempdir;

fn core_with_project() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    std::fs::create_dir_all(dir.path().join("my-project/.git")).unwrap();
    let project = core
        .add_project(&dir.path().join("my-project").to_string_lossy())
        .unwrap();
    (dir, core, project.id)
}

fn next(rx: &crossbeam_channel::Receiver<BoardEvent>) -> BoardEvent {
    rx.recv_timeout(Duration::from_secs(5))
        .expect("board event")
}

#[test]
fn snapshot_lists_the_projects_threads_and_events_follow_status_changes() {
    let (_dir, core, project) = core_with_project();
    let first = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();

    let (snapshot, rx) = core.subscribe_board(project).unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].thread.id, first.id);
    assert_eq!(snapshot[0].thread.status, ThreadStatus::Completed);

    let second = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let BoardEvent::ThreadChanged(card) = next(&rx) else {
        panic!("expected ThreadChanged")
    };
    assert_eq!(card.thread.id, second.id);

    core.send_prompt(second.id, "hello").unwrap();
    let mut statuses = vec![];
    while let Ok(BoardEvent::ThreadChanged(card)) = rx.recv_timeout(Duration::from_secs(5)) {
        assert_eq!(card.thread.id, second.id);
        if statuses.is_empty() && card.thread.status != ThreadStatus::Working {
            continue; // a change before the Turn starts working
        }
        statuses.push(card.thread.status);
        if card.thread.status == ThreadStatus::Completed {
            break;
        }
    }
    assert_eq!(statuses.first(), Some(&ThreadStatus::Working));
    assert_eq!(statuses.last(), Some(&ThreadStatus::Completed));
}

#[test]
fn deleting_emits_an_event_and_other_projects_are_not_heard() {
    let (_dir, core, project) = core_with_project();
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let (_, rx) = core.subscribe_board(project).unwrap();
    let (_, other_rx) = core.subscribe_board(project + 100).unwrap();

    core.delete_thread(thread.id, false).unwrap();

    assert_eq!(next(&rx), BoardEvent::ThreadDeleted(thread.id));
    assert!(other_rx.try_recv().is_err());
}

#[test]
fn pending_approvals_are_on_the_card_and_answering_clears_them() {
    let (_dir, core, project) = core_with_project();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let on_approval = sender.clone();
    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ApprovalRequested {
                id: "appr-1".into(),
                kind: ApprovalKind::Command,
                summary: "Run `cargo test`".into(),
                options: vec!["allow-once".into()],
            });
        });
    });
    fake.on_approval(move |_, _| {
        let s = on_approval.clone();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_board(project).unwrap();

    core.send_prompt(thread.id, "please").unwrap();
    let card = loop {
        let BoardEvent::ThreadChanged(card) = next(&rx) else {
            panic!("expected ThreadChanged")
        };
        if card.thread.status == ThreadStatus::NeedsInput {
            break card;
        }
    };
    assert_eq!(card.pending_approvals.len(), 1);
    assert_eq!(card.pending_approvals[0].summary, "Run `cargo test`");

    core.respond_to_approval(thread.id, "appr-1", ApprovalDecision::Allow)
        .unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx) else {
            panic!("expected ThreadChanged")
        };
        if card.thread.status == ThreadStatus::Completed {
            assert!(card.pending_approvals.is_empty());
            break;
        }
    }
}

#[test]
fn renaming_and_stopping_a_thread_reach_the_board() {
    let (_dir, core, project) = core_with_project();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
    });
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_board(project).unwrap();

    core.rename_thread(thread.id, "Fix login").unwrap();
    let BoardEvent::ThreadChanged(card) = next(&rx) else {
        panic!("expected ThreadChanged")
    };
    assert_eq!(card.thread.title.as_deref(), Some("Fix login"));

    core.send_prompt(thread.id, "go").unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx) else {
            panic!("expected ThreadChanged")
        };
        if card.thread.status == ThreadStatus::Working {
            break;
        }
    }
    core.interrupt_thread(thread.id).unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx) else {
            panic!("expected ThreadChanged")
        };
        if card.thread.status == ThreadStatus::Interrupted {
            break;
        }
    }
}

#[test]
fn subscribing_to_the_board_spawns_no_gh_subprocesses() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "T"],
        &["config", "user.email", "t@example.com"],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&work)
                .status()
                .unwrap()
                .success()
        );
    }
    std::fs::write(work.join("a.txt"), "x\n").unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&work)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        std::process::Command::new("git")
            .args(["commit", "-qm", "first"])
            .current_dir(&work)
            .status()
            .unwrap()
            .success()
    );

    let fake_gh_dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/gh"));
    let gh_dir = tmp.path().join("gh");
    std::fs::create_dir_all(&gh_dir).unwrap();
    for name in ["gh", "gh.cmd", "gh.py"] {
        std::fs::copy(fake_gh_dir.join(name), gh_dir.join(name)).unwrap();
    }
    std::fs::write(gh_dir.join("state.json"), r#"{"auth":"ok","prs":{}}"#).unwrap();

    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    let _thread = core
        .dispatch_thread(oxide_core::DispatchRequest {
            project_id: project.id,
            prompt: "Add search".into(),
            provider: "fake".into(),
            model: None,
            effort: None,
            permission_mode: None,
            base_branch: Some("main".into()),
            issue_number: None,
            issue_title: None,
            issue_url: None,
            issue_labels: Vec::new(),
        })
        .unwrap();

    let (_snapshot, _rx) = core.subscribe_board(project.id).unwrap();
    std::thread::sleep(Duration::from_millis(500));

    let calls_dir = gh_dir.join("calls");
    let count = std::fs::read_dir(&calls_dir)
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(count, 0, "subscribe_board should not spawn gh subprocesses");
}
