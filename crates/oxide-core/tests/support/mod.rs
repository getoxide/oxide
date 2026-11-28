//! Per-OS helpers for Oxide Core's tests (ADR-0019). This is the only test code that may name an
//! OS-only API, so the tests themselves carry no OS conditional code and every OS type-checks them.
//! A test that only makes sense on one OS returns early with `if !cfg!(unix) { return; }`.
#![allow(
    dead_code,
    reason = "each test crate includes this module and uses only some of its helpers"
)]
#![allow(
    clippy::panic,
    reason = "test support: a failed fixture step is a test failure"
)]

use std::io;
use std::path::Path;

/// Creates the symbolic link `link` pointing at `target`, which may be missing (a dangling link).
/// Windows needs to know whether the target is a directory, and refuses without the privilege to
/// create links; callers so far run on Unix only.
pub fn symlink(target: &Path, link: &Path) {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    if let Err(error) = made {
        panic!(
            "symlink {} -> {}: {error}",
            link.display(),
            target.display()
        );
    }
}

/// The permission bits (`0o777`) of `path`. File modes exist on Unix only.
#[cfg(unix)]
pub fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.permissions().mode() & 0o777,
        Err(error) => panic!("metadata of {}: {error}", path.display()),
    }
}

/// File modes exist on Unix only.
#[cfg(windows)]
pub fn mode(path: &Path) -> u32 {
    panic!(
        "{} has no file mode: modes exist on Unix only",
        path.display()
    )
}

/// Sets the permission bits of `path` to `mode`. File modes exist on Unix only.
#[cfg(unix)]
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// File modes exist on Unix only.
#[cfg(windows)]
pub fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "file modes exist on Unix only",
    ))
}
