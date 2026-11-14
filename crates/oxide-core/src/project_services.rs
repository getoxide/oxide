//! Project Services: long-running background processes (dev servers, watchers) owned by a
//! Project. Each runs in its own process group, is registered with the [`ProcessRegistry`] and
//! streams its stdout/stderr into a bounded in-memory log ring.

use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, bounded};
use oxide_provider::process::{
    ProcessRegistry, SHUTDOWN_GRACE, attach_child_to_job, spawn_in_own_group, terminate_group,
};
use oxide_provider::time::now_rfc3339;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long a freshly spawned service must stay alive before it counts as running. An immediate
/// crash (a missing dependency, a syntax error) is reported back to the caller instead of being
/// left behind as a dead service.
pub const EARLY_FAILURE_GRACE: Duration = Duration::from_millis(1_500);

/// The number of log lines a Project Service keeps in memory. Older lines are dropped.
pub const LOG_CAPACITY: usize = 10_000;

/// How many lines a log subscriber may fall behind before it is dropped. Delivery never waits,
/// so a slow UI can never block the child process.
const LOG_VIEW_BUFFER: usize = 16_384;

/// How many Project Service events a subscriber may fall behind before it is dropped.
const EVENT_BUFFER: usize = 256;

/// How long the supervisor waits for the log readers to drain after an early exit.
const READER_DRAIN_GRACE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectServiceStatus {
    Running,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectServiceStream {
    Stdout,
    Stderr,
}

/// A Project Service as the sidebar, the log tab and agents see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectService {
    pub id: u32,
    pub project_id: u32,
    pub thread_id: Option<u32>,
    pub command: String,
    /// The checkout or worktree the service was started in.
    pub checkout: String,
    pub status: ProjectServiceStatus,
    pub pid: u32,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub started_at: String,
    pub exit_code: Option<i32>,
}

/// One line of a Project Service's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceLogLine {
    pub seq: u32,
    pub stream: ProjectServiceStream,
    pub text: String,
    pub at: String,
}

/// The result of asking for a Project Service to start.
///
/// A port conflict is a normal outcome, not an error: the frontend branches on `outcome` and an
/// agent Turn can report it and finish, rather than parsing prose out of an error message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", content = "payload", rename_all = "camelCase")]
pub enum ProjectServiceStartOutcome {
    Started(ProjectService),
    Conflict(ProjectServiceConflict),
}

/// Why a Project Service could not start: its target port was already taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceConflict {
    pub port: u16,
    /// The live Oxide-managed incumbent, when the port belongs to a Project Service.
    pub existing: Option<ProjectService>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectServiceEventKind {
    Started,
    Updated,
    Stopped,
    Removed,
    PortDetected,
}

/// A change to the set of Project Services, so the UI can refetch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceEvent {
    pub kind: ProjectServiceEventKind,
    pub project_id: u32,
    pub service: ProjectService,
}

#[derive(Default)]
struct EventHub {
    subscribers: Mutex<Vec<Sender<ProjectServiceEvent>>>,
}

impl EventHub {
    fn subscribe(&self) -> Receiver<ProjectServiceEvent> {
        let (sender, receiver) = bounded(EVENT_BUFFER);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(sender);
        receiver
    }

    fn deliver(&self, event: &ProjectServiceEvent) {
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subscribers.retain(|sender| sender.try_send(event.clone()).is_ok());
    }
}

struct ServiceState {
    summary: ProjectService,
    logs: VecDeque<ProjectServiceLogLine>,
    next_seq: u32,
    log_subscribers: Vec<Sender<ProjectServiceLogLine>>,
    /// Set by the supervisor once the process has been reaped.
    reaped: bool,
    /// The user asked for the service to stop, so a non-zero exit is not a failure.
    stop_requested: bool,
    /// Whether `Started` was announced; an early failure was never a live service.
    announced: bool,
}

struct Service {
    state: Mutex<ServiceState>,
    changed: Condvar,
    registry: Arc<ProcessRegistry>,
    events: Arc<EventHub>,
}

impl Service {
    fn summary(&self) -> ProjectService {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .summary
            .clone()
    }

    fn record_line(&self, stream: ProjectServiceStream, text: String) {
        let event = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let line = ProjectServiceLogLine {
                seq: state.next_seq,
                stream,
                text,
                at: now_rfc3339(),
            };
            state.next_seq = state.next_seq.wrapping_add(1);
            state.logs.push_back(line.clone());
            while state.logs.len() > LOG_CAPACITY {
                state.logs.pop_front();
            }
            state
                .log_subscribers
                .retain(|sender| sender.try_send(line.clone()).is_ok());

            let port = detect_port(&line.text);
            match port {
                Some(port) if state.summary.port != Some(port) || state.summary.url.is_none() => {
                    state.summary.port = Some(port);
                    state.summary.url = Some(url_for_port(&line.text, port));
                    Some(ProjectServiceEvent {
                        kind: ProjectServiceEventKind::PortDetected,
                        project_id: state.summary.project_id,
                        service: state.summary.clone(),
                    })
                }
                _ => None,
            }
        };
        if let Some(event) = event {
            self.events.deliver(&event);
        }
    }

    fn emit(&self, kind: ProjectServiceEventKind) {
        let summary = self.summary();
        self.events.deliver(&ProjectServiceEvent {
            kind,
            project_id: summary.project_id,
            service: summary,
        });
    }

    /// Terminates the process group (SIGTERM, then SIGKILL after [`SHUTDOWN_GRACE`]) and waits
    /// for the supervisor to reap it. Safe to call more than once.
    fn stop(&self) {
        let pid = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.summary.status != ProjectServiceStatus::Running {
                return;
            }
            state.stop_requested = true;
            state.summary.pid
        };
        if pid > 0 {
            terminate_group(pid as i32, SHUTDOWN_GRACE, || {});
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + SHUTDOWN_GRACE + Duration::from_secs(5);
        while !state.reaped {
            let now = Instant::now();
            if now >= deadline {
                state.summary.status = ProjectServiceStatus::Stopped;
                break;
            }
            let (guard, _) = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            state = guard;
        }
    }
}

struct ServiceManager {
    services: HashMap<u32, Arc<Service>>,
}

/// The Core-side registry of live and recently stopped Project Services.
pub struct ProjectServices {
    inner: Mutex<ServiceManager>,
    events: Arc<EventHub>,
    next_id: AtomicU32,
}

impl Default for ProjectServices {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectServices {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ServiceManager {
                services: HashMap::new(),
            }),
            events: Arc::new(EventHub::default()),
            next_id: AtomicU32::new(1),
        }
    }

    fn get(&self, id: u32) -> Option<Arc<Service>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .get(&id)
            .cloned()
    }

    pub fn start(
        &self,
        project_id: u32,
        thread_id: Option<u32>,
        command: &str,
        checkout: &str,
        registry: Arc<ProcessRegistry>,
    ) -> Result<ProjectServiceStartOutcome> {
        if command.trim().is_empty() {
            return Err(Error::ProjectService(
                "A Project Service needs a command.".into(),
            ));
        }
        let port = port_from_command(command);
        // Check before allocating or spawning anything: a conflict must not leave a child, a
        // registry entry or a service record behind. A port that only the output reveals cannot
        // be checked here; that detection stays post-spawn.
        if let Some(port) = port
            && let Some(conflict) = self.conflict_on_port(port, None)
        {
            return Ok(ProjectServiceStartOutcome::Conflict(conflict));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let service = Arc::new(Service {
            state: Mutex::new(ServiceState {
                summary: ProjectService {
                    id,
                    project_id,
                    thread_id,
                    command: command.to_string(),
                    checkout: checkout.to_string(),
                    status: ProjectServiceStatus::Running,
                    pid: 0,
                    port,
                    url: port.map(|port| format!("http://localhost:{port}")),
                    started_at: now_rfc3339(),
                    exit_code: None,
                },
                logs: VecDeque::with_capacity(LOG_CAPACITY.min(1024)),
                next_seq: 0,
                log_subscribers: Vec::new(),
                reaped: false,
                stop_requested: false,
                announced: false,
            }),
            changed: Condvar::new(),
            registry,
            events: Arc::clone(&self.events),
        });
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .insert(id, Arc::clone(&service));

        if let Err(error) = launch(&service) {
            self.remove(id);
            return Err(error);
        }
        match wait_for_startup(&service) {
            Ok(()) => {
                service.emit(ProjectServiceEventKind::Started);
                Ok(ProjectServiceStartOutcome::Started(service.summary()))
            }
            Err(_) => {
                let error = startup_error(&service);
                self.remove(id);
                Err(error)
            }
        }
    }

    pub fn list(&self, project_id: u32) -> Vec<ProjectService> {
        let mut services: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .values()
            .filter(|service| {
                let state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                state.summary.project_id == project_id
                    && state.summary.status == ProjectServiceStatus::Running
            })
            .map(|service| service.summary())
            .collect();
        services.sort_by_key(|service| service.id);
        services
    }

    pub fn service(&self, id: u32) -> Option<ProjectService> {
        self.get(id).map(|service| service.summary())
    }

    /// A conflict if `port` belongs to a live Project Service in any Project, or to another
    /// process. `excluding` lets a restart ignore the service it is restarting.
    fn conflict_on_port(
        &self,
        port: u16,
        excluding: Option<u32>,
    ) -> Option<ProjectServiceConflict> {
        if let Some(existing) = self.live_service_on_port(port, excluding) {
            return Some(ProjectServiceConflict {
                port,
                message: format!(
                    "Port {port} is already used by Project Service '{}' (PID {})",
                    existing.command, existing.pid
                ),
                existing: Some(existing),
            });
        }
        if !port_available(port) {
            return Some(ProjectServiceConflict {
                port,
                existing: None,
                message: format!("Port {port} is already in use by another process"),
            });
        }
        None
    }

    /// The live Project Service holding `port` across every Project, not just one.
    fn live_service_on_port(&self, port: u16, excluding: Option<u32>) -> Option<ProjectService> {
        let services: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .values()
            .cloned()
            .collect();
        services
            .into_iter()
            .map(|service| service.summary())
            .find(|summary| {
                Some(summary.id) != excluding
                    && summary.status == ProjectServiceStatus::Running
                    && summary.port == Some(port)
            })
    }

    pub fn subscribe_logs(
        &self,
        id: u32,
    ) -> Result<(Vec<ProjectServiceLogLine>, Receiver<ProjectServiceLogLine>)> {
        let service = self
            .get(id)
            .ok_or_else(|| Error::ProjectService(format!("unknown Project Service {id}")))?;
        let (sender, receiver) = bounded(LOG_VIEW_BUFFER);
        let backlog = {
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            state.log_subscribers.push(sender);
            state.logs.iter().cloned().collect()
        };
        Ok((backlog, receiver))
    }

    pub fn subscribe_events(&self) -> Receiver<ProjectServiceEvent> {
        self.events.subscribe()
    }

    pub fn stop(&self, id: u32) {
        if let Some(service) = self.get(id) {
            service.stop();
        }
    }

    pub fn stop_project(&self, project_id: u32) {
        let services: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .values()
            .filter(|service| {
                service
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .summary
                    .project_id
                    == project_id
            })
            .cloned()
            .collect();
        std::thread::scope(|scope| {
            for service in &services {
                scope.spawn(move || service.stop());
            }
        });
    }

    pub fn restart(&self, id: u32) -> Result<ProjectServiceStartOutcome> {
        let service = self
            .get(id)
            .ok_or_else(|| Error::ProjectService(format!("unknown Project Service {id}")))?;
        service.stop();
        let port = {
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            state.logs.clear();
            state.reaped = false;
            state.stop_requested = false;
            state.announced = false;
            state.summary.exit_code = None;
            state.summary.started_at = now_rfc3339();
            let port = port_from_command(&state.summary.command);
            state.summary.port = port;
            state.summary.url = port.map(|port| format!("http://localhost:{port}"));
            port
        };
        // The service is stopped by now, so its own record cannot be the incumbent: exclude it
        // explicitly anyway, in case the supervisor has not published the stop yet.
        if let Some(port) = port
            && let Some(conflict) = self.conflict_on_port(port, Some(id))
        {
            // Leave it stopped: the caller can switch to the incumbent or choose another port.
            // It never bound the port this time, so it must not advertise the one it asked for.
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            state.summary.port = None;
            state.summary.url = None;
            return Ok(ProjectServiceStartOutcome::Conflict(conflict));
        }
        {
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            state.summary.status = ProjectServiceStatus::Running;
        }
        if let Err(error) = launch(&service) {
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            state.summary.status = ProjectServiceStatus::Failed;
            state.reaped = true;
            drop(state);
            service.changed.notify_all();
            return Err(error);
        }
        match wait_for_startup(&service) {
            Ok(()) => {
                service.emit(ProjectServiceEventKind::Started);
                Ok(ProjectServiceStartOutcome::Started(service.summary()))
            }
            Err(_) => Err(startup_error(&service)),
        }
    }

    pub fn clear_logs(&self, id: u32) -> Result<()> {
        let service = self
            .get(id)
            .ok_or_else(|| Error::ProjectService(format!("unknown Project Service {id}")))?;
        service
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .logs
            .clear();
        Ok(())
    }

    /// Stops every service; called when Core shuts down, so no groups are left behind.
    pub fn shutdown(&self) {
        let services: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .values()
            .cloned()
            .collect();
        std::thread::scope(|scope| {
            for service in &services {
                scope.spawn(move || service.stop());
            }
        });
    }

    fn remove(&self, id: u32) {
        if let Some(service) = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .services
            .remove(&id)
        {
            service.emit(ProjectServiceEventKind::Removed);
        }
    }
}

/// Whether nothing is listening on `port` on loopback or the wildcard address. The probes are
/// released immediately: a conflicting check only needs the bind to fail.
fn port_available(port: u16) -> bool {
    for host in ["127.0.0.1", "0.0.0.0"] {
        match TcpListener::bind((host, port)) {
            Ok(listener) => drop(listener),
            Err(_) => return false,
        }
    }
    // IPv6 is best-effort: a listener on `::1` must be detected, but a host without IPv6 must
    // not make every port look taken.
    match TcpListener::bind(("::1", port)) {
        Ok(listener) => drop(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrNotAvailable => {}
        Err(_) => return false,
    }
    true
}

fn launch(service: &Arc<Service>) -> Result<()> {
    let summary = service.summary();
    let mut command = Command::new(shell());
    #[cfg(unix)]
    command.args(["-lc", &summary.command]);
    #[cfg(windows)]
    command.args(["/C", &summary.command]);
    command
        .current_dir(&summary.checkout)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_in_own_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        Error::ProjectService(format!(
            "Could not start Project Service `{}`: {error}",
            summary.command
        ))
    })?;
    let pid = child.id();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Error::ProjectService(
            "Project Service output was not captured".into(),
        ));
    };
    if let Err(error) = attach_child_to_job(&mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Error::ProjectService(format!(
            "Could not contain Project Service `{}`: {error}",
            summary.command
        )));
    }
    service.registry.register(pid as i32, shell());
    {
        let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
        state.summary.pid = pid;
        state.summary.exit_code = None;
        state.reaped = false;
    }

    let (drained, drain) = bounded(2);
    spawn_reader(
        stdout,
        ProjectServiceStream::Stdout,
        Arc::clone(service),
        drained.clone(),
    );
    spawn_reader(
        stderr,
        ProjectServiceStream::Stderr,
        Arc::clone(service),
        drained,
    );
    let supervised = Arc::clone(service);
    std::thread::spawn(move || supervise(&supervised, child, &drain));
    Ok(())
}

#[cfg(unix)]
fn shell() -> &'static str {
    "sh"
}

#[cfg(windows)]
fn shell() -> &'static str {
    "cmd.exe"
}

#[cfg(not(any(unix, windows)))]
fn shell() -> &'static str {
    "sh"
}

fn spawn_reader(
    reader: impl Read + Send + 'static,
    stream: ProjectServiceStream,
    service: Arc<Service>,
    drained: Sender<()>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                        buffer.pop();
                    }
                    service.record_line(stream, String::from_utf8_lossy(&buffer).into_owned());
                }
            }
        }
        let _ = drained.send(());
    });
}

fn supervise(service: &Arc<Service>, mut child: Child, drained: &Receiver<()>) {
    let status = child.wait().ok();
    let early = {
        let state = service.state.lock().unwrap_or_else(|e| e.into_inner());
        !state.announced
    };
    let pid = service.summary().pid;
    service.registry.unregister(pid as i32);
    if early {
        // A process that failed its startup check still owes the caller its output.
        let deadline = Instant::now() + READER_DRAIN_GRACE;
        let mut received = 0;
        while received < 2 {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            if drained.recv_timeout(deadline - now).is_err() {
                break;
            }
            received += 1;
        }
    }
    let announced = {
        let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
        let stopped = state.stop_requested;
        let success = status.as_ref().is_some_and(|status| status.success());
        state.summary.status = if stopped || success {
            ProjectServiceStatus::Stopped
        } else {
            ProjectServiceStatus::Failed
        };
        state.summary.exit_code = status.as_ref().and_then(|status| status.code());
        state.reaped = true;
        std::mem::replace(&mut state.announced, false)
    };
    service.changed.notify_all();
    if announced {
        service.emit(ProjectServiceEventKind::Stopped);
    }
}

/// Waits out the startup window, returning an error if the process exited inside it.
fn wait_for_startup(service: &Arc<Service>) -> Result<()> {
    let deadline = Instant::now() + EARLY_FAILURE_GRACE;
    let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
    while !state.reaped {
        let now = Instant::now();
        if now >= deadline {
            state.summary.status = ProjectServiceStatus::Running;
            state.announced = true;
            return Ok(());
        }
        let (guard, _) = service
            .changed
            .wait_timeout(state, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        state = guard;
    }
    Err(Error::ProjectService(
        "the Project Service exited during startup".into(),
    ))
}

fn startup_error(service: &Arc<Service>) -> Error {
    let state = service.state.lock().unwrap_or_else(|e| e.into_inner());
    let code = state
        .summary
        .exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".into());
    let tail: Vec<String> = state
        .logs
        .iter()
        .rev()
        .take(100)
        .rev()
        .map(|line| line.text.clone())
        .collect();
    Error::ProjectService(format!(
        "Project Service `{}` exited with code {code} during its {} startup check.\n{}",
        state.summary.command,
        humantime(EARLY_FAILURE_GRACE),
        tail.join("\n")
    ))
}

fn humantime(duration: Duration) -> String {
    format!("{:.1}s", duration.as_secs_f64())
}

/// The port a Project Service command line asks for (`--port N`, `--port=N`, `-p N`, `-p=N`,
/// `PORT=N`, or the positional port of `python -m http.server PORT`). Reusable by the terminal
/// and agent interception paths; the accepted syntax lives in
/// [`oxide_provider::port_in_command`] so the Rust paths cannot drift.
pub fn port_from_command(command: &str) -> Option<u16> {
    oxide_provider::port_in_command(command)
}

/// A localhost port mentioned in a service's output (`http://localhost:PORT`,
/// `127.0.0.1:PORT`, `0.0.0.0:PORT` or a bare `:PORT`).
pub fn detect_port(text: &str) -> Option<u16> {
    for marker in ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:"] {
        let mut rest = text;
        while let Some(index) = rest.find(marker) {
            let after = &rest[index + marker.len()..];
            if let Some(port) = parse_port_prefix(after) {
                return Some(port);
            }
            rest = after;
        }
    }

    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b':' {
            continue;
        }
        let previous = index.checked_sub(1).and_then(|index| bytes.get(index));
        let bare = match previous {
            None => true,
            Some(character) => {
                character.is_ascii_whitespace()
                    || matches!(character, b'\'' | b'"' | b'(' | b'[' | b'=' | b'>')
            }
        };
        if !bare {
            continue;
        }
        if let Some(port) = parse_port_prefix(&text[index + 1..]) {
            return Some(port);
        }
    }
    None
}

fn parse_port_prefix(text: &str) -> Option<u16> {
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let value: u32 = digits.parse().ok()?;
    (1..=65_535).contains(&value).then_some(value as u16)
}

/// A link a Project Service's log output may hand to the system browser: `http` on the
/// loopback host only. Anything else is refused, so arbitrary log text cannot open a page.
pub fn checked_local_url(url: &str) -> Result<&str> {
    if url
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(Error::ProjectService(format!("Unexpected link: {url}")));
    }
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| Error::ProjectService(format!("Unexpected link: {url}")))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return Err(Error::ProjectService(format!("Unexpected link: {url}")));
    }
    let host = if let Some(after_bracket) = authority.strip_prefix('[') {
        after_bracket
            .split_once(']')
            .map(|(host, _)| format!("[{host}]"))
    } else {
        Some(authority.split(':').next().unwrap_or_default().to_string())
    };
    match host.as_deref() {
        Some("localhost" | "127.0.0.1" | "[::1]") => Ok(url),
        _ => Err(Error::ProjectService(format!("Unexpected link: {url}"))),
    }
}

fn url_for_port(text: &str, port: u16) -> String {
    for scheme in ["http://", "https://"] {
        for host in ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"] {
            let needle = format!("{scheme}{host}:{port}");
            if let Some(index) = text.find(&needle) {
                let rest = &text[index + needle.len()..];
                if !rest.starts_with(|c: char| c.is_ascii_digit()) {
                    let host = if host == "0.0.0.0" { "localhost" } else { host };
                    return format!("{scheme}{host}:{port}");
                }
            }
        }
    }
    format!("http://localhost:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ports_from_command_lines() {
        assert_eq!(port_from_command("npm run dev --port 3000"), Some(3000));
        assert_eq!(port_from_command("vite --port=5173"), Some(5173));
        assert_eq!(port_from_command("serve -p 8080"), Some(8080));
        assert_eq!(port_from_command("PORT=4000 node server.js"), Some(4000));
        assert_eq!(port_from_command("python3 -m http.server 8000"), Some(8000));
        assert_eq!(port_from_command("npm run dev"), None);
        assert_eq!(port_from_command("echo -p"), None);
    }

    #[test]
    fn reads_ports_from_output() {
        assert_eq!(detect_port("Local: http://localhost:49152/"), Some(49152));
        assert_eq!(detect_port("running at 127.0.0.1:3001"), Some(3001));
        assert_eq!(detect_port("bound 0.0.0.0:8080"), Some(8080));
        assert_eq!(detect_port("listening on :9000"), Some(9000));
        assert_eq!(detect_port("at 12:34:56 nothing here"), None);
        assert_eq!(detect_port("https://example.com"), None);
    }

    #[test]
    fn normalises_urls_to_localhost() {
        assert_eq!(
            url_for_port("http://localhost:3000", 3000),
            "http://localhost:3000"
        );
        assert_eq!(
            url_for_port("http://0.0.0.0:3000", 3000),
            "http://localhost:3000"
        );
        assert_eq!(url_for_port("bare :3000", 3000), "http://localhost:3000");
    }

    #[test]
    fn only_loopback_http_links_reach_the_browser() {
        for url in [
            "http://localhost:3000",
            "http://localhost:3000/app?x=1",
            "http://127.0.0.1:8080",
            "http://[::1]:5173/path",
            "http://localhost",
        ] {
            assert_eq!(checked_local_url(url).unwrap(), url, "{url}");
        }
        for url in [
            "https://localhost:3000",
            "http://example.com",
            "http://localhost.example.com:3000",
            "http://user@localhost:3000",
            "http://localhost:3000@evil.example",
            "http://[::1]@evil.example",
            "http://127.0.0.1.evil.test",
            "http://localhost:3000\nhttps://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http:///path",
        ] {
            assert!(checked_local_url(url).is_err(), "{url} should be rejected");
        }
    }
}
