#![cfg(unix)]

mod support;

use oxide_core::{
    Core, ItemKind, PermissionMode, ProjectServiceStatus, ThreadEvent, ThreadStatus, TurnStatus,
};
use oxide_provider::process::group_alive;
use oxide_provider::{
    ActivityCategory, ApprovalDecision, ApprovalKind, CommandOutcome, FakeProvider, ProviderEvent,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
use support::{free_port, open_core_with_project, started, wait_group_gone};
use tempfile::tempdir;

/// Every TurnCompleted the Thread emits, up to a short quiet period after the first one.
fn completed_turns(
    rx: &crossbeam_channel::Receiver<oxide_core::SequencedThreadEvent>,
) -> Vec<(TurnStatus, Option<String>)> {
    let mut turns = Vec::new();
    // The first one can take a while: a detached command waits out the service startup check.
    let first = loop {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(event) => {
                if let ThreadEvent::TurnCompleted { status, error, .. } = event.event {
                    break Some((status, error.map(|error| error.message)));
                }
            }
            Err(_) => break None,
        }
    };
    let Some(first) = first else {
        return turns;
    };
    turns.push(first);
    // Anything the Provider says about the Turn afterwards must not become a second end.
    while let Ok(event) = rx.recv_timeout(Duration::from_millis(300)) {
        if let ThreadEvent::TurnCompleted { status, error, .. } = event.event {
            turns.push((status, error.map(|error| error.message)));
        }
    }
    turns
}

#[test]
fn an_agent_server_command_detaches_and_the_turn_completes_without_the_provider() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let sender = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::ToolCall,
                parent_item_index: None,
                category: Some(ActivityCategory::Run),
            });
            let _ = sender.send(ProviderEvent::CommandRequested {
                item_index: 0,
                command: "sleep 30".into(),
            });
            // The adapter would normally report the command's completion and the Turn's own
            // end. Neither arrives here: the service never exits, so Oxide must finish the
            // Turn on its own.
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::FullAccess)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "start the dev server").unwrap();

    let turns = completed_turns(&rx);
    assert_eq!(
        turns,
        vec![(TurnStatus::Completed, None)],
        "the Turn completes exactly once, not as the Provider's later Interrupted"
    );

    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Completed);
    let turn = &snapshot.turns[0];
    assert_eq!(turn.status, TurnStatus::Completed);
    let item = turn
        .items
        .iter()
        .find(|item| item.kind == ItemKind::ToolCall)
        .expect("the command has a tool-call Item");
    assert!(
        item.content
            .starts_with("[Oxide] Started Project Service 'sleep 30'"),
        "the agent sees the service notice: {}",
        item.content
    );
    assert!(item.content.contains("(PID "), "the notice has the PID");
    // The Provider never ran this command; Oxide only intercepted the request.
    assert_eq!(item.command.outcome, CommandOutcome::Unknown);
    assert_eq!(item.command.exit_code, None);

    let services = core.list_project_services(project_id).unwrap();
    assert_eq!(services.len(), 1);
    let service = &services[0];
    assert_eq!(service.project_id, project_id);
    assert_eq!(service.thread_id, Some(thread.id));
    assert_eq!(service.command, "sleep 30");
    assert_eq!(service.status, ProjectServiceStatus::Running);
    assert!(
        service.checkout.ends_with("my-project"),
        "the service keeps the Thread's checkout: {}",
        service.checkout
    );
    assert!(group_alive(service.pid as i32));

    let pid = service.pid;
    core.shutdown();
    assert!(wait_group_gone(pid), "shutdown stops the detached service");
}

#[test]
fn a_non_background_turn_is_untouched() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let sender = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                parent_item_index: None,
                category: None,
            });
            let _ = sender.send(ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                content: "All done.".into(),
                parent_item_index: None,
                category: None,
                command: None,
            });
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::FullAccess)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "say hello").unwrap();

    let turns = completed_turns(&rx);
    assert_eq!(turns, vec![(TurnStatus::Completed, None)]);
    assert!(core.list_project_services(project_id).unwrap().is_empty());
    assert_eq!(
        core.get_thread_snapshot(thread.id).unwrap().thread.status,
        ThreadStatus::Completed
    );
}

#[test]
fn a_service_that_crashes_during_startup_fails_the_turn() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let sender = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::ToolCall,
                parent_item_index: None,
                category: Some(ActivityCategory::Run),
            });
            let _ = sender.send(ProviderEvent::CommandRequested {
                item_index: 0,
                command: "echo boom >&2; exit 7".into(),
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::FullAccess)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "start the broken server")
        .unwrap();

    let turns = completed_turns(&rx);
    assert_eq!(turns.len(), 1, "the Turn ends exactly once");
    assert_eq!(turns[0].0, TurnStatus::Error);
    let message = turns[0].1.as_deref().unwrap_or_default();
    assert!(
        message.contains("boom"),
        "the startup output is kept: {message}"
    );
    assert!(message.contains('7'), "the exit code is kept: {message}");

    assert!(core.list_project_services(project_id).unwrap().is_empty());
    assert_eq!(
        core.get_thread_snapshot(thread.id).unwrap().thread.status,
        ThreadStatus::Error
    );
}

#[test]
fn an_agent_command_on_a_port_held_by_a_service_reuses_it_and_completes() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let port = free_port();
    let incumbent = started(
        core.start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
            .unwrap(),
    );

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let sender = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::ToolCall,
                parent_item_index: None,
                category: Some(ActivityCategory::Run),
            });
            let _ = sender.send(ProviderEvent::CommandRequested {
                item_index: 0,
                command: format!("PORT={port} sleep 30"),
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::FullAccess)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "start the dev server").unwrap();

    let turns = completed_turns(&rx);
    assert_eq!(
        turns,
        vec![(TurnStatus::Completed, None)],
        "a port conflict is reported to the agent, not as a Turn error"
    );

    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Completed);
    let item = snapshot.turns[0]
        .items
        .iter()
        .find(|item| item.kind == ItemKind::ToolCall)
        .expect("the conflicted command has a tool-call Item");
    assert!(
        item.content.contains(&port.to_string()),
        "the notice names the port: {}",
        item.content
    );
    assert!(
        item.content.contains("sleep 30") && item.content.contains(&incumbent.pid.to_string()),
        "the notice names the incumbent command and PID: {}",
        item.content
    );
    assert!(
        item.content.contains(&format!("#{}", incumbent.id)),
        "the notice names the incumbent service id: {}",
        item.content
    );
    assert!(
        item.content.contains(&format!("http://localhost:{port}")),
        "the notice names the incumbent URL: {}",
        item.content
    );
    assert!(
        item.content.contains("already used by Project Service"),
        "the notice explains the reuse: {}",
        item.content
    );
    // The command was intercepted, never run by the Provider: no outcome is claimed.
    assert_eq!(item.command.outcome, CommandOutcome::Unknown);
    assert_eq!(item.command.exit_code, None);

    // No second service was spawned: the incumbent remains the only one.
    let services = core.list_project_services(project_id).unwrap();
    assert_eq!(services.len(), 1);
    assert_eq!(services[0].id, incumbent.id);

    core.shutdown();
}

// ---- Approval gate for detached commands (Ask and Auto-edit) ----

type Receiver = crossbeam_channel::Receiver<oxide_core::SequencedThreadEvent>;
type Answers = Arc<Mutex<Vec<(String, ApprovalDecision)>>>;

/// A Provider whose prompt starts a Turn and asks Oxide to detach `command`, nothing else.
/// `provider_approval` makes it also raise its own Approval for the command, as a real adapter
/// does once the CLI asks for permission; `answers` records what Core tells the Provider.
fn requesting_provider(
    command: &str,
    provider_approval: bool,
    answers: Answers,
) -> (FakeProvider, crossbeam_channel::Sender<ProviderEvent>) {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let prompt_sender = sender.clone();
    let command = command.to_string();
    fake.on_prompt(move |prompt| {
        let sender = prompt_sender.clone();
        let prompt = prompt.to_string();
        let command = command.clone();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::ToolCall,
                parent_item_index: None,
                category: Some(ActivityCategory::Run),
            });
            let _ = sender.send(ProviderEvent::CommandRequested {
                item_index: 0,
                command: command.clone(),
            });
            if provider_approval {
                let _ = sender.send(ProviderEvent::ApprovalRequested {
                    id: "provider-1".into(),
                    kind: ApprovalKind::Command,
                    summary: command,
                    options: vec!["allow".into(), "deny".into()],
                });
            }
        });
    });
    fake.on_approval(move |id, decision| {
        answers.lock().unwrap().push((id.to_string(), decision));
    });
    (fake, sender)
}

/// Waits for the next Approval the Thread raises and returns its id and summary.
fn next_approval(rx: &Receiver) -> (String, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while let Ok(event) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if let ThreadEvent::ApprovalRequested { id, summary, .. } = event.event {
            return (id, summary);
        }
    }
    panic!("the Thread never raised an Approval");
}

struct Asked {
    core: Core,
    project_id: u32,
    thread_id: u32,
    rx: Receiver,
    answers: Answers,
    sender: crossbeam_channel::Sender<ProviderEvent>,
    _dir: tempfile::TempDir,
}

fn asked(mode: PermissionMode, provider_approval: bool) -> Asked {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let answers = Answers::default();
    let (fake, sender) = requesting_provider("sleep 300 &", provider_approval, answers.clone());
    let thread = core
        .create_thread(project_id, "fake", None, None, mode)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "start the dev server").unwrap();
    Asked {
        core,
        project_id,
        thread_id: thread.id,
        rx,
        answers,
        sender,
        _dir: dir,
    }
}

#[test]
fn in_ask_and_auto_edit_a_detached_command_waits_for_an_oxide_approval() {
    for mode in [PermissionMode::Ask, PermissionMode::AutoEdit] {
        let a = asked(mode, false);
        let (id, summary) = next_approval(&a.rx);

        assert!(
            id.starts_with("oxide:"),
            "the id is reserved to Oxide: {id}"
        );
        assert!(
            summary.contains("sleep 300 &"),
            "names the full command line: {summary}"
        );
        assert!(summary.contains("Project Service"), "{summary}");
        assert!(
            summary.contains("outside the Provider's sandbox"),
            "{summary}"
        );

        let snapshot = a.core.get_thread_snapshot(a.thread_id).unwrap();
        assert_eq!(snapshot.thread.status, ThreadStatus::NeedsInput, "{mode:?}");
        assert_eq!(snapshot.turns[0].approvals.len(), 1);
        assert!(
            a.core
                .list_project_services(a.project_id)
                .unwrap()
                .is_empty(),
            "nothing starts before the user answers ({mode:?})"
        );
        a.core.shutdown();
    }
}

#[test]
fn allowing_the_oxide_approval_starts_the_service_and_finishes_the_turn() {
    let a = asked(PermissionMode::Ask, false);
    let (id, _) = next_approval(&a.rx);

    a.core
        .respond_to_approval(a.thread_id, &id, ApprovalDecision::Allow)
        .unwrap();

    assert_eq!(completed_turns(&a.rx), vec![(TurnStatus::Completed, None)]);
    let services = a.core.list_project_services(a.project_id).unwrap();
    assert_eq!(services.len(), 1);
    assert_eq!(services[0].command, "sleep 300");
    assert!(
        a.answers.lock().unwrap().is_empty(),
        "an Oxide-owned id never reaches the Provider"
    );
    let pid = services[0].pid;
    a.core.shutdown();
    assert!(wait_group_gone(pid));
}

#[test]
fn denying_the_oxide_approval_starts_nothing_and_ends_the_turn_quietly() {
    let a = asked(PermissionMode::Ask, false);
    let (id, _) = next_approval(&a.rx);

    a.core
        .respond_to_approval(a.thread_id, &id, ApprovalDecision::Deny)
        .unwrap();

    assert_eq!(completed_turns(&a.rx), vec![(TurnStatus::Completed, None)]);
    assert!(
        a.core
            .list_project_services(a.project_id)
            .unwrap()
            .is_empty()
    );
    assert!(a.answers.lock().unwrap().is_empty());
    let snapshot = a.core.get_thread_snapshot(a.thread_id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Completed);
    assert_eq!(
        snapshot.turns[0].approvals[0].decision,
        Some(ApprovalDecision::Deny)
    );
    let item = snapshot.turns[0]
        .items
        .iter()
        .find(|item| item.kind == ItemKind::ToolCall)
        .expect("the denied command stays in the Transcript");
    assert_eq!(item.command.line.as_deref(), Some("sleep 300 &"));
    assert!(
        !item.content.contains("Started Project Service"),
        "no service notice: {}",
        item.content
    );
    a.core.shutdown();
}

#[test]
fn a_turn_ending_with_the_approval_pending_counts_as_denied() {
    let a = asked(PermissionMode::Ask, false);
    let (id, _) = next_approval(&a.rx);

    let _ = a.sender.send(ProviderEvent::TurnCompleted {
        turn_index: 0,
        status: TurnStatus::Interrupted,
    });

    assert_eq!(
        completed_turns(&a.rx),
        vec![(TurnStatus::Interrupted, None)]
    );
    let snapshot = a.core.get_thread_snapshot(a.thread_id).unwrap();
    assert_eq!(
        snapshot.turns[0].approvals[0].decision,
        Some(ApprovalDecision::Deny)
    );
    // A late answer must not start anything, nor reach the Provider.
    let _ = a
        .core
        .respond_to_approval(a.thread_id, &id, ApprovalDecision::Allow);
    assert!(
        a.core
            .list_project_services(a.project_id)
            .unwrap()
            .is_empty()
    );
    assert!(a.answers.lock().unwrap().is_empty());
    a.core.shutdown();
}

#[test]
fn the_providers_own_approval_for_the_same_command_gets_the_users_answer() {
    for decision in [ApprovalDecision::Allow, ApprovalDecision::Deny] {
        let a = asked(PermissionMode::Ask, true);
        let (id, _) = next_approval(&a.rx);
        assert!(id.starts_with("oxide:"));
        // One prompt, not two: the Provider's own Approval is never shown.
        while let Ok(event) = a.rx.recv_timeout(Duration::from_millis(300)) {
            assert!(
                !matches!(event.event, ThreadEvent::ApprovalRequested { .. }),
                "a second prompt was raised"
            );
        }

        a.core
            .respond_to_approval(a.thread_id, &id, decision)
            .unwrap();

        assert_eq!(
            a.answers.lock().unwrap().clone(),
            vec![("provider-1".to_string(), decision)]
        );
        a.core.shutdown();
    }
}

#[test]
fn a_blind_review_ignores_a_detach_request() {
    use oxide_core::blind_review::BlindReviewRequest;
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&work)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.name", "Oxide Test"]);
    git(&["config", "user.email", "test@oxide.local"]);
    git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(work.join("a.rs"), "fn a() {}\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "initial"]);
    let core = Core::open(dir.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();

    let (review, prompt) = core
        .create_blind_review_thread(BlindReviewRequest {
            project_id: project.id,
            thread_id: None,
            provider: "fake".into(),
            model: None,
            effort: None,
            scope: "uncommitted".into(),
            turn_index: None,
            issue: None,
        })
        .unwrap();
    let (fake, _sender) = requesting_provider("sleep 300 &", false, Answers::default());
    core.register_fake_provider(review.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(review.id).unwrap();
    core.send_prompt(review.id, &prompt).unwrap();

    while let Ok(event) = rx.recv_timeout(Duration::from_millis(800)) {
        assert!(
            !matches!(event.event, ThreadEvent::ApprovalRequested { .. }),
            "a Blind review never asks to detach"
        );
    }
    assert!(core.list_project_services(project.id).unwrap().is_empty());
    core.shutdown();
}
