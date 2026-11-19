//! Oxide is Projects and plain terminals: a terminal is a shell in a Project's folder, a Project
//! can hold several, and closing the Project ends them all (ADR-0018).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
use oxide_core::Core;
use rusqlite::Connection;
use std::path::Path;

fn open_with_project(dir: &Path) -> (Core, u32, std::path::PathBuf) {
    let core = Core::open(dir.join("home")).unwrap();
    let folder = dir.join("my-project");
    std::fs::create_dir_all(folder.join(".git")).unwrap();
    let canonical = folder.canonicalize().unwrap();
    let id = core.add_project(&folder.to_string_lossy()).unwrap().id;
    (core, id, canonical)
}

#[test]
fn a_new_terminal_is_a_shell_in_the_projects_folder() {
    // The shell input below is POSIX, so these tests do not run on Windows.
    if cfg!(windows) {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (core, project, folder) = open_with_project(tmp.path());

    let terminal = core.start_block_terminal(project).unwrap();

    assert_eq!(
        Path::new(&terminal.cwd).canonicalize().unwrap(),
        folder,
        "the shell starts in the Project's folder"
    );
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn a_project_holds_several_terminals_each_with_its_own_shell() {
    // The shell input below is POSIX, so these tests do not run on Windows.
    if cfg!(windows) {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (core, project, _) = open_with_project(tmp.path());

    let first = core.start_block_terminal(project).unwrap();
    let second = core.start_block_terminal(project).unwrap();

    assert_ne!(first.id, second.id);
    assert_ne!(first.pid, second.pid, "each terminal runs its own shell");
    core.close_terminal(first.id).unwrap();
    core.write_terminal(second.id, b"true\n")
        .expect("closing one terminal leaves the other running");
    core.close_terminal(second.id).unwrap();
}

#[test]
fn closing_a_terminal_ends_its_shell() {
    // The shell input below is POSIX, so these tests do not run on Windows.
    if cfg!(windows) {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (core, project, _) = open_with_project(tmp.path());
    let terminal = core.start_block_terminal(project).unwrap();

    core.close_terminal(terminal.id).unwrap();

    assert!(core.write_terminal(terminal.id, b"true\n").is_err());
    assert!(core.close_terminal(terminal.id).is_err(), "already closed");
}

#[test]
fn closing_a_project_ends_all_its_terminals_and_keeps_it_known() {
    // The shell input below is POSIX, so these tests do not run on Windows.
    if cfg!(windows) {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (core, project, _) = open_with_project(tmp.path());
    let other_folder = tmp.path().join("other");
    std::fs::create_dir_all(other_folder.join(".git")).unwrap();
    let other = core
        .add_project(&other_folder.to_string_lossy())
        .unwrap()
        .id;
    let first = core.start_block_terminal(project).unwrap();
    let second = core.start_block_terminal(project).unwrap();
    let elsewhere = core.start_block_terminal(other).unwrap();

    core.set_project_open(project, false).unwrap();

    assert!(core.write_terminal(first.id, b"true\n").is_err());
    assert!(core.write_terminal(second.id, b"true\n").is_err());
    core.write_terminal(elsewhere.id, b"true\n")
        .expect("another Project's terminal keeps running");
    let projects = core.list_projects().unwrap();
    let closed = projects.iter().find(|p| p.id == project).unwrap();
    assert!(!closed.open, "the Project leaves the sidebar");
    core.close_terminal(elsewhere.id).unwrap();
}

#[test]
fn an_older_database_is_adopted_keeping_projects_and_leaving_folders_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let worktree = tmp.path().join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let db = tmp.path().join("oxide.db");
    let old_version = 40;
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE projects (
                 id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
                 created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
                 hidden INTEGER NOT NULL DEFAULT 0, opened_at TEXT,
                 acted_upon INTEGER NOT NULL DEFAULT 0, setup_command TEXT,
                 verification_commands TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE threads (
                 id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
                 worktree_path TEXT, branch TEXT
             );
             CREATE TABLE turns (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id));
             CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO projects (id, name, path, opened_at) VALUES (1, 'p', '/p', '2026-01-01T00:00:00Z');
             INSERT INTO threads (id, project_id, worktree_path, branch) VALUES (7, 1, '{}', 'oxide/feature');
             INSERT INTO turns (id, thread_id) VALUES (1, 7);
             INSERT INTO app_state (key, value) VALUES ('selection', '[1,7]'), ('favourite_models', '[]');
             PRAGMA user_version = {old_version};",
            worktree.display()
        ))
        .unwrap();
    }

    let core = Core::open(tmp.path()).unwrap();

    let projects = core.list_projects().unwrap();
    assert_eq!(projects.len(), 1, "the Project is still known");
    assert!(projects[0].open, "and still open in the sidebar");
    assert_eq!(core.last_selection().unwrap(), Some(1));
    let conn = Connection::open(&db).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    let fresh = tempfile::tempdir().unwrap();
    drop(Core::open(fresh.path()).unwrap());
    let fresh_tables: Vec<String> = Connection::open(fresh.path().join("oxide.db"))
        .unwrap()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    let (mut tables, mut fresh_tables) = (tables, fresh_tables);
    tables.sort();
    fresh_tables.sort();
    assert_eq!(tables, fresh_tables, "same tables as a fresh install");
    let favourites: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM app_state WHERE key = 'favourite_models'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(favourites, 0, "settings of removed features are dropped");
    assert!(worktree.is_dir(), "a worktree folder is never deleted");
    let backup = tmp.path().join(format!("oxide.db.bak-{old_version}"));
    assert!(backup.exists(), "the old data was backed up first");
    let backed_up: i64 = Connection::open(&backup)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM turns", [], |r| r.get(0))
        .unwrap();
    assert_eq!(backed_up, 1, "the backup still holds the old data");
}
