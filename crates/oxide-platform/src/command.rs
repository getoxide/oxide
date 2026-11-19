//! The two sanctioned ways to start a process by name or by path (ADR-0016). Git and `gh` have
//! their own hardened builders in `oxide-core`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// A `Command` for the OS helper `name` (`ps`, `open`, `sh`, `cmd`, ...), started by the absolute
/// path [`os_tool`] gives it. This is how Oxide starts an OS helper: a bare name would be found
/// through `PATH`, which Oxide widens with the login shell's directories. It sets no stdio or
/// console flags; add [`crate::process::hide_console`] where a background call must not show a
/// console on Windows.
#[allow(
    clippy::disallowed_methods,
    reason = "sanctioned constructor for OS helpers (ADR-0016)"
)]
pub fn os_command(name: &str) -> std::process::Command {
    std::process::Command::new(os_tool(name))
}

/// A `Command` for an executable whose path Oxide already holds: a tool it installed itself, the
/// user's login shell, a language server it unpacked. The caller owns the decision that the path is the right one; for an OS
/// helper by name use [`os_command`], and for Git and gh the hardened builders (ADR-0016).
#[allow(
    clippy::disallowed_methods,
    reason = "sanctioned constructor for an already resolved executable path (ADR-0016)"
)]
pub fn resolved_command(executable: impl AsRef<OsStr>) -> std::process::Command {
    std::process::Command::new(executable)
}

/// Where operating-system helpers (`open`, `sh`, `cmd`, ...) live. Oxide widens its own `PATH`
/// at startup, so a directory earlier in the login shell's `PATH` could shadow these; they are
/// therefore called by absolute path. Tools the user installs (`git`, `gh`,
/// `brew`, `winget`, `npm`) are not OS helpers and keep their `PATH` lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsFamily {
    MacOs,
    Windows,
    Other,
}

/// Absolute path of the OS helper `name` on this platform. Unknown names, and platforms without
/// a fixed layout (Linux distributions differ), keep the bare name for `PATH` lookup.
pub fn os_tool(name: &str) -> PathBuf {
    let family = if cfg!(target_os = "macos") {
        OsFamily::MacOs
    } else if cfg!(windows) {
        OsFamily::Windows
    } else {
        OsFamily::Other
    };
    let system_root = std::env::var("SystemRoot").ok();
    os_tool_for(family, system_root.as_deref(), name)
}

fn os_tool_for(family: OsFamily, system_root: Option<&str>, name: &str) -> PathBuf {
    match family {
        OsFamily::MacOs => match name {
            "open" => "/usr/bin/open",
            "system_profiler" => "/usr/sbin/system_profiler",
            "sh" => "/bin/sh",
            "security" => "/usr/bin/security",
            "ps" => "/bin/ps",
            other => other,
        }
        .into(),
        OsFamily::Windows => {
            let root = system_root
                .filter(|r| !r.is_empty())
                .unwrap_or("C:\\Windows");
            let root = root.trim_end_matches('\\');
            let stem = name.strip_suffix(".exe").unwrap_or(name);
            match stem {
                "cmd" | "rundll32" => format!("{root}\\System32\\{stem}.exe"),
                "powershell" => {
                    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
                }
                // Explorer lives in the Windows directory itself, not in System32.
                "explorer" => format!("{root}\\explorer.exe"),
                _ => name.to_string(),
            }
            .into()
        }
        OsFamily::Other => match name {
            "ps" => "/bin/ps",
            other => other,
        }
        .into(),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_helpers_are_absolute() {
        let tool = |name| os_tool_for(OsFamily::MacOs, None, name);
        assert_eq!(tool("open"), PathBuf::from("/usr/bin/open"));
        assert_eq!(
            tool("system_profiler"),
            PathBuf::from("/usr/sbin/system_profiler")
        );
        assert_eq!(tool("sh"), PathBuf::from("/bin/sh"));
        assert_eq!(tool("security"), PathBuf::from("/usr/bin/security"));
        assert_eq!(tool("ps"), PathBuf::from("/bin/ps"));
        assert_eq!(tool("git"), PathBuf::from("git"), "user tools keep PATH");
    }

    #[test]
    fn windows_helpers_come_from_the_system_root() {
        let tool = |name| os_tool_for(OsFamily::Windows, Some("D:\\Win\\"), name);
        assert_eq!(tool("cmd"), PathBuf::from("D:\\Win\\System32\\cmd.exe"));
        assert_eq!(tool("cmd.exe"), PathBuf::from("D:\\Win\\System32\\cmd.exe"));
        assert_eq!(
            tool("rundll32"),
            PathBuf::from("D:\\Win\\System32\\rundll32.exe")
        );
        assert_eq!(
            tool("powershell.exe"),
            PathBuf::from("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        );
        assert_eq!(tool("explorer"), PathBuf::from("D:\\Win\\explorer.exe"));
        assert_eq!(tool("git"), PathBuf::from("git"), "user tools keep PATH");
        assert_eq!(
            os_tool_for(OsFamily::Windows, None, "cmd"),
            PathBuf::from("C:\\Windows\\System32\\cmd.exe")
        );
    }

    #[test]
    fn other_platforms_keep_path_lookup() {
        assert_eq!(
            os_tool_for(OsFamily::Other, None, "xdg-open"),
            PathBuf::from("xdg-open")
        );
    }
}
