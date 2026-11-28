//! The only place that signals a process or a group (ADR-0016).

/// Smallest process id or group id Oxide will ever signal. Group 0 is Oxide's own group,
/// `kill(-1, ..)` reaches every process of the user, and 1 is init: all of them are refused.
const MIN_SIGNAL_TARGET: i32 = 2;

/// Sends `signal` to every process of group `pgid`: ids of 1 or less (0, 1, negatives) fail with
/// `InvalidInput` and nothing is sent.
pub(crate) fn signal_group(pgid: i32, signal: i32) -> std::io::Result<()> {
    if pgid < MIN_SIGNAL_TARGET {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to signal process group {pgid}"),
        ));
    }
    // SAFETY: `kill` takes plain integers and touches no memory. `pgid` is at least 2, so the
    // negated value targets one specific process group and never 0, -1 or init's group.
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Sends `signal` to the single process `pid`; ids of 1 or less fail with `InvalidInput`.
pub(crate) fn signal_process(pid: i32, signal: i32) -> std::io::Result<()> {
    if pid < MIN_SIGNAL_TARGET {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to signal process {pid}"),
        ));
    }
    // SAFETY: `kill` takes plain integers and touches no memory. `pid` is at least 2, so it
    // names one specific process and never a group, every process (-1) or init.
    if unsafe { libc::kill(pid, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// The session id of `pid`, or `None` when it is gone or not a real process id.
pub(crate) fn session_of(pid: i32) -> Option<i32> {
    if pid < 2 {
        return None;
    }
    // SAFETY: `getsid` takes a plain integer, touches no memory and only reports an error; `pid`
    // is at least 2 so it never means the calling process (0).
    let sid = unsafe { libc::getsid(pid) };
    (sid >= 0).then_some(sid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_group_refuses_ids_that_would_reach_oxide_or_every_process() {
        // Signal 0 only checks existence, so a regression here cannot hurt the test run.
        for pgid in [0, 1, -1, -2, i32::MIN] {
            let error = signal_group(pgid, 0).expect_err("must refuse");
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::InvalidInput,
                "pgid {pgid}"
            );
        }
    }

    #[test]
    fn signal_process_refuses_ids_that_would_reach_every_process() {
        for pid in [0, 1, -1, i32::MIN] {
            let error = signal_process(pid, 0).expect_err("must refuse");
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "pid {pid}");
        }
    }
}
