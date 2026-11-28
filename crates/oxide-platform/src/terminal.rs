//! Terminals: which shells a Terminal may run, how to start one, how to run Command blocks in it
//! and how to end it with everything it started.

use crate::imp::terminal as imp;
use portable_pty::MasterPty;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `token` when it is a valid Command block token (ASCII letters, digits and `-`), which every
/// implementation of [`block_script`] embeds in shell code: anything else could end the quoting
/// around it (ADR-0016). Checked here, once, for every OS.
fn block_token(token: &str) -> io::Result<&str> {
    if !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(token)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a Command block token is ASCII letters, digits and '-'",
        ))
    }
}

/// The shell a Terminal runs, chosen from the OS allowlist (ADR-0016).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    #[default]
    Default,
    Zsh,
    Bash,
    #[serde(rename = "powershell")]
    PowerShell,
    Pwsh,
}

/// An installed shell that the current OS supports for Terminals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableShell {
    pub kind: ShellKind,
    pub label: String,
    pub is_default: bool,
}

/// How to start the interactive shell of a Terminal: plain data the caller turns into a PTY
/// command, so this crate needs no PTY library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellLaunch {
    /// What the Terminal shows as its shell: `zsh`, `bash`, `PowerShell` or `pwsh`.
    pub name: String,
    pub program: std::ffi::OsString,
    pub args: Vec<std::ffi::OsString>,
    pub env: Vec<(String, String)>,
}

/// A running shell, as [`close_session`] needs to see it.
pub trait ShellProcess {
    /// Collects the shell's exit status if it already ended, so a dead shell stops counting as
    /// alive (on Unix a zombie leader keeps its group looking alive).
    fn reap(&mut self);
    /// Ends the shell process itself.
    fn kill(&mut self);
}

/// The installed shells this OS supports for Terminals (the ADR-0016 allowlist: zsh and bash on
/// macOS and Linux, Windows PowerShell and `pwsh` on Windows).
pub fn available_shells() -> Vec<AvailableShell> {
    imp::available_shells()
}

/// Whether `shell` is in this OS's Terminal allowlist (ADR-0016).
pub fn is_shell_supported(shell: ShellKind) -> bool {
    imp::is_shell_supported(shell)
}

/// How to start a Terminal's shell. With `blocks`, the chosen shell (the user's login shell for
/// `ShellKind::Default`) set up to mark Command blocks, reading the `init_file` that
/// [`create_shell_init_file`] made where the shell needs one; without, the user's own shell as it
/// is. `load_user_config` says whether the user's own startup files load too.
pub fn shell_launch(
    blocks: bool,
    init_file: Option<&Path>,
    shell: ShellKind,
    load_user_config: bool,
) -> ShellLaunch {
    imp::shell_launch(blocks, init_file, shell, load_user_config)
}

/// What to type into the shell to run `command` as a Command block marked by `token`: the command
/// runs at the top level of the live shell exactly as typed (its `cd` and variables stay), between
/// a start and an end marker, and a syntax error fails the block instead of leaving the shell
/// waiting for more input. A `token` other than ASCII letters, digits and `-` is refused before
/// any shell code is built.
pub fn block_script(token: &str, command: &str) -> io::Result<String> {
    imp::block_script(block_token(token)?, command)
}

/// A script that asks the shell itself for the completions of `line` at `cursor` and prints them
/// in a marker tagged `token`, or `None` when the shell cannot (the caller then completes paths
/// and commands without evaluating anything). Only PowerShell can.
pub fn completion_script(token: u32, line: &str, cursor: usize) -> Option<String> {
    imp::completion_script(token, line, cursor)
}

/// Creates what the shell of block Terminal `id` reads at startup, in Oxide's private `home` and
/// not the shared temp directory, where any local account could plant or read it. `None` when
/// the shell needs no file.
pub fn create_shell_init_file(
    home: &Path,
    id: u32,
    shell: ShellKind,
    load_user_config: bool,
) -> io::Result<Option<PathBuf>> {
    imp::create_shell_init_file(home, id, shell, load_user_config)
}

/// The process group to supervise for the shell `shell_pid`, or `None` where the OS has no groups
/// (Windows contains a shell's tree in a Job Object).
pub fn session_group(shell_pid: u32, master: &dyn MasterPty) -> Option<i32> {
    imp::session_group(shell_pid, master)
}

/// Writes `input` to the shell. Ctrl+C (0x03) goes through the PTY like any key, so the running
/// program gets it the way its OS delivers it, or as the raw key when it reads keys itself (and may
/// want a second press to quit).
pub fn write_input(
    writer: &mut dyn Write,
    input: &[u8],
    shell_pid: u32,
    master: &dyn MasterPty,
) -> io::Result<()> {
    imp::write_input(writer, input, shell_pid, master)
}

/// Force-stops whatever command runs in the foreground of the shell without ending the shell
/// itself, so it emits its block end marker and returns to its prompt.
pub fn force_interrupt_foreground(shell_pid: u32, master: &dyn MasterPty) -> io::Result<()> {
    imp::force_interrupt_foreground(shell_pid, master)
}

/// Ends a shell and everything it started, giving its group `grace` to stop the way
/// [`crate::process::terminate_group`] does.
pub fn close_session(group: Option<i32>, grace: Duration, shell: &mut dyn ShellProcess) {
    imp::close_session(group, grace, shell);
}

/// Ends what is left of a shell's session once the shell ended: on Unix, anything that moved to
/// its own process group but stayed in the session. Nothing outlives a Windows Job Object.
pub fn clean_up_session(group: Option<i32>) {
    imp::clean_up_session(group);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_wrapper_refuses_a_token_that_could_break_out_of_it() {
        for token in ["", "a'b", "a;b", "a\"b", "a b", "$(x)"] {
            assert!(block_script(token, "echo hi").is_err(), "{token:?}");
        }
        assert!(block_script("ok-Token-1", "echo hi").is_ok());
    }
}
