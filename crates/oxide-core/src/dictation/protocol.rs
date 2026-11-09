//! Framing and lifecycle constants shared by every out-of-process worker.
//!
//! Frames are a 4-byte little-endian length followed by that many JSON bytes.
//! Discovery never searches `PATH`: overrides and the beside-the-executable
//! fallback always resolve to a path with a separator (`./name` at worst).
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
        let cwd = cwd.as_ref();
        // An empty base would join to a bare file name, which `Command::new`
        // resolves through `PATH`.
        if cwd.as_os_str().is_empty() {
            Path::new(".").join(value)
        } else {
            cwd.join(value)
        }
    }
}

/// Absolute path of `name` beside `exe`.
///
/// A relative executable path (for example `current_exe()` failing and
/// yielding an empty path) is anchored against `cwd`, so the result is never a
/// bare relative filename.
fn beside_executable(exe: impl AsRef<Path>, name: &str, cwd: impl AsRef<Path>) -> PathBuf {
    let exe = exe.as_ref();
    if exe.as_os_str().is_empty() {
        return resolve_override(name, cwd);
    }
    resolve_override(exe, cwd).with_file_name(name)
}

/// Pick a worker path with a fixed precedence: development override, then the
/// executable's folder, then an installed runtime. The installed lookup is
/// lazy so a working override or nearby worker never pays for it.
///
/// `PATH` is not an input and is never consulted: callers fall back to the
/// beside path rather than a bare name.
pub fn choose_worker_path(
    override_path: Option<PathBuf>,
    beside: PathBuf,
    installed: impl FnOnce() -> Option<PathBuf>,
) -> PathBuf {
    if let Some(path) = override_path {
        return path;
    }
    if beside.is_file() {
        return beside;
    }
    let fallback = beside.clone();
    installed().unwrap_or(fallback)
}

/// Read a discovery override from the environment without ever trusting it as
/// a bare `PATH` lookup.
pub fn override_from_env(variable: &str) -> Option<PathBuf> {
    let value: OsString = std::env::var_os(variable)?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    Some(resolve_override(PathBuf::from(value), cwd))
}

/// Worker path beside the running executable, made absolute.
pub fn beside_current_executable(name: &str) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
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

    #[test]
    fn a_failed_current_directory_fallback_still_has_a_separator() {
        // `current_dir().unwrap_or_else(PathBuf::new)` used to leave a bare name
        // that `Command::new` would resolve through PATH.
        let fallback = PathBuf::from(".");
        for path in [
            beside_executable("", "oxide-cuda-worker", &fallback),
            beside_executable("oxide", "oxide-cuda-worker", &fallback),
        ] {
            assert_eq!(path, PathBuf::from("./oxide-cuda-worker"));
            assert!(path.components().count() > 1, "{path:?} has no separator");
        }
        assert_eq!(
            resolve_override("oxide-cuda-worker", ""),
            PathBuf::from("./oxide-cuda-worker")
        );
    }

    #[test]
    fn worker_discovery_prefers_override_then_beside_then_installed() {
        let override_path = PathBuf::from("/opt/override/worker");
        let dir = tempfile::tempdir().unwrap();
        let beside = dir.path().join("worker");
        std::fs::write(&beside, b"x").unwrap();
        let installed = PathBuf::from("/home/runtimes/vulkan/1.0.0/worker");

        assert_eq!(
            choose_worker_path(Some(override_path.clone()), beside.clone(), || panic!(
                "the installed lookup must not run when an override exists"
            )),
            override_path
        );
        assert_eq!(
            choose_worker_path(None, beside.clone(), || panic!(
                "the installed lookup must not run when the worker is beside the executable"
            )),
            beside
        );
        let missing_beside = dir.path().join("missing/worker");
        assert_eq!(
            choose_worker_path(None, missing_beside.clone(), || Some(installed.clone())),
            installed
        );
        assert_eq!(
            choose_worker_path(None, missing_beside.clone(), || None),
            missing_beside
        );
    }

    #[test]
    fn a_path_only_binary_is_never_chosen() {
        let dir = tempfile::tempdir().unwrap();
        // A same-named executable in a directory that would be on PATH.
        let path_only = dir.path().join("bin/oxide-vulkan-worker");
        std::fs::create_dir_all(path_only.parent().unwrap()).unwrap();
        std::fs::write(&path_only, b"x").unwrap();
        let beside = dir.path().join("app/oxide-vulkan-worker");

        let chosen = choose_worker_path(None, beside.clone(), || None);
        assert_eq!(chosen, beside);
        assert_ne!(chosen, path_only);
        assert!(!chosen.exists());
    }
}
