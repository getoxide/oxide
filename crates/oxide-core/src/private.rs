//! Oxide's home holds Transcripts, Attachments and settings, so on Unix it is readable by its
//! owner only: the home is `0700` and every file in it `0600`. Windows keeps the profile ACLs.
//! How a file or folder is made private is the platform layer's (`oxide_platform::fs`).

use oxide_platform::fs;
use std::io;
use std::path::Path;

/// Creates `home` (and missing parents) and, on Unix, makes it `0700`, walking the home once to
/// tighten what is already in it. See `oxide_platform::fs::prepare_private_home`.
pub(crate) fn prepare_home(home: &Path) -> io::Result<()> {
    fs::prepare_private_home(home)
}

/// Creates (or truncates) `path` for writing; on Unix a new file is `0600`.
pub(crate) fn create_file(path: &Path) -> io::Result<std::fs::File> {
    fs::create_private_file(path)
}

/// Like [`std::fs::write`], with the file private to the user.
pub(crate) fn write(path: &Path, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    use std::io::Write as _;
    create_file(path)?.write_all(bytes.as_ref())
}
