//! The runtime file of live process-group ids (`~/.oxide/processes.json`), so a crashed Oxide's
//! orphans can be killed on the next launch. The same code runs on every OS; what differs (how a
//! leader is recognised, Job Objects) is in `process`.

use crate::ProcessIdentity;
use crate::diag;
use crate::process::{
    attach_running_to_job, leader_runs, process_identity, release_job, terminate_group,
};
use crate::sync::LockExt as _;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// How long a process group gets between SIGTERM and SIGKILL.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    pgid: i32,
    /// The executable the group leader was started from, as given to the spawn call.
    executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<ProcessIdentity>,
}

/// The runtime file of live process-group ids.
///
/// Opening it loads what a previous run left behind as *stale*; [`reap_stale`](Self::reap_stale)
/// kills the stale groups whose leader still runs the expected executable. Writes are
/// best-effort: failing to record a group must never stop a shell from starting.
pub struct ProcessRegistry {
    path: PathBuf,
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    live: Vec<Entry>,
    stale: Vec<Entry>,
}

impl ProcessRegistry {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let stale = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(RegistryState {
                live: Vec::new(),
                stale,
            }),
        }
    }

    /// Records a live group. `pgid` is the leader's pid.
    pub fn register(&self, pgid: i32, executable: &str) {
        // Windows contains the group in a Job Object; elsewhere both calls do nothing.
        diag::best_effort("attach_running_to_job", attach_running_to_job(pgid as u32));
        let identity = process_identity(pgid);
        let mut state = self.state.lock_recover();
        state.live.retain(|e| e.pgid != pgid);
        state.live.push(Entry {
            pgid,
            executable: executable.to_string(),
            identity,
        });
        self.persist(&state);
    }

    pub fn unregister(&self, pgid: i32) {
        let mut state = self.state.lock_recover();
        state.live.retain(|e| e.pgid != pgid);
        self.persist(&state);
        release_job(pgid);
    }

    /// Kills every group left by a previous run whose leader is still alive and still runs the
    /// recorded executable; a pid the OS has since reused for something else is left alone.
    /// Returns the killed group ids and forgets all stale entries.
    pub fn reap_stale(&self) -> Vec<i32> {
        let mut state = self.state.lock_recover();
        let stale = std::mem::take(&mut state.stale);
        let mut killed = Vec::new();
        for entry in stale {
            if leader_runs(entry.pgid, &entry.executable, entry.identity.as_ref()) {
                terminate_group(entry.pgid, SHUTDOWN_GRACE, || {});
                killed.push(entry.pgid);
            }
        }
        self.persist(&state);
        killed
    }

    fn persist(&self, state: &RegistryState) {
        let Ok(json) = serde_json::to_vec(&state.live) else {
            return;
        };
        let tmp = self.path.with_extension("json.tmp");
        if write_private(&tmp, &json).is_ok() {
            diag::best_effort("rename", std::fs::rename(&tmp, &self.path));
        }
    }
}

/// Writes `bytes` to `path`; a new file is private to the user, like the rest of Oxide's home.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::fs::create_private_file(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reap_stale_forgets_entries_and_unregistered_groups_are_not_stale() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("processes.json");
        let registry = ProcessRegistry::open(&path);
        registry.register(4_000_001, "sleep");
        registry.register(4_000_002, "sleep");
        registry.unregister(4_000_001);

        let next = ProcessRegistry::open(&path);
        assert_eq!(next.state.lock_recover().stale.len(), 1);
        next.reap_stale();
        assert!(
            ProcessRegistry::open(&path)
                .state
                .lock_recover()
                .stale
                .is_empty()
        );
    }
}
