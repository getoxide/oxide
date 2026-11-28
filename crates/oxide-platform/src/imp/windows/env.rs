//! The process environment on Windows: the app starts with the session's `PATH`.

/// Nothing to merge: the session's `PATH` is already the user's.
pub fn inherit_login_shell_path() {}
