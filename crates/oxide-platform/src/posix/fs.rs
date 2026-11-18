//! Files private to the user, and reads that cannot hang, on Unix.

use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Present in the home once the full walk of [`prepare_private_home`] has run.
const WALKED_MARKER: &str = ".private-v1";

/// Top-level folders the walk never enters: other people's checkouts and installed tools.
/// Their modes belong to Git and to the tools (`node_modules` binaries need their group and
/// other bits), not to Oxide.
const NOT_OURS: [&str; 2] = ["worktrees", "tools"];

/// Creates `home` (and missing parents) and makes it `0700`. The first time it runs in a home
/// (no marker file yet) it also walks the home once: directories become `0700`, files lose their
/// group and other bits (an owner execute bit stays), except under the folders that belong to
/// Git and to installed tools. Later runs only look at the files directly in the home, where the
/// database and its sidecars appear. Symlinks are left alone, and a path that vanishes or
/// refuses a change is logged, never fatal: a looser mode must not stop Oxide from starting.
pub fn prepare_private_home(home: &Path) -> io::Result<()> {
    create_private_dir_all(home)?;
    let marker = home.join(WALKED_MARKER);
    tolerate(home, set_mode(home, |_| 0o700));
    if fs::symlink_metadata(&marker).is_ok() {
        tighten_files(home);
    } else {
        tighten_tree(home, true);
        tolerate(&marker, create_private_file(&marker).map(drop));
    }
    Ok(())
}

/// Creates `dir` and its missing parents; the new directories are `0700`.
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    builder.mode(0o700);
    builder.create(dir)
}

/// Creates (or truncates) `path` for writing; a new file is `0600`.
pub fn create_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

/// Creates `path` for writing and fails if it exists; the new file is `0600`.
pub fn create_new_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Opens `path` for reading without waiting for a writer, so a FIFO or a device cannot hang
/// the caller; the caller checks that it is a regular file.
pub fn open_nonblocking(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

/// Logs a failure on `path` unless the path is already gone.
fn tolerate(path: &Path, result: io::Result<()>) {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("could not tighten {}: {e}", path.display()),
        Ok(()) => {}
    }
}

fn entries(dir: &Path) -> Vec<(PathBuf, fs::Metadata)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(|entry| {
        let path = entry.ok()?.path();
        // A file can vanish between listing and inspection (a temp file renamed away).
        let meta = fs::symlink_metadata(&path).ok()?;
        Some((path, meta))
    })
    .collect()
}

/// Files directly inside `dir`: no group or other bits.
fn tighten_files(dir: &Path) {
    for (path, meta) in entries(dir) {
        if meta.is_file() {
            tolerate(&path, set_mode(&path, |mode| mode & 0o700));
        }
    }
}

fn tighten_tree(dir: &Path, top: bool) {
    for (path, meta) in entries(dir) {
        if meta.is_dir() {
            let skipped = top
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| NOT_OURS.contains(&name));
            if !skipped {
                tolerate(&path, set_mode(&path, |_| 0o700));
                tighten_tree(&path, false);
            }
        } else if meta.is_file() {
            tolerate(&path, set_mode(&path, |mode| mode & 0o700));
        }
    }
}

fn set_mode(path: &Path, to: impl Fn(u32) -> u32) -> io::Result<()> {
    let mode = fs::metadata(path)?.permissions().mode() & 0o7777;
    if to(mode) != mode {
        fs::set_permissions(path, fs::Permissions::from_mode(to(mode)))?;
    }
    Ok(())
}
