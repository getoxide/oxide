//! Oxide's home holds Transcripts, Attachments and settings, so on Unix it is readable by its
//! owner only: the home is `0700` and every file in it `0600`. Windows keeps the profile ACLs.

use std::fs;
use std::io;
use std::path::Path;

/// Present in the home once the full walk of [`prepare_home`] has run.
#[cfg(unix)]
const WALKED_MARKER: &str = ".private-v1";

/// Top-level folders the walk never enters: other people's checkouts and installed tools.
/// Their modes belong to Git and to the tools (`node_modules` binaries need their group and
/// other bits), not to Oxide.
#[cfg(unix)]
const NOT_OURS: [&str; 2] = ["worktrees", "tools"];

/// Creates `home` (and missing parents) and, on Unix, makes it `0700`. The first time it runs
/// in a home (no marker file yet) it also walks the home once: directories become `0700`, files
/// lose their group and other bits (an owner execute bit stays), except under [`NOT_OURS`].
/// Later runs only look at the files directly in the home, where the database and its sidecars
/// appear. Symlinks are left alone, and a path that vanishes or refuses a change is logged,
/// never fatal: a looser mode must not stop Oxide from starting.
pub(crate) fn prepare_home(home: &Path) -> io::Result<()> {
    create_dir_all(home)?;
    #[cfg(unix)]
    {
        let marker = home.join(WALKED_MARKER);
        tolerate(home, set_mode(home, |_| 0o700));
        if fs::symlink_metadata(&marker).is_ok() {
            tighten_files(home);
        } else {
            tighten_tree(home, true);
            tolerate(&marker, create_file(&marker).map(drop));
        }
    }
    Ok(())
}

/// Logs a failure on `path` unless the path is already gone.
#[cfg(unix)]
fn tolerate(path: &Path, result: io::Result<()>) {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("could not tighten {}: {e}", path.display()),
        Ok(()) => {}
    }
}

#[cfg(unix)]
fn entries(dir: &Path) -> Vec<(std::path::PathBuf, fs::Metadata)> {
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
#[cfg(unix)]
fn tighten_files(dir: &Path) {
    for (path, meta) in entries(dir) {
        if meta.is_file() {
            tolerate(&path, set_mode(&path, |mode| mode & 0o700));
        }
    }
}

#[cfg(unix)]
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

/// Creates `dir` and its missing parents; on Unix the new directories are `0700`.
pub(crate) fn create_dir_all(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

#[cfg(unix)]
fn set_mode(path: &Path, to: impl Fn(u32) -> u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)?.permissions().mode() & 0o7777;
    if to(mode) != mode {
        fs::set_permissions(path, fs::Permissions::from_mode(to(mode)))?;
    }
    Ok(())
}

/// Creates (or truncates) `path` for writing; on Unix a new file is `0600`.
pub(crate) fn create_file(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Like [`fs::write`], with the file private to the user.
pub(crate) fn write(path: &Path, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    use std::io::Write as _;
    create_file(path)?.write_all(bytes.as_ref())
}
