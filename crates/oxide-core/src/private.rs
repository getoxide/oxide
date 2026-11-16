//! Oxide's home holds Transcripts, Attachments and settings, so on Unix it is readable by its
//! owner only: the home is `0700` and every file in it `0600`. Windows keeps the profile ACLs.

use std::fs;
use std::io;
use std::path::Path;

/// Creates `home` (and missing parents) and, on Unix, tightens it and everything inside it once:
/// directories become `0700`, files lose their group and other bits (an owner execute bit stays,
/// so installed language tools keep running). Symlinks are left alone.
pub(crate) fn prepare_home(home: &Path) -> io::Result<()> {
    create_dir_all(home)?;
    #[cfg(unix)]
    tighten(home)?;
    Ok(())
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
fn tighten(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    set_mode(dir, |_| 0o700)?;
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        // A file can vanish between listing and inspection (a temp file renamed away).
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            tighten(&path)?;
        } else if meta.is_file() && meta.permissions().mode() & 0o077 != 0 {
            match set_mode(&path, |mode| mode & 0o700) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                other => other?,
            }
        }
    }
    Ok(())
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
