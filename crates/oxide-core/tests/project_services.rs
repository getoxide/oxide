#![cfg(unix)]

use oxide_core::{
    Core, ProjectService, ProjectServiceConflict, ProjectServiceStartOutcome, ProjectServiceStatus,
};
use oxide_provider::process::group_alive;
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn started(outcome: ProjectServiceStartOutcome) -> ProjectService {
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

fn conflicted(outcome: ProjectServiceStartOutcome) -> ProjectServiceConflict {
    match outcome {
        ProjectServiceStartOutcome::Conflict(conflict) => conflict,
        ProjectServiceStartOutcome::Started(service) => {
            panic!("expected a conflict, got service {}", service.id)
        }
    }
}

/// A free loopback port. The listener is dropped before the caller uses it, so a test may race
/// another process for it; every test here uses its own ephemeral port, which keeps that rare.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn open_core_with_project(dir: &Path) -> (Core, u32) {
    let core = Core::open(dir).unwrap();
    core.set_real_time_ticker(false);
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project_id = core
        .add_project(&dir.join("my-project").to_string_lossy())
        .unwrap()
        .id;
    (core, project_id)
}

fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
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

fn wait_group_gone(pid: u32) -> bool {
    wait_until(Duration::from_secs(5), || !group_alive(pid as i32))
}

#[test]
fn spawns_a_long_running_service_in_its_own_process_group() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );

    assert_eq!(service.id, 1);
    assert_eq!(service.project_id, project_id);
    assert_eq!(service.thread_id, None);
    assert_eq!(service.command, "sleep 30");
    assert!(service.checkout.ends_with("my-project"));
    assert_eq!(service.status, ProjectServiceStatus::Running);
    assert!(service.pid > 0);
    assert!(group_alive(service.pid as i32), "the group leader is alive");
    assert!(!service.started_at.is_empty());

    let listed = core.list_project_services(project_id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, service.id);
    assert_eq!(
        core.project_service(service.id).unwrap().unwrap().status,
        ProjectServiceStatus::Running
    );

    core.stop_project_service(service.id).unwrap();
    assert!(wait_group_gone(service.pid));
}

#[test]
fn an_early_failure_returns_the_captured_output_and_leaves_no_service() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let error = core
        .start_project_service(project_id, None, "echo boom >&2; exit 7")
        .unwrap_err();

    let message = error.to_string();
    assert!(
        message.contains("boom"),
        "stderr is in the error: {message}"
    );
    assert!(
        message.contains('7'),
        "the exit code is in the error: {message}"
    );
    assert!(core.list_project_services(project_id).unwrap().is_empty());
    let registry: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(dir.path().join("processes.json")).unwrap()).unwrap();
    assert!(registry.is_empty(), "the group was unregistered");
}

#[test]
fn captures_stdout_and_stderr_lines() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(project_id, None, "echo out; echo err >&2; sleep 30")
            .unwrap(),
    );
    let (backlog, _rx) = core.subscribe_project_service_logs(service.id).unwrap();

    assert!(backlog.iter().any(|line| line.text == "out"));
    assert!(
        backlog
            .iter()
            .any(|line| line.text == "err"
                && line.stream == oxide_core::ProjectServiceStream::Stderr)
    );
    assert_eq!(backlog[0].seq, 0);

    core.stop_project_service(service.id).unwrap();
}

#[test]
fn the_log_buffer_keeps_the_newest_ten_thousand_lines_and_streams_live_output() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(
            project_id,
            None,
            "i=0; while [ $i -lt 10050 ]; do echo line-$i; i=$((i+1)); done; sleep 2; echo live-line; sleep 30",
        )
        .unwrap(),
    );
    let (backlog, rx) = core.subscribe_project_service_logs(service.id).unwrap();
    let mut seen = backlog;
    if seen.last().is_none_or(|line| line.text != "live-line") {
        loop {
            let line = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("timed out waiting for live output");
            let done = line.text == "live-line";
            seen.push(line);
            if done {
                break;
            }
        }
    }

    assert!(
        seen.iter().any(|line| line.text == "live-line"),
        "the live line arrived after the backlog"
    );
    assert!(
        seen.iter()
            .filter(|line| line.text.starts_with("line-"))
            .count()
            >= 10_000,
        "the backlog holds the most recent lines"
    );

    let (buffered, _rx) = core.subscribe_project_service_logs(service.id).unwrap();
    assert_eq!(buffered.len(), 10_000, "the buffer is capped");
    assert_eq!(buffered[0].text, "line-51", "the oldest lines were dropped");
    assert_eq!(buffered.last().unwrap().text, "live-line");
    assert!(
        buffered
            .iter()
            .all(|line| line.text != "line-0" && line.text != "line-50"),
        "lines older than the cap are gone"
    );

    core.stop_project_service(service.id).unwrap();
}

#[test]
fn detects_a_localhost_port_from_output() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(
            project_id,
            None,
            "printf 'http://localhost:49152\\n'; sleep 30",
        )
        .unwrap(),
    );

    assert!(
        wait_until(Duration::from_secs(5), || {
            core.project_service(service.id)
                .unwrap()
                .is_some_and(|service| service.port == Some(49152))
        }),
        "the port was detected"
    );
    let service = core.project_service(service.id).unwrap().unwrap();
    assert_eq!(service.url.as_deref(), Some("http://localhost:49152"));

    core.stop_project_service(service.id).unwrap();
}

#[test]
fn stop_terminates_the_group_marks_it_stopped_and_is_idempotent() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    let pid = service.pid;

    core.stop_project_service(service.id).unwrap();

    let stopped = core.project_service(service.id).unwrap().unwrap();
    assert_eq!(stopped.status, ProjectServiceStatus::Stopped);
    assert!(!group_alive(pid as i32));
    assert!(core.list_project_services(project_id).unwrap().is_empty());

    core.stop_project_service(service.id).unwrap();
}

#[test]
fn restart_reuses_the_id_and_runs_a_new_process() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let first = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    let first_pid = first.pid;

    let second = started(core.restart_project_service(first.id).unwrap());

    assert_eq!(second.id, first.id);
    assert_ne!(second.pid, first_pid);
    assert_eq!(second.status, ProjectServiceStatus::Running);
    assert_eq!(second.command, "sleep 30");
    assert!(!group_alive(first_pid as i32));
    assert!(group_alive(second.pid as i32));

    core.stop_project_service(second.id).unwrap();
}

#[test]
fn reports_service_lifecycle_events() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let events = core.subscribe_project_services();

    let service = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    let started = events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(started.kind, oxide_core::ProjectServiceEventKind::Started);
    assert_eq!(started.project_id, project_id);
    assert_eq!(started.service.id, service.id);

    core.stop_project_service(service.id).unwrap();
    let stopped = events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(stopped.kind, oxide_core::ProjectServiceEventKind::Stopped);
    assert_eq!(stopped.service.status, ProjectServiceStatus::Stopped);
}

#[test]
fn shutdown_stops_every_service_and_leaves_no_live_groups() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let first = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    let second = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );

    core.shutdown();

    assert!(!group_alive(first.pid as i32));
    assert!(!group_alive(second.pid as i32));
    assert!(core.list_project_services(project_id).unwrap().is_empty());
}

#[test]
fn closing_a_project_stops_its_services() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let service = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    let pid = service.pid;

    core.set_project_open(project_id, false).unwrap();

    assert!(wait_group_gone(pid));
    assert!(core.list_project_services(project_id).unwrap().is_empty());
    assert_eq!(
        core.project_service(service.id).unwrap().unwrap().status,
        ProjectServiceStatus::Stopped
    );
}

#[test]
fn starting_a_service_on_a_port_owned_by_another_service_is_a_conflict() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let port = free_port();

    let first = started(
        core.start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
            .unwrap(),
    );
    let outcome = core
        .start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
        .unwrap();

    let conflict = conflicted(outcome);
    assert_eq!(conflict.port, port);
    assert_eq!(
        conflict.existing.as_ref().map(|service| service.id),
        Some(first.id)
    );
    assert!(
        conflict.message.contains(&port.to_string()),
        "the message names the port: {}",
        conflict.message
    );
    assert!(
        conflict.message.contains("sleep 30"),
        "the message names the incumbent command: {}",
        conflict.message
    );
    assert!(
        conflict.message.contains(&first.pid.to_string()),
        "the message names the incumbent PID: {}",
        conflict.message
    );

    // The second spawn was refused: only the incumbent is running.
    let services = core.list_project_services(project_id).unwrap();
    assert_eq!(services.len(), 1);
    assert_eq!(services[0].id, first.id);
    assert!(group_alive(first.pid as i32));

    core.stop_project_service(first.id).unwrap();
}

#[test]
fn an_external_listener_on_the_port_is_a_conflict_without_an_incumbent() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    // Keep the listener alive for the whole check: this is a process Oxide does not own.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();

    let outcome = core
        .start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
        .unwrap();

    let conflict = conflicted(outcome);
    assert_eq!(conflict.port, port);
    assert!(conflict.existing.is_none());
    assert!(
        conflict.message.contains(&port.to_string()),
        "the message names the port: {}",
        conflict.message
    );
    assert!(core.list_project_services(project_id).unwrap().is_empty());
    drop(listener);
}

#[test]
fn restart_reuses_its_own_port_and_conflicts_with_another_service_holding_it() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let port = free_port();

    // B owns the port first, then stops, leaving it free for A.
    let b = started(
        core.start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
            .unwrap(),
    );
    core.stop_project_service(b.id).unwrap();
    assert_eq!(
        core.project_service(b.id).unwrap().unwrap().status,
        ProjectServiceStatus::Stopped
    );
    let a = started(
        core.start_project_service(project_id, None, &format!("PORT={port} sleep 30"))
            .unwrap(),
    );

    // A restarting itself must ignore its own (now stopped) record and re-bind its port.
    let restarted = started(core.restart_project_service(a.id).unwrap());
    assert_eq!(restarted.id, a.id);
    assert_ne!(restarted.pid, a.pid);
    assert_eq!(restarted.port, Some(port));
    assert!(group_alive(restarted.pid as i32));

    // B's stored command still asks for the port A now holds; the restart refuses to spawn.
    let conflict = conflicted(core.restart_project_service(b.id).unwrap());
    assert_eq!(conflict.port, port);
    assert_eq!(
        conflict.existing.as_ref().map(|service| service.id),
        Some(restarted.id)
    );
    let b_after = core.project_service(b.id).unwrap().unwrap();
    assert_eq!(b_after.status, ProjectServiceStatus::Stopped);
    assert!(!group_alive(b.pid as i32));

    core.stop_project_service(restarted.id).unwrap();
}

#[test]
fn a_command_without_an_explicit_port_still_spawns() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    // There is no port to check before the child writes one; output-only detection stays
    // post-spawn, so this path must keep working exactly as before.
    let service = started(
        core.start_project_service(project_id, None, "sleep 30")
            .unwrap(),
    );
    assert_eq!(service.status, ProjectServiceStatus::Running);
    assert_eq!(service.port, None);

    core.stop_project_service(service.id).unwrap();
}
