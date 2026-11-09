#![cfg(unix)]

mod support;

use oxide_core::{
    ItemKind, PermissionMode, ProjectServiceStatus, ThreadEvent, ThreadStatus, TurnStatus,
};
use oxide_provider::process::group_alive;
use oxide_provider::{ActivityCategory, CommandOutcome, FakeProvider, ProviderEvent};
use std::time::Duration;
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
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
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
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
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
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
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
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
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
