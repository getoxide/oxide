use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{Core, PermissionMode, SequencedThreadEvent, ThreadEvent, ThreadStatus};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
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

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project_id: u32,
    work: PathBuf,
    /// Per Thread, where its fake Provider receives each Turn's edit.
    gates: Mutex<HashMap<u32, Sender<Edit>>>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let scan = root.join("scan");
    let work = scan.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    std::fs::write(work.join("b.txt"), "keep\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    // Checkpoints are tested against the main checkout, so keep Threads out of worktrees here.
    let db = rusqlite::Connection::open(root.join("home/oxide.db")).unwrap();
    db.execute(
        "UPDATE projects SET threads_in_main_checkout = 1 WHERE id = ?1",
        [project_id],
    )
    .unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
        gates: Mutex::default(),
    }
}

type Edit = Box<dyn FnOnce() + Send>;

/// A fake whose every Turn starts, then waits for an edit on `release`, runs it and completes.
fn gated_fake(release: Receiver<Edit>) -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let (sender, release) = (sender.clone(), release.clone());
        let prompt = prompt.to_string();
        // Off the actor's thread, which must stay free to take the Checkpoints.
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            release.recv().unwrap()();
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    fake
}

fn wait_for(rx: &Receiver<SequencedThreadEvent>, accept: impl Fn(&ThreadEvent) -> bool) {
    loop {
        let evt = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("timed out waiting for a thread event");
        if accept(&evt.event) {
            return;
        }
    }
}

fn is_started(e: &ThreadEvent) -> bool {
    matches!(e, ThreadEvent::TurnStarted { .. })
}

fn is_completed(e: &ThreadEvent) -> bool {
    matches!(
        e,
        ThreadEvent::ThreadStatusChanged {
            status: ThreadStatus::Completed
        }
    )
}

/// Runs one Turn whose edit is `edit`; returns once it is completed.
fn run_turn(f: &Fixture, thread_id: u32, edit: impl FnOnce() + Send + 'static) {
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_started);
    f.gates.lock().unwrap()[&thread_id]
        .send(Box::new(edit))
        .unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_completed);
}

fn new_thread(f: &Fixture) -> u32 {
    let id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let (gate, release) = unbounded();
    f.core.register_fake_provider(id, gated_fake(release));
    f.gates.lock().unwrap().insert(id, gate);
    id
}

/// Everything a Checkpoint must leave alone, as bytes.
fn user_state(work: &Path) -> Vec<String> {
    vec![
        std::fs::read(work.join(".git/index"))
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        git(work, &["rev-parse", "HEAD"]),
        git(
            work,
            &["for-each-ref", "refs/heads", "refs/stash", "refs/remotes"],
        ),
        git(work, &["stash", "list"]),
        git(work, &["status", "--porcelain=v1"]),
    ]
}

fn checkpoint_refs(work: &Path) -> Vec<String> {
    git(
        work,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/oxide/checkpoints",
        ],
    )
    .lines()
    .map(str::to_string)
    .collect()
}

#[test]
fn checkpoints_leave_index_stash_head_and_branches_byte_for_byte_unchanged() {
    let f = fixture();
    let thread_id = new_thread(&f);
    // A stash entry, a staged change, an unstaged one and an untracked file.
    std::fs::write(f.work.join("a.txt"), "stashed\n").unwrap();
    git(&f.work, &["stash", "-q"]);
    std::fs::write(f.work.join("a.txt"), "staged\n").unwrap();
    git(&f.work, &["add", "a.txt"]);
    std::fs::write(f.work.join("b.txt"), "unstaged\n").unwrap();
    std::fs::write(f.work.join("untracked.txt"), "u\n").unwrap();
    let before = user_state(&f.work);

    // The Turn itself changes nothing in the checkout.
    run_turn(&f, thread_id, || {});

    assert_eq!(checkpoint_refs(&f.work).len(), 2);
    assert_eq!(user_state(&f.work), before);
}

#[test]
fn the_turn_picks_name_each_turn_by_position_and_prompt_and_tell_which_have_checkpoints() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\nfirst\n").unwrap()
    });
    run_turn(&f, thread_id, || {});

    let picks = f.core.turn_picks(thread_id).unwrap();
    assert_eq!(
        picks.iter().map(|p| p.turn_index).collect::<Vec<_>>(),
        [0, 1]
    );
    assert!(picks.iter().all(|p| p.checkpointed && !p.prompt.is_empty()));

    // Checkpoints are refs in the checkout; without them a Turn has nothing to diff.
    for name in checkpoint_refs(&f.work) {
        git(&f.work, &["update-ref", "-d", &name]);
    }
    let picks = f.core.turn_picks(thread_id).unwrap();
    assert!(picks.iter().all(|p| !p.checkpointed));
}
