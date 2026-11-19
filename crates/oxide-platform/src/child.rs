//! Child-process helpers that are the same on every OS, built on [`crate::process`]: each child
//! runs in its own process group (a Job Object on Windows) so shutdown reaches its descendants.

use crate::diag;
use crate::process::{attach_to_job, release_job, spawn_in_own_group};
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
