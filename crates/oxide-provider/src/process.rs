//! Process hygiene shared by every child Oxide spawns (Provider CLIs, PTY shells): each runs in
//! its own process group (a Job Object on Windows), shutdown escalates SIGTERM -> SIGKILL, and
//! live groups are recorded on disk so a crashed Oxide's orphans can be killed on the next
//! launch. The OS-specific part lives in `oxide-platform` (ADR-0018) and is re-exported here, so
//! this is still the one place Providers and Core look.

use crate::diag;
pub use oxide_platform::process::{
    attach_running_to_job, attach_to_job, group_alive, hide_console, interrupt_group, kill_group,
    process_alive, release_job, spawn_in_own_group, terminate_group,
};
pub use oxide_platform::registry::{ProcessRegistry, SHUTDOWN_GRACE};
use std::process::{Child, Command, Output, Stdio};

/// How many trailing stderr lines [`drain_stderr`] retains for `ProviderEvent::Exited`.
pub const STDERR_TAIL_LINES: usize = 20;

/// Drains a child's piped stderr on a background thread so verbose output cannot fill the OS
/// pipe buffer and deadlock the child. Returns up to the last `STDERR_TAIL_LINES` lines.
/// Unwraps a stdio handle that was configured as piped. A missing pipe kills the child (it
/// would otherwise run unattended) and becomes a start error instead of a panic.
pub fn require_pipe<T>(
    pipe: Option<T>,
    child: &mut Child,
    name: &str,
) -> Result<T, crate::ProviderError> {
    pipe.ok_or_else(|| {
        diag::best_effort("kill", child.kill());
        crate::ProviderError::StartFailed(format!("child {name} was not piped"))
    })
}

pub fn drain_stderr(stderr: std::process::ChildStderr) -> std::thread::JoinHandle<Option<String>> {
    std::thread::spawn(move || {
        use crate::bounded_lines::{BoundedLines, LOG_LINE_CAP, is_line_too_long};
        use std::collections::VecDeque;
        use std::io::BufReader;

        let mut reader = BufReader::new(stderr);
        let mut tail = VecDeque::with_capacity(STDERR_TAIL_LINES);
        let mut push = |line: String| {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        };
        let mut lines = BoundedLines::new(&mut reader, LOG_LINE_CAP);
        for line in lines.by_ref() {
            match line {
                Ok(line) => push(line),
                Err(error) => {
                    if is_line_too_long(&error) {
                        push(format!("[stderr line over {LOG_LINE_CAP} bytes discarded]"));
                    }
                    break;
                }
            }
        }
        // Keep emptying the pipe so a chatty child never blocks on it, without keeping anything.
        diag::best_effort("copy", std::io::copy(&mut reader, &mut std::io::sink()));
        let joined = tail.into_iter().collect::<Vec<_>>().join("\n");
        (!joined.is_empty()).then_some(joined)
    })
}

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
