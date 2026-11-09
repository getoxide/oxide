//! Shared fixtures for the Core integration tests that spawn Project Services.

#![allow(dead_code)]

use oxide_core::{Core, ProjectService, ProjectServiceConflict, ProjectServiceStartOutcome};
use oxide_provider::process::group_alive;
use std::path::Path;
use std::time::{Duration, Instant};

pub fn started(outcome: ProjectServiceStartOutcome) -> ProjectService {
    match outcome {
        ProjectServiceStartOutcome::Started(service) => service,
        ProjectServiceStartOutcome::Conflict(conflict) => {
            panic!(
                "expected a started service, got a conflict: {}",
                conflict.message
            )
        }
    }
}

pub fn conflicted(outcome: ProjectServiceStartOutcome) -> ProjectServiceConflict {
    match outcome {
        ProjectServiceStartOutcome::Conflict(conflict) => conflict,
        ProjectServiceStartOutcome::Started(service) => {
            panic!("expected a conflict, got service {}", service.id)
        }
    }
}

/// A free loopback port. The listener is dropped before the caller uses it, so a test may race
/// another process for it; every test here uses its own ephemeral port, which keeps that rare.
pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

pub fn open_core_with_project(dir: &Path) -> (Core, u32) {
    let core = Core::open(dir).unwrap();
    core.set_real_time_ticker(false);
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project_id = core
        .add_project(&dir.join("my-project").to_string_lossy())
        .unwrap()
        .id;
    (core, project_id)
}

pub fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if check() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn wait_group_gone(pid: u32) -> bool {
    wait_until(Duration::from_secs(5), || !group_alive(pid as i32))
}
