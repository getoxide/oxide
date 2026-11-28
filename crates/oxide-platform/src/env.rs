//! The environment Oxide's own process runs with.

use crate::imp::env as imp;

/// Makes this process's `PATH` the one the user's terminal has, so `git`, `gh` and the tools the
/// user installed (in `~/.local/bin`, Homebrew, a Node version manager) are found. Call it once,
/// first thing at startup, before any thread starts.
///
/// macOS starts an app opened from the Dock or Finder with launchd's bare
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so it asks the user's login shell for its `PATH` and merges it
/// in. Linux and Windows start the app with the session's `PATH` and change nothing.
pub fn inherit_login_shell_path() {
    imp::inherit_login_shell_path();
}
