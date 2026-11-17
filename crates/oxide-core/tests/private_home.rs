//! Oxide's home holds Transcripts, Attachments and settings: other local accounts must not read it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#![cfg(unix)]

use oxide_core::{Core, LanguageServerConfig};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn files_in(dir: &Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .collect()
}

#[test]
fn a_fresh_home_is_private_and_so_are_its_files() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    // A second open applies a second migration, which writes a backup of the database.
    drop(Core::open_with_migrations(&home, &["CREATE TABLE a (x INTEGER);"]).unwrap());
    let core = Core::open_with_migrations(
        &home,
        &["CREATE TABLE a (x INTEGER);", "CREATE TABLE b (x INTEGER);"],
    )
    .unwrap();
    core.configure_language_server(
        "rust",
        LanguageServerConfig {
            command: "/bin/sh".into(),
            args: vec![],
            interpreter: None,
        },
    )
    .unwrap();
    core.save_settings(&core.settings().settings).unwrap();

    assert_eq!(mode(&home), 0o700);
    let files = files_in(&home);
    let names: Vec<String> = files
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for expected in ["oxide.db", "settings.json", "language-servers.json"] {
        assert!(
            names.iter().any(|n| n == expected),
            "{expected} in {names:?}"
        );
    }
    for file in files {
        assert_eq!(mode(&file), 0o600, "{}", file.display());
    }
}

#[test]
fn an_existing_loose_home_is_tightened_at_startup() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    let nested = home.join("attachments").join("7");
    fs::create_dir_all(&nested).unwrap();
    let pasted = nested.join("shot.png");
    fs::write(&pasted, "x").unwrap();
    let tool = home.join("tool.sh");
    fs::write(&tool, "#!/bin/sh\n").unwrap();
    let loose = |path: &Path, m: u32| fs::set_permissions(path, fs::Permissions::from_mode(m));
    loose(&home, 0o755).unwrap();
    loose(&nested, 0o755).unwrap();
    loose(&pasted, 0o644).unwrap();
    loose(&tool, 0o755).unwrap();
    for file in files_in(&home) {
        if file != tool {
            loose(&file, 0o644).unwrap();
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
fn the_walk_runs_once_and_never_enters_worktrees_or_tools() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    let worktree_file = home.join("worktrees/proj/feature/src/lib.rs");
    let tool_file = home.join("tools/node/bin/node");
    for file in [&worktree_file, &tool_file] {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "x").unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(file.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let attachment_dir = home.join("attachments/1");
    fs::create_dir_all(&attachment_dir).unwrap();
    fs::set_permissions(&attachment_dir, fs::Permissions::from_mode(0o755)).unwrap();

    // The marker exists from the first open: nothing below the home is walked again.
    drop(Core::open(&home).unwrap());
    assert_eq!(mode(&attachment_dir), 0o755, "the walk ran a second time");

    // A home without the marker is walked, but worktrees and tools are left as they are.
    fs::remove_file(home.join(".private-v1")).unwrap();
    drop(Core::open(&home).unwrap());
    assert_eq!(mode(&attachment_dir), 0o700);
    assert_eq!(mode(&worktree_file), 0o755);
    assert_eq!(mode(worktree_file.parent().unwrap()), 0o755);
    assert_eq!(mode(&tool_file), 0o755);
    assert_eq!(mode(tool_file.parent().unwrap()), 0o755);
}

#[test]
fn a_path_that_refuses_a_change_does_not_stop_the_start() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    drop(Core::open(&home).unwrap());
    // A dangling symlink and a directory without read permission are not Oxide's to fix.
    std::os::unix::fs::symlink("/nonexistent/target", home.join("dangling")).unwrap();
    let locked = home.join("attachments/locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    fs::remove_file(home.join(".private-v1")).unwrap();

    let opened = Core::open(&home);

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(opened.is_ok());
}
