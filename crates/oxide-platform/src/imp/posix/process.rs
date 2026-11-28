//! Process supervision on Unix: process groups, signals, liveness.

use super::signal::{signal_group, signal_process};
use crate::ProcessIdentity;
use crate::diag;
use std::io;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// Background CLI calls need no console flag outside Windows.
pub fn hide_console(command: &mut Command) -> &mut Command {
    command
}

/// Makes `command` start in a new process group led by the child (pgid == pid).
pub fn spawn_in_own_group(command: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command
}

/// Asks every process of group `pgid` to stop what it is doing (SIGINT).
pub fn interrupt_group(pgid: i32) -> io::Result<()> {
    signal_group(pgid, libc::SIGINT)
}

/// Ends group `pgid` at once without waiting for it; used when its stdout turned hostile.
pub fn kill_group(pgid: i32) {
    diag::best_effort("signal_group", signal_group(pgid, libc::SIGKILL));
}

/// Whether any process of group `pgid` still exists (zombies included).
pub fn group_alive(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }
    match signal_group(pgid, 0) {
        Ok(()) => true,
        Err(error) => error.raw_os_error() == Some(libc::EPERM),
    }
}

/// Whether the single process `pid` still exists (a zombie included).
pub fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    match signal_process(pid, 0) {
        Ok(()) => true,
        Err(error) => error.raw_os_error() == Some(libc::EPERM),
    }
}

/// Sends SIGTERM to the group, then SIGKILL once `grace` has passed with members still alive.
/// `reap` runs on every poll so the caller can `wait` on the group leader (a zombie leader
/// would otherwise keep the group looking alive). Returns once the group is gone.
pub fn terminate_group(pgid: i32, grace: Duration, mut reap: impl FnMut()) {
    if pgid <= 0 {
        return;
    }
    diag::best_effort("signal_group", signal_group(pgid, libc::SIGTERM));
    let deadline = Instant::now() + grace;
    let mut killed = false;
    loop {
        reap();
        if !group_alive(pgid) {
            return;
        }
        if !killed && Instant::now() >= deadline {
            diag::best_effort("signal_group", signal_group(pgid, libc::SIGKILL));
            killed = true;
        }
        // After SIGKILL the group dies at once; this bound only guards against uninterruptible
        // processes.
        if killed && Instant::now() >= deadline + Duration::from_secs(5) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Windows keeps children in a kill-on-close job; Unix has process groups and needs nothing here.
pub fn attach_to_job(_pid: u32) -> io::Result<()> {
    Ok(())
}

/// Windows attaches an already running child (a PTY shell) to a job; nothing to do on Unix.
pub fn attach_running_to_job(_pid: u32) -> io::Result<()> {
    Ok(())
}

/// Windows releases a child's job after it exited; nothing to do on Unix.
pub fn release_job(_pid: i32) {}

/// What identifies `pid` beyond its id. Only Windows can tell; Unix checks the command line in
/// [`leader_runs`] instead.
pub fn process_identity(_pid: i32) -> Option<ProcessIdentity> {
    None
}

/// Whether `pid` leads its own process group and its command line starts with `executable`
/// (directly, or as the script of an interpreter such as `node server.js`).
pub fn leader_runs(pid: i32, executable: &str, _identity: Option<&ProcessIdentity>) -> bool {
    // SAFETY: `getpgid` takes a plain integer, touches no memory and only reports an error.
    if pid <= 0 || unsafe { libc::getpgid(pid) } != pid {
        return false;
    }
    let Ok(output) = crate::command::os_command("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
    else {
        return false;
    };
    let wanted = base_name(executable);
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .take(2)
        .any(|token| base_name(token) == wanted)
}

fn base_name(token: &str) -> &str {
    let name = Path::new(token)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(token);
    // Login shells show up as `-zsh`.
    name.trim_start_matches('-')
}
