//! Oxide's home holds its database and tool downloads: other local accounts must not read it.
//! File modes exist on Unix only: on Windows the ACLs of the user's profile keep the home private,
//! so every test here returns early there.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]

mod support;

use oxide_core::Core;
use std::fs;
use std::path::Path;
use support::{mode, set_mode};

fn files_in(dir: &Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .collect()
}

#[test]
fn a_fresh_home_is_private_and_so_are_its_files() {
    if !support::unix_only("file modes") {
        return;
    }
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    // A second open applies a second migration, which writes a backup of the database.
    drop(Core::open_with_migrations(&home, &["CREATE TABLE a (x INTEGER);"]).unwrap());
    drop(
        Core::open_with_migrations(
            &home,
            &["CREATE TABLE a (x INTEGER);", "CREATE TABLE b (x INTEGER);"],
        )
        .unwrap(),
    );

    assert_eq!(mode(&home), 0o700);
    let files = files_in(&home);
    let names: Vec<String> = files
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().any(|n| n == "oxide.db"),
        "oxide.db in {names:?}"
    );
    for file in files {
        assert_eq!(mode(&file), 0o600, "{}", file.display());
    }
}

#[test]
fn an_existing_loose_home_is_tightened_at_startup() {
    if !support::unix_only("file modes") {
        return;
    }
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    let nested = home.join("notes").join("7");
    fs::create_dir_all(&nested).unwrap();
    let pasted = nested.join("shot.png");
    fs::write(&pasted, "x").unwrap();
    let tool = home.join("tool.sh");
    fs::write(&tool, "#!/bin/sh\n").unwrap();
    set_mode(&home, 0o755);
    set_mode(&nested, 0o755);
    set_mode(&pasted, 0o644);
    set_mode(&tool, 0o755);
    for file in files_in(&home) {
        if file != tool {
            set_mode(&file, 0o644);
        }
    }
    // The walk runs once per home; a home from before it existed has no marker.
    fs::remove_file(home.join(".private-v1")).unwrap();

    drop(Core::open(&home).unwrap());

    assert_eq!(mode(&home), 0o700);
    assert_eq!(mode(&nested), 0o700);
    assert_eq!(mode(&pasted), 0o600);
    assert_eq!(mode(&tool), 0o700, "the owner keeps the execute bit");
    for file in files_in(&home) {
        assert_eq!(mode(&file) & 0o077, 0, "{}", file.display());
    }
}

#[test]
fn the_walk_runs_once_and_never_enters_old_checkouts_or_tools() {
    if !support::unix_only("file modes") {
        return;
    }
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    let checkout_file = home.join("worktrees/proj/feature/src/lib.rs");
    let tool_file = home.join("tools/node/bin/node");
    for file in [&checkout_file, &tool_file] {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "x").unwrap();
        set_mode(file, 0o755);
        set_mode(file.parent().unwrap(), 0o755);
    }
    let notes_dir = home.join("notes/1");
    fs::create_dir_all(&notes_dir).unwrap();
    set_mode(&notes_dir, 0o755);

    // The marker exists from the first open: nothing below the home is walked again.
    drop(Core::open(&home).unwrap());
    assert_eq!(mode(&notes_dir), 0o755, "the walk ran a second time");

    // A home without the marker is walked, but old checkouts and tools are left as they are.
    fs::remove_file(home.join(".private-v1")).unwrap();
    drop(Core::open(&home).unwrap());
    assert_eq!(mode(&notes_dir), 0o700);
    assert_eq!(mode(&checkout_file), 0o755);
    assert_eq!(mode(checkout_file.parent().unwrap()), 0o755);
    assert_eq!(mode(&tool_file), 0o755);
    assert_eq!(mode(tool_file.parent().unwrap()), 0o755);
}

#[test]
fn a_path_that_refuses_a_change_does_not_stop_the_start() {
    if !support::unix_only("file modes") {
        return;
    }
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    // A dangling symlink and a directory without read permission are not Oxide's to fix.
    support::symlink(Path::new("/nonexistent/target"), &home.join("dangling"));
    let locked = home.join("notes/locked");
    fs::create_dir_all(&locked).unwrap();
    set_mode(&locked, 0o000);
    fs::remove_file(home.join(".private-v1")).unwrap();

    let opened = Core::open(&home);

    set_mode(&locked, 0o700);
    assert!(opened.is_ok());
}
