//! Process supervision: groups of processes that end together, liveness and identity.
//!
//! A *group* is a Unix process group on macOS and Linux and a kill-on-close Job Object on Windows;
//! either way it holds a child and everything it starts, so ending the group ends the whole tree.

use crate::imp::process as imp;
use serde::{Deserialize, Serialize};
use std::io;
use std::process::Command;
use std::time::Duration;

/// What identifies one running process beyond its id, which the OS reuses: the image it runs and
/// when it started. Only Windows can read it; elsewhere [`process::process_identity`] is `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub image: String,
    pub creation_time: u64,
}

/// Keeps a background CLI call from opening a console window. Only Windows shows one; elsewhere
/// `command` is returned unchanged.
pub fn hide_console(command: &mut Command) -> &mut Command {
    imp::hide_console(command)
}

/// Makes `command` start as the leader of a new group (on Unix its pgid is its pid). On Windows
/// the child starts suspended so [`attach_to_job`] can contain it before it runs.
pub fn spawn_in_own_group(command: &mut Command) -> &mut Command {
    imp::spawn_in_own_group(command)
}

/// Asks every process of group `pgid` to stop what it is doing: SIGINT on Unix. A Windows group
/// has no input channel to interrupt, so the whole tree ends.
pub fn interrupt_group(pgid: i32) -> io::Result<()> {
    imp::interrupt_group(pgid)
}

/// Ends group `pgid` at once without waiting for it; used when its stdout turned hostile.
pub fn kill_group(pgid: i32) {
    imp::kill_group(pgid);
}

/// Whether any process of group `pgid` still exists (a Unix zombie included).
pub fn group_alive(pgid: i32) -> bool {
    imp::group_alive(pgid)
}

/// Whether the single process `pid` still exists (a Unix zombie included).
pub fn process_alive(pid: i32) -> bool {
    imp::process_alive(pid)
}

/// Ends group `pgid` and returns once it is gone. On Unix the group gets SIGTERM, then SIGKILL
/// once `grace` has passed with members still alive; Windows terminates the job at once, having no
/// gentler signal. `reap` runs on every poll so the caller can `wait` on the group leader: a
/// zombie leader would otherwise keep the group looking alive.
pub fn terminate_group(pgid: i32, grace: Duration, reap: impl FnMut()) {
    imp::terminate_group(pgid, grace, reap);
}

/// Puts a child started with [`spawn_in_own_group`] in its kill-on-close Job Object, so closing
/// Oxide or ending the leader ends its whole tree (Windows). Unix process groups need nothing.
pub fn attach_to_job(pid: u32) -> io::Result<()> {
    imp::attach_to_job(pid)
}

/// [`attach_to_job`] for a child that is already running, such as a PTY shell.
pub fn attach_running_to_job(pid: u32) -> io::Result<()> {
    imp::attach_running_to_job(pid)
}

/// Releases the job of a child that has exited (Windows); nothing elsewhere.
pub fn release_job(pid: i32) {
    imp::release_job(pid);
}

/// What identifies `pid` beyond its id, which the OS reuses. Only Windows can tell; elsewhere it
/// is `None` and [`leader_runs`] checks the command line instead.
pub fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    imp::process_identity(pid)
}

/// Whether `pid` is still the process Oxide recorded, and not another one that reused its id.
/// With an `identity` (Windows) it compares the start time and image; otherwise it checks that
/// `pid` runs `executable` (on Unix: leads its own group, directly or as the script of an
/// interpreter such as `node server.js`).
pub fn leader_runs(pid: i32, executable: &str, identity: Option<&ProcessIdentity>) -> bool {
    imp::leader_runs(pid, executable, identity)
}
