//! Process hygiene shared by every child Oxide spawns (Provider CLIs, PTY shells): each runs in
//! its own process group (a Job Object on Windows), shutdown escalates SIGTERM -> SIGKILL, and
//! live groups are recorded on disk so a crashed Oxide's orphans can be killed on the next
//! launch. The OS-specific part lives in `oxide-platform` (ADR-0019) and is re-exported here, so
//! this is still the one place Providers and Core look.

use crate::diag;
pub use oxide_platform::process::{
    attach_running_to_job, attach_to_job, group_alive, hide_console, interrupt_group, kill_group,
    process_alive, release_job, spawn_in_own_group, terminate_group,
};
pub use oxide_platform::registry::{ProcessRegistry, SHUTDOWN_GRACE};
use std::process::{Child, Command, Output, Stdio};

/// Attach a suspended std child to its kill-on-close job before resuming it.
pub fn attach_child_to_job(child: &mut Child) -> std::io::Result<()> {
    if let Err(error) = attach_to_job(child.id()) {
        diag::best_effort("kill", child.kill());
        diag::best_effort("wait", child.wait());
        return Err(error);
    }
    Ok(())
}

/// Captures a short-lived CLI invocation while keeping it in Oxide's process group/job.
pub fn output_in_own_group(command: &mut Command) -> std::io::Result<Output> {
    spawn_in_own_group(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let pid = child.id() as i32;
    let output = match attach_child_to_job(&mut child) {
        Ok(()) => child.wait_with_output(),
        Err(error) => return Err(error),
    };
    release_job(pid);
    output
}
