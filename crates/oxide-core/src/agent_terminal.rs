//! Terminal Threads (ADR-0017): a Thread whose centre is an Agent terminal, the Provider's own
//! CLI running in the Thread's checkout under a PTY that Core owns.
//!
//! The terminal belongs to Core, not to the webview: it keeps running while the user moves
//! around the app, and a view that attaches later gets the recent output replayed.

use crate::agent_launch::{
    ClaudeLaunch, CodexLaunch, MAX_DIMENSION, MAX_INPUT_BYTES, MIN_DIMENSION, NESTED_SESSION_ENV,
    bracketed_paste, claude_args, codex_args, issue_prompt, new_session_id,
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

/// What the user chose for a new terminal Thread; `None` takes the Settings default.
#[derive(Debug, Clone, Default)]
pub struct TerminalLaunch {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
}

/// The GitHub issue a terminal Thread starts from. The title and body are external content: they
/// reach the agent only quoted and marked as such.
#[derive(Debug, Clone)]
pub struct TerminalIssue {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub url: Option<String>,
    pub labels: Vec<String>,
}

/// The running (or ended) agent of one terminal Thread.
pub(crate) struct AgentRun {
    id: u32,
    session: Arc<TerminalSession>,
    /// The user stopped it, so how it ended is not a failure.
    stopped: Arc<AtomicBool>,
    /// The agent last reported that it waits for an answer (an Approval). Set as the report
    /// arrives, not when the sidebar catches up, so a paste can never answer it.
    needs_input: Arc<AtomicBool>,
    /// A resume printed that the Provider session no longer exists.
    session_gone: Arc<AtomicBool>,
}

/// What a Provider prints when resuming names a session that does not exist.
const CLAUDE_SESSION_GONE: &[u8] = b"No conversation found";
const CODEX_SESSION_GONE: &[u8] = b"No saved session found";

/// Finds a Provider's missing-session notice in a stream of output chunks, also when it is split
/// across two.
struct SessionGoneScanner {
    marker: &'static [u8],
    tail: Vec<u8>,
}

impl SessionGoneScanner {
    fn new(marker: &'static [u8]) -> Self {
        Self {
            marker,
            tail: Vec::new(),
        }
    }

    fn feed(&mut self, chunk: &[u8]) -> bool {
        self.tail.extend_from_slice(chunk);
        let marker = self.marker;
        let found = self.tail.windows(marker.len()).any(|w| w == marker);
        let keep = marker.len() - 1;
        if self.tail.len() > keep {
            self.tail.drain(..self.tail.len() - keep);
        }
        found
    }
}

/// Why an agent is launched.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// A new Thread: Oxide assigns the session id.
    Start,
    /// The user restarts a stopped agent: resume the stored session.
    Resume,
    /// The Thread is opened: resume the stored session unless something already launched it.
    Open,
    /// The user accepted a fresh session after the old one was gone.
    Fresh,
}

impl Launch {
    fn resumes(self) -> bool {
        matches!(self, Self::Resume | Self::Open)
    }
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

    fn find_provider(&self, provider: &str) -> Result<PathBuf> {
        let name = if provider == "codex" {
            "codex"
        } else {
            "claude"
        };
        let label = if provider == "codex" {
            "Codex"
        } else {
            "Claude Code"
        };
        let dirs = self
            .agent_search_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(default_search_path);
        let path = std::env::join_paths(dirs)
            .map_err(|_| Error::Provider(format!("{label} could not be looked up.")))?;
        oxide_provider::command::find_in(
            &path,
            std::ffi::OsStr::new(name),
            std::env::var_os("PATHEXT").as_deref(),
        )
        .ok_or_else(|| Error::Provider(format!("{label} is not installed")))
    }

    /// Starts a new terminal Thread in the Project with Claude Code and the Settings defaults
    /// for Model, Effort and Permission mode.
    ///
    /// Starts a process (the Provider CLI, from an argument array) and, unless the Project keeps
    /// Threads in its main checkout, creates a worktree on `oxide/thread-<id>` and runs the
    /// Project's Setup command in it first. When the Setup command fails the Thread is kept in
    /// `error` with its output and no agent is started.
    pub fn start_terminal_thread(&self, project_id: u32) -> Result<ThreadSummary> {
        self.start_terminal_thread_with(project_id, &TerminalLaunch::default())
    }

    /// Like [`Core::start_terminal_thread`], with the Provider, Model, Effort and Permission mode
    /// the user chose. What is left out comes from the Settings defaults. Only Providers with an
    /// Agent terminal are accepted, and the values are checked before anything is created.
    pub fn start_terminal_thread_with(
        &self,
        project_id: u32,
        choice: &TerminalLaunch,
    ) -> Result<ThreadSummary> {
        self.start_agent_thread(project_id, choice, None, None)
    }

    /// Starts a terminal Thread for a GitHub issue: a worktree on `oxide/<number>-<slug>`, the
    /// Setup command, then the agent launched with a prompt holding the issue's number, title and
    /// body (the title and body quoted and marked as external content).
    ///
    /// Starts a process (the Provider CLI, from an argument array).
    pub fn start_terminal_thread_from_issue(
        &self,
        project_id: u32,
        issue: &TerminalIssue,
        choice: &TerminalLaunch,
    ) -> Result<ThreadSummary> {
        let prompt = issue_prompt(issue.number, &issue.title, &issue.body);
        self.start_agent_thread(project_id, choice, Some(issue), Some(&prompt))
    }

    /// Starts a terminal Thread whose agent receives `prompt` as its first prompt.
    pub(crate) fn start_terminal_thread_with_prompt(
        &self,
        project_id: u32,
        choice: &TerminalLaunch,
        prompt: &str,
    ) -> Result<ThreadSummary> {
        self.start_agent_thread(project_id, choice, None, Some(prompt))
    }

    /// The shared start: the Thread, its checkout, then the agent with its first prompt if any.
    fn start_agent_thread(
        &self,
        project_id: u32,
        choice: &TerminalLaunch,
        issue: Option<&TerminalIssue>,
        prompt: Option<&str>,
    ) -> Result<ThreadSummary> {
        self.project(project_id)?;
        let provider = choice.provider.as_deref().unwrap_or("claude");
        if provider != "claude" && provider != "codex" {
            return Err(Error::Provider(format!(
                "{provider} has no Agent terminal yet."
            )));
        }
        let codex = provider == "codex";
        self.find_provider(provider)?;
        let (default_model, default_effort, default_mode) =
            self.default_settings_for_provider(provider);
        let model = choice.model.clone().or(default_model);
        let effort = choice.effort.clone().or(default_effort);
        // Codex has no Ask mode: a default of Ask becomes Auto-edit, a chosen Ask is refused.
        let default_mode = if codex && default_mode == PermissionMode::Ask {
            PermissionMode::AutoEdit
        } else {
            default_mode
        };
        let permission_mode = choice.permission_mode.unwrap_or(default_mode);
        // Refuse a value the CLI would take as a flag before a worktree exists.
        if codex {
            codex_args(&CodexLaunch {
                resume_session: None,
                model: model.as_deref(),
                effort: effort.as_deref(),
                permission_mode,
                notify: &[],
                initial_prompt: prompt,
            })?;
        } else {
            claude_args(&ClaudeLaunch {
                session_id: &new_session_id(),
                resume: false,
                model: model.as_deref(),
                effort: effort.as_deref(),
                permission_mode,
                initial_prompt: prompt,
            })?;
        }
        // Claude Code takes the id Oxide assigns; Codex's is reported after its first Turn.
        let session_id = (!codex).then(new_session_id);
        let thread_id = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "INSERT INTO threads (project_id, provider, provider_session_id, model, effort, permission_mode, status, terminal) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', 1)",
                rusqlite::params![
                    project_id,
                    provider,
                    session_id,
                    model,
                    effort,
                    permission_mode.as_str()
                ],
            )?;
            let thread_id = db.last_insert_rowid() as u32;
            if let Some(issue) = issue {
                db.execute(
                    "UPDATE threads SET issue_number = ?1, issue_title = ?2, issue_url = ?3, issue_labels = ?4 WHERE id = ?5",
                    rusqlite::params![
                        issue.number,
                        issue.title,
                        issue.url,
                        serde_json::to_string(&issue.labels).unwrap_or_else(|_| "[]".into()),
                        thread_id
                    ],
                )?;
            }
            thread_id
        };
        let started = self.ensure_worktree(thread_id).and_then(|ready| {
            if ready {
                self.launch_agent(thread_id, Launch::Start, prompt)?;
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
        self.launch_agent(thread_id, Launch::Resume, None)?;
        self.thread_summary(thread_id)
    }

    /// Opens a terminal Thread: after Oxide was relaunched its agent is stopped, and it is
    /// resumed now, when the Thread is opened, not at startup. An agent the user stopped, one
    /// that failed and one that runs are left alone.
    ///
    /// Starts a process (the Provider CLI, from an argument array).
    pub fn open_agent(&self, thread_id: u32) -> Result<ThreadSummary> {
        self.terminal_thread(thread_id)?;
        let launched = self
            .agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&thread_id);
        let stopped: bool = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row(
                "SELECT status = 'stopped' FROM threads WHERE id = ?1",
                [thread_id],
                |r| r.get(0),
            )?
        };
        if !launched && stopped {
            if self.ensure_worktree(thread_id)? {
                self.launch_agent(thread_id, Launch::Open, None)?;
            } else {
                self.board.set_status(thread_id, ThreadStatus::Error);
            }
        }
        self.thread_summary(thread_id)
    }

    /// Whether the last resume of the Thread's agent failed because its Provider session no
    /// longer exists. The Thread then offers a fresh session.
    pub fn agent_session_gone(&self, thread_id: u32) -> Result<bool> {
        self.terminal_thread(thread_id)?;
        Ok(self
            .agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
            .is_some_and(|run| {
                run.session.exit_success().is_some() && run.session_gone.load(Ordering::SeqCst)
            }))
    }

    /// Starts a new Provider session in the same checkout and branch, after the old one was
    /// found gone, and stores its id. This user action is the only way a Thread's session
    /// changes; it is refused while the session is not known to be gone.
    ///
    /// Starts a process (the Provider CLI, from an argument array).
    pub fn start_fresh_agent_session(&self, thread_id: u32) -> Result<ThreadSummary> {
        if !self.agent_session_gone(thread_id)? {
            return Err(Error::Terminal(
                "The Provider session has not been lost.".into(),
            ));
        }
        if !self.ensure_worktree(thread_id)? {
            self.board.set_status(thread_id, ThreadStatus::Error);
            return self.thread_summary(thread_id);
        }
        self.launch_agent(thread_id, Launch::Fresh, None)?;
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

    /// Pastes `prompt` into the Thread's agent as a bracketed paste, without Enter: the user
    /// submits it in the Provider's UI. Only called after the user confirmed this exact prompt.
    ///
    /// Refused while the agent waits for an answer, so a paste can never answer an Approval,
    /// and when the agent is not running.
    pub fn deliver_agent_prompt(&self, thread_id: u32, prompt: &str) -> Result<()> {
        let run = self.agent_run(thread_id)?;
        if run.session.exit_success().is_some() {
            return Err(Error::Terminal("The agent is not running.".into()));
        }
        if run.needs_input.load(Ordering::SeqCst) {
            return Err(Error::Terminal(
                "The agent is waiting for an answer. Answer it in the terminal, then send again."
                    .into(),
            ));
        }
        run.session.write(&bracketed_paste(prompt)?)
    }

    /// Whether the Thread is a terminal Thread (its agent runs in an Agent terminal).
    pub fn is_terminal_thread(&self, thread_id: u32) -> bool {
        self.terminal_thread(thread_id).is_ok()
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
        if let Some(server) = self
            .reporter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            server.revoke(thread_id);
        }
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

    /// Starts the agent process in the Thread's checkout and records it as running. `prompt` is
    /// the first prompt of a new session; a resumed session is never given one.
    fn launch_agent(&self, thread_id: u32, launch: Launch, prompt: Option<&str>) -> Result<()> {
        let resume = launch.resumes();
        if launch == Launch::Open
            && self
                .agents
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&thread_id)
        {
            return Ok(());
        }
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
        if provider != "claude" && provider != "codex" {
            return Err(Error::Provider(format!(
                "{provider} has no Agent terminal yet."
            )));
        }
        let permission_mode = mode.parse().unwrap_or(PermissionMode::AutoEdit);
        // A session id to store: Claude Code's is assigned here, Codex's is reported later, so a
        // Codex Thread that never finished a Turn has none and starts over instead of resuming.
        let (session_id, resume, args, env) = if provider == "codex" {
            let session_id = if launch == Launch::Fresh {
                None
            } else {
                session_id
            };
            let resume_session = session_id.as_deref().filter(|_| resume);
            let (notify, env) = self.codex_reporter(thread_id)?;
            let args = codex_args(&CodexLaunch {
                resume_session,
                model: model.as_deref(),
                effort: effort.as_deref(),
                permission_mode,
                notify: &notify,
                initial_prompt: if resume { None } else { prompt },
            })?;
            let resumed = resume_session.is_some();
            (session_id, resumed, args, env)
        } else {
            let session_id = if launch == Launch::Fresh {
                new_session_id()
            } else {
                session_id.unwrap_or_else(new_session_id)
            };
            let args = claude_args(&ClaudeLaunch {
                session_id: &session_id,
                resume,
                model: model.as_deref(),
                effort: effort.as_deref(),
                permission_mode,
                initial_prompt: if resume { None } else { prompt },
            })?;
            (Some(session_id), resume, args, Vec::new())
        };
        let agent = AgentCommand {
            program: self.find_provider(&provider)?,
            args,
            env_remove: NESTED_SESSION_ENV,
            env,
        };
        let id = next_id(&self.next_terminal_id);
        let stopped = Arc::new(AtomicBool::new(false));
        if launch == Launch::Start {
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
        let needs_input = Arc::new(AtomicBool::new(false));
        let observed_needs_input = Arc::clone(&needs_input);
        let session_gone = Arc::new(AtomicBool::new(false));
        let gone_flag = Arc::clone(&session_gone);
        let mut scanner = SessionGoneScanner::new(if provider == "codex" {
            CODEX_SESSION_GONE
        } else {
            CLAUDE_SESSION_GONE
        });
        let observer = Box::new(move |output: &[u8]| {
            if resume && scanner.feed(output) {
                gone_flag.store(true, Ordering::SeqCst);
            }
            let mut answer = Vec::new();
            for event in parser.feed(output) {
                match event {
                    Osc7501Event::Report(state) => {
                        observed_needs_input.store(
                            thread_status(state) == ThreadStatus::NeedsInput,
                            Ordering::SeqCst,
                        );
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
        if launch == Launch::Open && agents.contains_key(&thread_id) {
            return Ok(());
        }
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
            // Codex's id stays what the reporter stored; a fresh session clears the old one.
            if provider == "claude" || launch == Launch::Fresh {
                db.execute(
                    "UPDATE threads SET provider_session_id = ?1 WHERE id = ?2",
                    rusqlite::params![session_id, thread_id],
                )?;
            }
        }
        agents.insert(
            thread_id,
            Arc::new(AgentRun {
                id,
                session,
                stopped,
                needs_input,
                session_gone,
            }),
        );
        self.board.set_status(thread_id, ThreadStatus::Running);
        Ok(())
    }
}

/// The `notify` command and the environment a Codex launch is given.
type ReporterLaunch = (Vec<String>, Vec<(String, String)>);

impl Core {
    /// What a Codex launch needs from the reporter: the `notify` command (Oxide's executable,
    /// then the user's own command) and the environment carrying the socket and a token that is
    /// new for this launch. Starts listening on the first call.
    fn codex_reporter(&self, thread_id: u32) -> Result<ReporterLaunch> {
        let executable = match self
            .reporter_executable
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            Some(path) => path,
            None => std::env::current_exe()
                .map_err(|e| Error::Provider(format!("Oxide's executable is unknown: {e}")))?,
        };
        let user = crate::agent_reporter::user_notify_command(&crate::agent_reporter::codex_home(
            &self.user_home,
        ));
        let mut reporter = self.reporter.lock().unwrap_or_else(|e| e.into_inner());
        if reporter.is_none() {
            let storage = self.storage.clone();
            *reporter = Some(crate::agent_reporter::ReporterServer::start(
                &self.home,
                Arc::new(move |thread, session| {
                    storage.set_provider_session_id_if_unset(thread, session.to_string());
                }),
            )?);
        }
        let Some(server) = reporter.as_ref() else {
            return Err(Error::Provider(
                "The session reporter is not running.".into(),
            ));
        };
        let token = server.register(thread_id)?;
        let env = vec![
            (
                crate::agent_reporter::SOCKET_ENV.to_string(),
                server.socket_path().to_string_lossy().into_owned(),
            ),
            (crate::agent_reporter::TOKEN_ENV.to_string(), token),
        ];
        Ok((crate::agent_reporter::notify_array(&executable, &user), env))
    }

    /// Replaces the executable Codex runs as the reporter. Tests use a stand-in.
    pub fn set_reporter_executable(&self, path: Option<PathBuf>) {
        *self
            .reporter_executable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = path;
    }

    /// The socket of the session reporter, once a Codex Thread has started it.
    pub fn reporter_socket(&self) -> Option<PathBuf> {
        self.reporter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|server| server.socket_path().to_path_buf())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_missing_session_notice_is_found_whole_or_split_across_chunks() {
        let mut whole = SessionGoneScanner::new(CLAUDE_SESSION_GONE);
        assert!(whole.feed(b"x\r\nNo conversation found with session ID: a\r\n"));
        let mut split = SessionGoneScanner::new(CLAUDE_SESSION_GONE);
        assert!(!split.feed(b"No conv"));
        assert!(split.feed(b"ersation found"));
        let mut other = SessionGoneScanner::new(CLAUDE_SESSION_GONE);
        assert!(!other.feed(b"All conversations are here"));
    }

    #[test]
    fn codexs_missing_session_notice_is_found_too() {
        let mut scanner = SessionGoneScanner::new(CODEX_SESSION_GONE);
        assert!(!scanner.feed(b"ERROR: No saved ses"));
        assert!(scanner.feed(b"sion found with ID x"));
    }
}
