//! The `PATH` of a macOS app launched from the Dock or Finder.
//!
//! launchd hands such an app `/usr/bin:/bin:/usr/sbin:/sbin`, so the Provider CLIs (`claude`,
//! `codex`, `agy`) and `gh`, which live in `~/.local/bin`, Homebrew or a Node version manager,
//! are not found even though they work in a terminal. At startup the app asks the user's login
//! shell for its `PATH` and merges it into its own.

use std::path::Path;

/// Directories where these CLIs are usually installed, in case the login shell can't be read.
const FALLBACK_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

const MARKER: &str = "__OXIDE_PATH__";

/// The app's own entries first, then the login shell's, then the usual install directories
/// (`~/.local/bin` and `FALLBACK_DIRS`). Empty entries and duplicates are dropped.
pub fn merge_path(current: &str, login: &str, home: Option<&Path>) -> String {
    let fallback = home
        .map(|home| home.join(".local/bin").to_string_lossy().into_owned())
        .into_iter()
        .chain(FALLBACK_DIRS.iter().map(|dir| (*dir).to_string()));
    let mut merged: Vec<String> = Vec::new();
    for entry in current
        .split(':')
        .chain(login.split(':'))
        .map(str::to_string)
        .chain(fallback)
    {
        if !entry.is_empty() && !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    merged.join(":")
}

/// What the login shell printed between two markers, so a noisy rc file can't corrupt it.
pub fn parse_marked_path(output: &str) -> Option<&str> {
    let start = output.find(MARKER)? + MARKER.len();
    let len = output[start..].find(MARKER)?;
    Some(&output[start..start + len])
}

/// Merges the login shell's `PATH` into this process's. Call once, before any thread starts.
#[cfg(target_os = "macos")]
pub fn inherit_login_shell_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let login = login_shell_path().unwrap_or_default();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let merged = merge_path(&current, &login, home.as_deref());
    // SAFETY: called first in `run`, while the process is still single-threaded.
    unsafe { std::env::set_var("PATH", merged) };
}

#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // `-i` too: many people set their PATH in `.zshrc`, not only in `.zprofile`.
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}%s{MARKER}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });

    // A slow or interactive rc file must not keep the app from opening.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = reader.join().ok()?;
    parse_marked_path(&output).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_shell_path_and_the_usual_install_dirs_are_added_after_the_apps_own() {
        let merged = merge_path(
            "/usr/bin:/bin",
            "/Users/a/.nvm/bin:/usr/bin",
            Some(Path::new("/Users/a")),
        );
        assert_eq!(
            merged,
            "/usr/bin:/bin:/Users/a/.nvm/bin:/Users/a/.local/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }

    #[test]
    fn a_failed_login_shell_still_finds_the_usual_install_dirs() {
        let merged = merge_path("/usr/bin:/bin", "", Some(Path::new("/Users/a")));
        assert_eq!(
            merged,
            "/usr/bin:/bin:/Users/a/.local/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }

    #[test]
    fn merging_twice_changes_nothing_and_empty_entries_vanish() {
        let once = merge_path("/usr/bin::/bin", "", None);
        assert_eq!(once, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(merge_path(&once, "", None), once);
    }

    #[test]
    fn only_what_sits_between_the_markers_is_the_path() {
        let noisy = "Last login: today\nwelcome\n__OXIDE_PATH__/a:/b__OXIDE_PATH__\nbye";
        assert_eq!(parse_marked_path(noisy), Some("/a:/b"));
        assert_eq!(parse_marked_path("__OXIDE_PATH__/a"), None);
        assert_eq!(parse_marked_path("nothing"), None);
    }
}
