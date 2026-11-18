//! CLI lookup shared by Providers and GitHub integration.

pub use oxide_platform::command::{os_command, os_tool, resolved_command};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Finds a CLI in `path`. Explicit paths stay explicit; Windows command names are expanded
/// in PATHEXT order (with the standard executable extensions when PATHEXT is absent).
pub fn find_in(path: &OsStr, program: &OsStr, pathext: Option<&OsStr>) -> Option<PathBuf> {
    let program = Path::new(program);
    let candidates: Vec<PathBuf> = if !cfg!(windows) || program.extension().is_some() {
        vec![program.to_path_buf()]
    } else {
        pathext
            .unwrap_or_else(|| OsStr::new(".COM;.EXE;.BAT;.CMD"))
            .to_string_lossy()
            .split(';')
            .map(str::trim)
            .filter(|extension| !extension.is_empty())
            .map(|extension| {
                let mut name = program.as_os_str().to_os_string();
                name.push(extension);
                PathBuf::from(name)
            })
            .collect()
    };

    let dirs = if program.components().count() > 1 || program.is_absolute() {
        vec![PathBuf::new()]
    } else {
        std::env::split_paths(path).collect()
    };
    dirs.iter().find_map(|dir| {
        candidates.iter().find_map(|candidate| {
            let candidate = dir.join(candidate);
            candidate
                .is_file()
                .then(|| std::path::absolute(candidate).ok())
                .flatten()
        })
    })
}

/// Build a Provider invocation using its own search environment. Rust's `Command` handles
/// `.cmd`/`.bat` quoting once the full shim path has been resolved.
pub fn provider_command(
    program: &str,
    extra_env: &std::collections::HashMap<String, String>,
) -> std::process::Command {
    // Windows finds a shim through the Provider's own PATH and PATHEXT; elsewhere the name is
    // handed to the OS as it is.
    let resolved = cfg!(windows)
        .then(|| {
            let env = |name: &str| {
                extra_env
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| OsString::from(value))
                    .or_else(|| std::env::var_os(name))
            };
            find_in(
                &env("PATH").unwrap_or_default(),
                OsStr::new(program),
                env("PATHEXT").as_deref(),
            )
        })
        .flatten();
    let program = resolved.as_deref().unwrap_or_else(|| Path::new(program));
    let mut command = resolved_command(program);
    command.envs(extra_env);
    command
}
