//! Contract tests of the platform layer: they run unchanged on macOS, Linux and Windows, so a
//! behaviour that differs between the implementations fails here and not in a scattered
//! integration test (ADR-0019). A per-OS test input is a value chosen with the expression form.
#![allow(
    clippy::disallowed_methods,
    clippy::expect_used,
    reason = "the contract tests start their own fixture processes and fail on any setup error"
)]

use oxide_platform::diag;
use oxide_platform::process::{
    attach_to_job, group_alive, process_alive, spawn_in_own_group, terminate_group,
};
use oxide_platform::registry::{ProcessRegistry, SHUTDOWN_GRACE};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A process that sleeps for a long time, leading its own group (inside its own job on Windows).
fn sleeper() -> Child {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "ping -n 300 127.0.0.1 > NUL"]);
        command
    } else {
        let mut command = Command::new("sleep");
        command.arg("300");
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = spawn_in_own_group(&mut command)
        .spawn()
        .expect("the sleeper starts");
    attach_to_job(child.id()).expect("the sleeper joins its job");
    child
}

fn end(child: &mut Child) {
    let pid = child.id() as i32;
    terminate_group(pid, Duration::ZERO, || {
        diag::best_effort("try_wait", child.try_wait());
    });
    diag::best_effort("wait", child.wait());
}

fn wait_gone(pgid: i32, child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        diag::best_effort("try_wait", child.try_wait());
        if !group_alive(pgid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn a_group_can_be_observed_and_terminated() {
    let mut child = sleeper();
    let pid = child.id() as i32;
    assert!(group_alive(pid));
    assert!(process_alive(pid));

    terminate_group(pid, SHUTDOWN_GRACE, || {
        diag::best_effort("try_wait", child.try_wait());
    });

    diag::best_effort("wait", child.wait());
    assert!(!group_alive(pid));
}

#[test]
fn ids_that_name_no_process_are_not_alive() {
    for id in [0, -1, i32::MIN] {
        assert!(!group_alive(id), "group {id}");
        assert!(!process_alive(id), "process {id}");
    }
}

#[test]
fn reap_stale_kills_groups_whose_leader_matches() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("processes.json");
    let mut orphan = sleeper();
    let pid = orphan.id() as i32;
    let program = if cfg!(windows) { "cmd.exe" } else { "sleep" };
    // The crashed run registered the group and never unregistered it.
    ProcessRegistry::open(&path).register(pid, program);

    let killed = ProcessRegistry::open(&path).reap_stale();

    assert_eq!(killed, vec![pid]);
    assert!(wait_gone(pid, &mut orphan));
}

#[test]
fn reap_stale_leaves_a_reused_pid_alone() {
    // Unix recognises the leader by its command line, Windows by its start time and image: a
    // record that no longer fits the process at that id must not make Oxide kill it.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("processes.json");
    let mut bystander = sleeper();
    let pid = bystander.id() as i32;
    let registry = ProcessRegistry::open(&path);
    registry.register(pid, "wrapped-cli.cmd");
    if cfg!(windows) {
        let mut entries: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("registry file"))
                .expect("registry json");
        let created = entries[0]["identity"]["creation_time"]
            .as_u64()
            .expect("Windows records the creation time");
        entries[0]["identity"]["creation_time"] = (created + 1).into();
        std::fs::write(&path, serde_json::to_vec(&entries).expect("json")).expect("write");
    }

    assert!(ProcessRegistry::open(&path).reap_stale().is_empty());
    assert!(group_alive(pid), "a mismatched record must survive");
    end(&mut bystander);
}
