//! Files private to the user, and reads that cannot hang, on Windows. Windows keeps the profile
//! ACLs, so nothing is tightened.

use std::fs;
use std::io;
use std::path::Path;

/// Creates `home` (and missing parents). Windows keeps the profile ACLs.
pub fn prepare_private_home(home: &Path) -> io::Result<()> {
    create_private_dir_all(home)
}

/// Creates `dir` and its missing parents.
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

/// Creates (or truncates) `path` for writing.
pub fn create_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
}

/// Creates `path` for writing and fails if it exists.
pub fn create_new_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Opens `path` for reading. Windows has no FIFOs to hang on; the caller checks that it is a
/// regular file.
pub fn open_nonblocking(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().read(true).open(path)
}
