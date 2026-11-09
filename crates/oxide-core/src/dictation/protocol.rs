//! Framing and lifecycle constants shared by every out-of-process worker.
//!
//! Frames are a 4-byte little-endian length followed by that many JSON bytes.
//! Discovery never searches `PATH`: overrides and the beside-the-executable
//! fallback always resolve to absolute paths.
use serde::{Serialize, de::DeserializeOwned};
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

/// Hard upper bound for one JSON frame in either direction.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Adapter enumeration must answer quickly or the backend is unusable.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Full audio transcription may legitimately take minutes.
pub const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(180);

/// The one place that decides how long a worker exchange may take.
pub const fn timeout_for(probe: bool) -> Duration {
    if probe {
        PROBE_TIMEOUT
    } else {
        TRANSCRIPTION_TIMEOUT
    }
}

pub fn read_frame<T: DeserializeOwned>(mut input: impl Read) -> std::io::Result<T> {
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_FRAME {
        return Err(std::io::Error::other("Worker frame exceeds limit"));
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

pub fn write_frame(mut output: impl Write, value: &impl Serialize) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        return Err(std::io::Error::other("Worker frame exceeds limit"));
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

/// Resolve a worker override against an explicit base directory.
///
/// Absolute values pass through unchanged; relative values become
/// `cwd/override`, so a bare name can never be handed to `Command::new` and
/// resolved through `PATH`.
pub fn resolve_override(value: impl AsRef<Path>, cwd: impl AsRef<Path>) -> PathBuf {
    let value = value.as_ref();
    if value.is_absolute() {
        value.to_path_buf()
    } else {
        cwd.as_ref().join(value)
    }
}

/// Absolute path of `name` beside `exe`.
///
/// A relative executable path (for example `current_exe()` failing and
/// yielding an empty path) is anchored against `cwd`, so the result is never a
/// bare relative filename.
pub fn beside_executable(exe: impl AsRef<Path>, name: &str, cwd: impl AsRef<Path>) -> PathBuf {
    let exe = exe.as_ref();
    if exe.as_os_str().is_empty() {
        return resolve_override(name, cwd);
    }
    resolve_override(exe, cwd).with_file_name(name)
}

/// Read a discovery override from the environment without ever trusting it as
/// a bare `PATH` lookup.
pub fn override_from_env(variable: &str) -> Option<PathBuf> {
    let value: OsString = std::env::var_os(variable)?;
    let cwd = std::env::current_dir().unwrap_or_default();
    Some(resolve_override(PathBuf::from(value), cwd))
}

/// Worker path beside the running executable, made absolute.
pub fn beside_current_executable(name: &str) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    beside_executable(std::env::current_exe().unwrap_or_default(), name, cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_override_is_anchored_to_the_current_directory() {
        assert_eq!(
            resolve_override("workers/oxide-vulkan-worker", "/opt/oxide"),
            PathBuf::from("/opt/oxide/workers/oxide-vulkan-worker")
        );
        assert_eq!(
            resolve_override("oxide-vulkan-worker", "/opt/oxide"),
            PathBuf::from("/opt/oxide/oxide-vulkan-worker")
        );
    }

    #[test]
    fn an_absolute_override_is_left_alone() {
        assert_eq!(
            resolve_override("/usr/local/bin/oxide-cuda-worker", "/opt/oxide"),
            PathBuf::from("/usr/local/bin/oxide-cuda-worker")
        );
    }

    #[test]
    fn the_beside_fallback_is_never_a_bare_relative_filename() {
        let cwd = Path::new("/opt/oxide");
        let beside = beside_executable("app/oxide", "oxide-vulkan-worker", cwd);
        assert_eq!(beside, PathBuf::from("/opt/oxide/app/oxide-vulkan-worker"));
        assert!(beside.is_absolute());

        let empty = beside_executable("", "oxide-cuda-worker", cwd);
        assert_eq!(empty, PathBuf::from("/opt/oxide/oxide-cuda-worker"));
        assert!(empty.is_absolute());
    }
}
