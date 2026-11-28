//! Files private to the user, and reads that cannot hang.
//!
//! "Private" means modes `0700`/`0600` on Unix; Windows keeps the ACLs of the user's profile, which
//! already make the Oxide home private.

use crate::imp::fs as imp;
use std::fs::File;
use std::io;
use std::path::Path;

/// Creates the Oxide home `home` (and missing parents) and makes it private. On Unix the first run
/// in a home also tightens what an older version left in it; a path that refuses a change is
/// logged, never fatal: a looser mode must not stop Oxide from starting.
pub fn prepare_private_home(home: &Path) -> io::Result<()> {
    imp::prepare_private_home(home)
}

/// Creates `dir` and its missing parents; the new directories are private.
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    imp::create_private_dir_all(dir)
}

/// Makes the existing directory `dir` private, whatever mode it was created with.
pub fn restrict_dir_to_owner(dir: &Path) -> io::Result<()> {
    imp::restrict_dir_to_owner(dir)
}

/// Creates (or truncates) `path` for writing; a new file is private.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    imp::create_private_file(path)
}

/// Creates `path` for writing and fails if it exists; the new file is private.
pub fn create_new_private_file(path: &Path) -> io::Result<File> {
    imp::create_new_private_file(path)
}

/// Lets the owner run the file `path` (`0755` on Unix). Windows runs a file by its extension, so
/// there is nothing to change.
pub fn make_executable(path: &Path) -> io::Result<()> {
    imp::make_executable(path)
}

/// Opens `path` for reading without waiting for a writer, so a FIFO or a device cannot hang the
/// caller; the caller checks that it is a regular file.
pub fn open_nonblocking(path: &Path) -> io::Result<File> {
    imp::open_nonblocking(path)
}
