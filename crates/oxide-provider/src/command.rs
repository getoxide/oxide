//! CLI lookup shared by Providers and GitHub integration.

pub use oxide_platform::command::{os_command, os_tool, resolved_command};
use std::ffi::OsStr;
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
