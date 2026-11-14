use oxide_core::{Core, PermissionMode, ThreadEvent};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project_id = core.add_project(&project_dir.to_string_lossy()).unwrap().id;

    (dir, core, project_id)
}

// ── Slice 1: Unknown events are persisted ────────────────────────────────────

#[test]
fn unknown_events_are_persisted_in_transcript() {
    let (dir, core, project_id) = setup();

    let fake = FakeProvider::default();
    let sender = fake.sender();

    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::Unknown {
                raw: r#"{"type":"mystery","data":42}"#.into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
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
    core.send_prompt(thread.id, "go").unwrap();

    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { .. } = evt.event {
            break;
        }
    }

    let regular_snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert!(regular_snapshot.turns[0].unknown_events.is_empty());

    let db = rusqlite::Connection::open(dir.path().join("oxide.db")).unwrap();
    let stored: Vec<String> = db
        .prepare("SELECT raw FROM unknown_events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(stored, [r#"{"type":"mystery","data":42}"#]);
}

// ── Slice 2: No raw payloads cross IPC ───────────────────────────────────────

#[test]
fn regular_subscriber_receives_no_raw_payload() {
    let (_dir, core, project_id) = setup();

    let fake = FakeProvider::default();
    let sender = fake.sender();

    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ItemDelta {
                item_index: 0,
                delta: "hello".into(),
            });
            let _ = s.send(ProviderEvent::Unknown {
                raw: r#"{"secret":"payload"}"#.into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
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
    core.send_prompt(thread.id, "go").unwrap();

    let mut saw_unknown = false;
    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        match &evt.event {
            ThreadEvent::Unknown => {
                saw_unknown = true;
            }
            ThreadEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(
        saw_unknown,
        "Unknown event should still arrive on regular channel"
    );
}
