//! Terminal Threads (ADR-0017): a Thread whose centre is an Agent terminal, the Provider's own
//! CLI running in the Thread's checkout under a PTY that Core owns.
//!
//! The terminal belongs to Core, not to the webview: it keeps running while the user moves
//! around the app, and a view that attaches later gets the recent output replayed.

use crate::agent_launch::{
    ClaudeLaunch, MAX_DIMENSION, MAX_INPUT_BYTES, MIN_DIMENSION, NESTED_SESSION_ENV, claude_args,
    new_session_id,
};
use crate::agent_status::{
    Osc7501Event, Osc7501Parser, QUERY_REPLY, ReportedState, StatusGate, TurnChange, TurnEnd,
    TurnTracker, thread_status,
};
use crate::checkpoint::{self, Phase};
use crate::terminal::{AgentCommand, TerminalSession, next_id};
use crate::{Core, Error, PermissionMode, Result, ThreadStatus, ThreadSummary};
use crossbeam_channel::Receiver;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The running (or ended) agent of one terminal Thread.
pub(crate) struct AgentRun {
    id: u32,
    session: Arc<TerminalSession>,
    /// The user stopped it, so how it ended is not a failure.
    stopped: Arc<AtomicBool>,
}

pub(crate) type Agents = Arc<Mutex<HashMap<u32, Arc<AgentRun>>>>;

/// How long a status stays on the sidebar before the next one may replace it.
const STATUS_INTERVAL: Duration = Duration::from_millis(400);

/// What the reading side of an Agent terminal tells its status worker.
enum AgentSignal {
    Report(ReportedState),
    /// The agent ended; the Thread's status is now this.
    Ended(ThreadStatus),
}

/// What a view attaching to an Agent terminal receives: the replayed screen, then the live feed.
pub struct AgentAttachment {
    pub replay: Vec<u8>,
    pub feed: Receiver<Vec<u8>>,
}

/// The directories the Provider CLI is looked up in: the process `PATH` and where Claude Code's
/// installer puts it.
fn default_search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs
}

impl Core {
    /// Replaces the directories the Provider CLI is looked up in. Tests put a fake `claude`
    /// alone on it.
    pub fn set_agent_search_path(&self, dirs: Option<Vec<PathBuf>>) {
        *self
            .agent_search_path
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = dirs;
    }

    fn find_claude(&self) -> Result<PathBuf> {
        let dirs = self
            .agent_search_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(default_search_path);
        let path = std::env::join_paths(dirs)
            .map_err(|_| Error::Provider("Claude Code could not be looked up.".into()))?;
        oxide_provider::command::find_in(
            &path,
            std::ffi::OsStr::new("claude"),
            std::env::var_os("PATHEXT").as_deref(),
        )
        .ok_or_else(|| Error::Provider("Claude Code is not installed".to_string()))
    }

    /// Starts a new terminal Thread in the Project with Claude Code and the Settings defaults
    /// for Model, Effort and Permission mode.
    ///
    /// Starts a process (the Provider CLI, from an argument array) and, unless the Project keeps
    /// Threads in its main checkout, creates a worktree on `oxide/thread-<id>` and runs the
    /// Project's Setup command in it first. When the Setup command fails the Thread is kept in
    /// `error` with its output and no agent is started.
    pub fn start_terminal_thread(&self, project_id: u32) -> Result<ThreadSummary> {
        self.project(project_id)?;
        self.find_claude()?;
        let (model, effort, permission_mode) = self.default_settings_for_provider("claude");
        let session_id = new_session_id();
        let thread_id = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "INSERT INTO threads (project_id, provider, provider_session_id, model, effort, permission_mode, status, terminal) VALUES (?1, 'claude', ?2, ?3, ?4, ?5, 'running', 1)",
                rusqlite::params![project_id, session_id, model, effort, permission_mode.as_str()],
            )?;
            db.last_insert_rowid() as u32
        };
        let started = self.ensure_worktree(thread_id).and_then(|ready| {
            if ready {
                self.launch_agent(thread_id, false)?;
            } else {
                self.board.set_status(thread_id, ThreadStatus::Error);
            }
            Ok(())
        });
        if let Err(error) = started {
            // Nothing was started: leave no half-made Thread behind.
            let _ = self.delete_thread(thread_id, true);
            return Err(error);
        }
        self.thread_summary(thread_id)
    }

    /// Relaunches the agent of a stopped terminal Thread, resuming the same Provider session.
    ///
    /// Starts a process (the Provider CLI, from an argument array).
    pub fn restart_agent(&self, thread_id: u32) -> Result<ThreadSummary> {
        self.terminal_thread(thread_id)?;
        if self.agent_is_running(thread_id) {
            return Err(Error::Terminal("The agent is already running.".into()));
        }
        if !self.ensure_worktree(thread_id)? {
            self.board.set_status(thread_id, ThreadStatus::Error);
            return self.thread_summary(thread_id);
        }
        self.launch_agent(thread_id, true)?;
        self.thread_summary(thread_id)
    }

    /// Ends the Thread's agent. Stopping one that already ended does nothing.
    pub fn stop_agent(&self, thread_id: u32) -> Result<()> {
        self.terminal_thread(thread_id)?;
        let run = self
            .agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
            .cloned();
        if let Some(run) = run
            && run.session.exit_success().is_none()
        {
            run.stopped.store(true, Ordering::SeqCst);
            run.session.close();
        }
        Ok(())
    }

    /// Attaches a view to the Thread's Agent terminal: its recent output, then what it prints
    /// next. The program is asked to redraw, so the view shows its current screen rather than
    /// the replay of an old one. A newer attachment replaces the previous one.
    pub fn attach_agent_terminal(&self, thread_id: u32) -> Result<AgentAttachment> {
        let run = self.agent_run(thread_id)?;
        let (replay, feed) = run.session.attach();
        if run.session.exit_success().is_none() {
            let _ = run.session.nudge_redraw();
        }
        Ok(AgentAttachment { replay, feed })
    }

    /// Writes bytes the user typed (or pasted, or dropped as a quoted path) into the agent.
    pub fn write_agent_terminal(&self, thread_id: u32, bytes: &[u8]) -> Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(Error::Terminal(
                "That input is too large for the terminal.".into(),
            ));
        }
        let run = self.agent_run(thread_id)?;
        if run.session.exit_success().is_some() {
            return Err(Error::Terminal("The agent is not running.".into()));
        }
        run.session.write(bytes)
    }

    /// Tells the agent's terminal how big the view is.
    pub fn resize_agent_terminal(&self, thread_id: u32, rows: u16, cols: u16) -> Result<()> {
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&rows)
            || !(MIN_DIMENSION..=MAX_DIMENSION).contains(&cols)
        {
            return Err(Error::Terminal("That terminal size is not valid.".into()));
        }
        let run = self.agent_run(thread_id)?;
        run.session.resize(rows, cols)
    }

    /// Whether the Thread's agent process is alive.
    pub fn agent_is_running(&self, thread_id: u32) -> bool {
        self.agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
            .is_some_and(|run| run.session.exit_success().is_none())
    }

    /// Stops the Thread's agent for good and forgets its terminal (deleting the Thread).
    pub(crate) fn drop_agent(&self, thread_id: u32) {
        let run = self
            .agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&thread_id);
        if let Some(run) = run {
            run.stopped.store(true, Ordering::SeqCst);
            run.session.close();
        }
    }

    /// Stops every agent (quitting Oxide).
    pub(crate) fn close_agents(&self) {
        let runs: Vec<_> = self
            .agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for run in &runs {
            run.stopped.store(true, Ordering::SeqCst);
        }
        std::thread::scope(|scope| {
            for run in &runs {
                scope.spawn(|| run.session.close());
            }
        });
    }

    /// The Thread's Agent terminal; an unknown id or a chat Thread is refused.
    fn agent_run(&self, thread_id: u32) -> Result<Arc<AgentRun>> {
        self.terminal_thread(thread_id)?;
        self.agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
            .cloned()
            .ok_or_else(|| Error::Terminal("The agent is not running.".into()))
    }

    /// Refuses an id that is not a terminal Thread.
    fn terminal_thread(&self, thread_id: u32) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let terminal: Option<i64> = db
            .query_row(
                "SELECT terminal FROM threads WHERE id = ?1",
                [thread_id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        match terminal {
            Some(1) => Ok(()),
            Some(_) => Err(Error::Terminal(format!(
                "Thread {thread_id} has no Agent terminal."
            ))),
            None => Err(Error::Terminal(format!("Unknown Thread {thread_id}."))),
        }
    }

    /// Starts the agent process in the Thread's checkout and records it as running.
    fn launch_agent(&self, thread_id: u32, resume: bool) -> Result<()> {
        type Row = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
        );
        let (provider, session_id, model, effort, mode, checkout): Row = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row(
                "SELECT t.provider, t.provider_session_id, t.model, t.effort, t.permission_mode, COALESCE(t.worktree_path, p.path) FROM threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?1",
                [thread_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?
        };
        if provider != "claude" {
            return Err(Error::Provider(format!(
                "{provider} has no Agent terminal yet."
            )));
        }
        let session_id = session_id.unwrap_or_else(new_session_id);
        let args = claude_args(&ClaudeLaunch {
            session_id: &session_id,
            resume,
            model: model.as_deref(),
            effort: effort.as_deref(),
            permission_mode: mode.parse().unwrap_or(PermissionMode::AutoEdit),
        })?;
        let agent = AgentCommand {
            program: self.find_claude()?,
            args,
            env_remove: NESTED_SESSION_ENV,
        };
        let id = next_id(&self.next_terminal_id);
        let stopped = Arc::new(AtomicBool::new(false));
        if !resume {
            checkpoint::take_thread_start(std::path::Path::new(&checkout), thread_id);
        }
        let (signals, worker_signals) = crossbeam_channel::unbounded();
        let worker = StatusWorker {
            thread_id,
            run_id: id,
            checkout: PathBuf::from(&checkout),
            agents: Arc::clone(&self.agents),
            board: Arc::clone(&self.board),
        };
        std::thread::spawn(move || worker.run(&worker_signals));
        let observer_signals = signals.clone();
        let mut parser = Osc7501Parser::new();
        let observer = Box::new(move |output: &[u8]| {
            let mut answer = Vec::new();
            for event in parser.feed(output) {
                match event {
                    Osc7501Event::Report(state) => {
                        let _ = observer_signals.send(AgentSignal::Report(state));
                    }
                    Osc7501Event::Query => answer.extend_from_slice(QUERY_REPLY),
                }
            }
            answer
        });
        let exit_stopped = Arc::clone(&stopped);
        let on_exit = Box::new(move |success: bool| {
            let status = if success || exit_stopped.load(Ordering::SeqCst) {
                ThreadStatus::Stopped
            } else {
                ThreadStatus::Error
            };
            let _ = signals.send(AgentSignal::Ended(status));
        });
        // Held until the run is recorded, so an agent that ends at once is not missed by `on_exit`.
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let session = Arc::new(TerminalSession::start_agent(
            id,
            std::path::Path::new(&checkout),
            Arc::clone(&self.processes),
            &agent,
            observer,
            on_exit,
        )?);
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "UPDATE threads SET provider_session_id = ?1 WHERE id = ?2",
                rusqlite::params![session_id, thread_id],
            )?;
        }
        agents.insert(
            thread_id,
            Arc::new(AgentRun {
                id,
                session,
                stopped,
            }),
        );
        self.board.set_status(thread_id, ThreadStatus::Running);
        Ok(())
    }
}

/// Turns what the agent reports into the Thread's status, Turns and Checkpoints, in order and
/// off the thread that reads the terminal (a Checkpoint runs Git).
struct StatusWorker {
    thread_id: u32,
    run_id: u32,
    checkout: PathBuf,
    agents: Agents,
    board: Arc<crate::board::BoardHub>,
}

impl StatusWorker {
    /// A restart or a deletion may have replaced this run: what it says then is stale.
    fn is_current(&self) -> bool {
        self.agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&self.thread_id)
            .is_some_and(|run| run.id == self.run_id)
    }

    fn run(&self, signals: &Receiver<AgentSignal>) {
        let mut gate = StatusGate::new(STATUS_INTERVAL);
        let mut turns = TurnTracker::default();
        let mut open: Option<(u32, u32)> = None;
        loop {
            let signal = match gate.due() {
                Some(due) => {
                    match signals.recv_timeout(due.saturating_duration_since(Instant::now())) {
                        Ok(signal) => Some(signal),
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => None,
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match signals.recv() {
                    Ok(signal) => Some(signal),
                    Err(_) => break,
                },
            };
            match signal {
                None => {
                    if self.is_current()
                        && let Some(status) = gate.flush(Instant::now())
                    {
                        self.board.set_status(self.thread_id, status);
                    }
                }
                Some(AgentSignal::Report(state)) => {
                    if !self.is_current() {
                        continue;
                    }
                    match turns.apply(state) {
                        Some(TurnChange::Started) => {
                            if let Ok((id, index)) = self.board.start_agent_turn(self.thread_id) {
                                checkpoint::take(
                                    &self.checkout,
                                    self.thread_id,
                                    index,
                                    Phase::Start,
                                );
                                open = Some((id, index));
                            }
                        }
                        Some(TurnChange::Ended(end)) => {
                            let status = match end {
                                TurnEnd::Completed => "completed",
                                TurnEnd::Error => "error",
                            };
                            self.end_turn(&mut open, status);
                        }
                        None => {}
                    }
                    if let Some(status) = gate.offer(Instant::now(), thread_status(state)) {
                        self.board.set_status(self.thread_id, status);
                    }
                }
                Some(AgentSignal::Ended(status)) => {
                    self.end_turn(&mut open, "interrupted");
                    if self.is_current() {
                        self.board.set_status(self.thread_id, status);
                    }
                    break;
                }
            }
        }
    }

    fn end_turn(&self, open: &mut Option<(u32, u32)>, status: &str) {
        if let Some((id, index)) = open.take() {
            checkpoint::take(&self.checkout, self.thread_id, index, Phase::End);
            self.board.end_agent_turn(id, status);
        }
    }
}
