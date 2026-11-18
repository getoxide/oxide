use crate::agent_launch::{REPLAY_CAPACITY, ReplayBuffer};
use crate::{Error, Result};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TrySendError, bounded, unbounded};
use oxide_platform::terminal as os;
use oxide_provider::diag;
use oxide_provider::diag::SenderExt as _;
use oxide_provider::process::{ProcessRegistry, SHUTDOWN_GRACE};
use oxide_provider::sync::LockExt as _;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
}

pub struct TerminalSession {
    pub summary: TerminalSummary,
    commands: Sender<SessionCommand>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    /// The recent output of an Agent terminal, replayed when its Thread is shown again.
    replay: Option<Arc<Mutex<ReplayBuffer>>>,
    /// Whether the process ended successfully; `None` while it runs.
    exit: Arc<Mutex<Option<bool>>>,
    size: Mutex<(u16, u16)>,
}

/// Looks at everything an Agent terminal prints, in order, and returns what to write back to the
/// program (the answer to a terminal query), or nothing. It runs on the reading thread, so it
/// must not block.
pub type OutputObserver = Box<dyn FnMut(&[u8]) -> Vec<u8> + Send>;

/// Runs once when an Agent terminal's process ends, with whether it succeeded.
pub type ExitHook = Box<dyn Fn(bool) + Send>;

/// What an Agent terminal runs: a Provider CLI started from an argument array, never a shell.
pub struct AgentCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables removed from the inherited environment.
    pub env_remove: &'static [&'static str],
    /// Variables set in the agent's environment.
    pub env: Vec<(String, String)>,
}

enum SessionCommand {
    Write(Vec<u8>, Sender<std::io::Result<()>>),
    Resize(PtySize, Sender<std::result::Result<(), String>>),
    Close(Sender<()>),
}

impl TerminalSession {
    pub fn run_block(&self, command: &str, token: &str) -> Result<()> {
        if token.is_empty()
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || command.len() > 64 * 1024
        {
            return Err(Error::Terminal(
                "Invalid command block or command exceeds 64 KiB.".into(),
            ));
        }
        let script = os::block_script(token, command);
        self.write(script.as_bytes())
    }

    pub fn start(
        id: u32,
        home: &Path,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        blocks: bool,
    ) -> Result<Self> {
        let shell_init = if blocks {
            os::create_shell_init_file(home, id).map_err(|error| {
                Error::Terminal(format!("create terminal shell init file: {error}"))
            })?
        } else {
            None
        };
        let command = shell_command(cwd, blocks, shell_init.as_deref());
        Self::spawn(id, cwd, registry, command, shell_init, blocks, None)
    }

    /// Starts a Thread's Agent terminal: the Provider CLI in the Thread's checkout. `on_exit`
    /// runs once, from a Core thread, with whether the process succeeded, when it ends by itself
    /// or is closed.
    pub fn start_agent(
        id: u32,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        agent: &AgentCommand,
        observer: OutputObserver,
        on_exit: Box<dyn Fn(bool) + Send>,
    ) -> Result<Self> {
        let mut command = CommandBuilder::new(&agent.program);
        command.args(&agent.args);
        for name in agent.env_remove {
            command.env_remove(name);
        }
        for (name, value) in &agent.env {
            command.env(name, value);
        }
        command.cwd(dunce::simplified(cwd));
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        Self::spawn(
            id,
            cwd,
            registry,
            command,
            None,
            false,
            Some((observer, on_exit)),
        )
    }

    fn spawn(
        id: u32,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        mut command: CommandBuilder,
        shell_init: Option<PathBuf>,
        blocks: bool,
        agent_hooks: Option<(OutputObserver, ExitHook)>,
    ) -> Result<Self> {
        let (observer, on_exit) = match agent_hooks {
            Some((observer, on_exit)) => (Some(observer), Some(on_exit)),
            None => (None, None),
        };
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Terminal(format!("open terminal: {e}")))?;
        // Installers can update PATH after the GUI process started. New shells must
        // see the same Git/GitHub CLI executables that Core just detected.
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        for tool in ["git", "gh"] {
            if let Some(binary) = crate::desktop_tools::resolve(tool)
                && let Some(parent) = binary.parent()
            {
                dirs.push(parent.to_path_buf());
            }
        }
        if let Ok(path) = std::env::join_paths(dirs) {
            command.env("PATH", path);
        }
        let shell = command
            .get_argv()
            .first()
            .map(|arg| arg.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                if let Some(path) = &shell_init {
                    diag::best_effort("remove_file", std::fs::remove_file(path));
                }
                return Err(Error::Terminal(format!("start terminal shell: {error}")));
            }
        };
        let pid = match require_pid(child.process_id()) {
            Ok(pid) => pid,
            Err(error) => {
                diag::best_effort("kill", child.kill());
                diag::best_effort("wait", child.wait());
                if let Some(path) = &shell_init {
                    diag::best_effort("remove_file", std::fs::remove_file(path));
                }
                return Err(error);
            }
        };
        if let Err(error) = oxide_provider::process::attach_running_to_job(pid) {
            diag::best_effort("kill", child.kill());
            diag::best_effort("wait", child.wait());
            return Err(Error::Terminal(format!(
                "contain terminal shell process: {error}"
            )));
        }
        // The PTY child is a session leader, so it also leads its own process group (Unix only).
        let process_group = os::session_group(pid, pair.master.as_ref());
        if let Some(group) = process_group {
            registry.register(group, &shell);
        }
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::Terminal(format!("read terminal output: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))?;
        let subscribers = Arc::new(Mutex::new(Vec::<Sender<Vec<u8>>>::new()));
        let output_subscribers = Arc::clone(&subscribers);
        let agent = on_exit.is_some();
        let replay = agent.then(|| Arc::new(Mutex::new(ReplayBuffer::new(REPLAY_CAPACITY))));
        let output_replay = replay.clone();
        let (commands, receiver) = unbounded();
        let answers = commands.clone();
        std::thread::spawn(move || {
            read_output(
                reader,
                &output_subscribers,
                output_replay.as_deref(),
                blocks,
                observer.map(|observer| (observer, answers)),
            );
        });
        let exit = Arc::new(Mutex::new(None::<bool>));
        let actor_exit = Arc::clone(&exit);
        std::thread::spawn(move || {
            let mut writer = writer;
            let master = pair.master;
            loop {
                let command = if agent {
                    match receiver.recv_timeout(AGENT_POLL) {
                        Ok(command) => command,
                        Err(RecvTimeoutError::Timeout) => {
                            // The agent may end by itself (`/exit`, a crash).
                            if let Ok(Some(status)) = child.try_wait() {
                                finish_agent(&actor_exit, status.success(), on_exit.as_deref());
                                os::clean_up_session(process_group);
                                if let Some(group) = process_group {
                                    registry.unregister(group);
                                }
                                break;
                            }
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match receiver.recv() {
                        Ok(command) => command,
                        Err(_) => break,
                    }
                };
                match command {
                    SessionCommand::Write(input, reply) => {
                        let result = if agent {
                            // The agent reads Ctrl+C itself; Oxide never turns it into a signal.
                            writer.write_all(&input).and_then(|()| writer.flush())
                        } else {
                            os::write_input(&mut writer, &input, pid, master.as_ref())
                        };
                        reply.tell(result);
                    }
                    SessionCommand::Resize(size, reply) => {
                        let result = master.resize(size).map_err(|error| error.to_string());
                        reply.tell(result);
                    }
                    SessionCommand::Close(reply) => {
                        os::close_session(
                            process_group,
                            SHUTDOWN_GRACE,
                            &mut PtyShell(&mut *child),
                        );
                        if let Some(group) = process_group {
                            registry.unregister(group);
                        }
                        let status = child.wait();
                        if let Some(path) = shell_init {
                            diag::best_effort("remove_file", std::fs::remove_file(path));
                        }
                        if agent {
                            finish_agent(
                                &actor_exit,
                                status.is_ok_and(|status| status.success()),
                                on_exit.as_deref(),
                            );
                        }
                        reply.tell(());
                        break;
                    }
                }
            }
        });
        Ok(Self {
            summary: TerminalSummary {
                id,
                pid,
                cwd: dunce::simplified(cwd).to_string_lossy().into_owned(),
            },
            commands,
            subscribers,
            replay,
            exit,
            size: Mutex::new((24, 80)),
        })
    }

    /// What an Agent terminal printed most recently, and a feed of what it prints next. Both
    /// are taken under one lock, so no output falls between the replay and the feed.
    pub fn attach(&self) -> (Vec<u8>, Receiver<Vec<u8>>) {
        let Some(replay) = &self.replay else {
            return (Vec::new(), self.subscribe());
        };
        let replay = replay.lock_recover();
        let snapshot = replay.snapshot();
        // One view at a time: the one that was showing this Thread is gone, and ending its feed
        // ends the thread that pumps it.
        self.subscribers.lock_recover().clear();
        let feed = self.subscribe();
        (snapshot, feed)
    }

    /// Whether the process has ended, and if so whether it succeeded.
    pub fn exit_success(&self) -> Option<bool> {
        *self.exit.lock_recover()
    }

    /// Asks the program to draw its screen again by resizing one column narrower and back; a
    /// program only redraws when the size changes, and the replay holds the old screen.
    pub fn nudge_redraw(&self) -> Result<()> {
        let (rows, cols) = *self.size.lock_recover();
        self.resize_raw(rows, cols.saturating_sub(1).max(1))?;
        self.resize_raw(rows, cols)
    }

    pub fn subscribe(&self) -> Receiver<Vec<u8>> {
        let (tx, rx) = bounded(VIEW_BUFFER);
        self.subscribers.lock_recover().push(tx);
        rx
    }

    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let (reply, result) = bounded(1);
        self.commands
            .send(SessionCommand::Write(bytes.to_vec(), reply))
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?;
        result
            .recv()
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.resize_raw(rows, cols)?;
        *self.size.lock_recover() = (rows, cols);
        Ok(())
    }

    fn resize_raw(&self, rows: u16, cols: u16) -> Result<()> {
        let (reply, result) = bounded(1);
        self.commands
            .send(SessionCommand::Resize(
                PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                reply,
            ))
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?;
        result
            .recv()
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?
            .map_err(|e| Error::Terminal(format!("resize terminal: {e}")))
    }

    pub fn close(&self) {
        let (reply, result) = bounded(1);
        if self.commands.send(SessionCommand::Close(reply)).is_ok() {
            diag::best_effort("recv", result.recv());
        }
    }
}

/// The PTY child, as the platform layer closes it.
struct PtyShell<'a>(&'a mut (dyn portable_pty::Child + Send + Sync));

impl oxide_platform::ShellProcess for PtyShell<'_> {
    fn reap(&mut self) {
        diag::best_effort("try_wait", self.0.try_wait());
    }

    fn kill(&mut self) {
        diag::best_effort("kill", self.0.kill());
    }
}

/// The shell's process id; a PTY child that has none (or reports 0) fails the start instead of
/// letting 0 stand in as a process or group id.
fn require_pid(pid: Option<u32>) -> Result<u32> {
    match pid {
        Some(pid) if pid > 0 => Ok(pid),
        _ => Err(Error::Terminal(
            "terminal shell has no process id".to_string(),
        )),
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn shell_command(cwd: &Path, blocks: bool, shell_init: Option<&Path>) -> CommandBuilder {
    let launch = os::shell_launch(blocks, shell_init);
    let mut command = CommandBuilder::new(launch.program);
    command.args(launch.args);
    for (name, value) in launch.env {
        command.env(name, value);
    }
    command.cwd(dunce::simplified(cwd));
    command.env("TERM", "xterm-256color");
    command
}

/// How many chunks a terminal view may fall behind before the terminal gives up
/// on it. A terminal chunk is one PTY read, often a handful of bytes, so this is
/// the room a renderer gets to keep up with a chatty command.
const VIEW_BUFFER: usize = 1024;

/// Hands a chunk to every view, without ever waiting for one of them. A view that
/// stops reading (a backgrounded window, a test that stopped listening) would
/// otherwise block this reader — and with it the shell and every other view — as
/// soon as its buffer is full. Such a view has already missed output it can never
/// render, so it is dropped instead: its receiver ends and its reader stops.
fn deliver(subscribers: &Mutex<Vec<Sender<Vec<u8>>>>, chunk: &[u8]) {
    let mut subscribers = subscribers.lock_recover();
    subscribers.retain(|sender| match sender.try_send(chunk.to_vec()) {
        Ok(()) => true,
        Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
    });
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    subscribers: &Mutex<Vec<Sender<Vec<u8>>>>,
    replay: Option<&Mutex<ReplayBuffer>>,
    blocks: bool,
    mut observer: Option<(OutputObserver, Sender<SessionCommand>)>,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if let Some((observe, answers)) = &mut observer {
                    let answer = observe(&buffer[..count]);
                    if !answer.is_empty() {
                        // Nobody waits for the write's outcome: a program that is gone needs no answer.
                        let (reply, _) = bounded(1);
                        answers.tell(SessionCommand::Write(answer, reply));
                    }
                }
                match replay {
                    // Record and deliver under the replay lock, so a view attaching meanwhile gets
                    // each chunk exactly once, either in the replay or in its feed.
                    Some(replay) => {
                        let mut replay = replay.lock_recover();
                        replay.push(&buffer[..count]);
                        deliver(subscribers, &buffer[..count]);
                    }
                    None => deliver(subscribers, &buffer[..count]),
                }
            }
        }
    }
    if blocks {
        deliver(subscribers, b"\x1b]633;Oxide;closed\x07");
    }
}

/// How often an Agent terminal checks whether its process ended by itself.
const AGENT_POLL: Duration = Duration::from_millis(250);

/// Records how an agent ended, once, and tells the owner.
fn finish_agent(
    exit: &Mutex<Option<bool>>,
    success: bool,
    on_exit: Option<&(dyn Fn(bool) + Send)>,
) {
    let first = {
        let mut exit = exit.lock_recover();
        let first = exit.is_none();
        if first {
            *exit = Some(success);
        }
        first
    };
    if first && let Some(on_exit) = on_exit {
        on_exit(success);
    }
}

pub fn next_id(counter: &AtomicU32) -> u32 {
    counter.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pty_child_without_a_pid_fails_the_start() {
        assert!(matches!(require_pid(None), Err(Error::Terminal(_))));
        assert!(matches!(require_pid(Some(0)), Err(Error::Terminal(_))));
        assert_eq!(require_pid(Some(4242)).unwrap(), 4242);
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_starts_without_the_variables_it_is_told_to_drop() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(ProcessRegistry::open(dir.path().join("processes.json")));
        let agent = AgentCommand {
            program: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".into(),
                "echo \"PATH=[$PATH] HOME=[$HOME]\"; sleep 1".into(),
            ],
            env_remove: &["HOME"],
            env: Vec::new(),
        };
        let session = TerminalSession::start_agent(
            1,
            dir.path(),
            registry,
            &agent,
            Box::new(|_| Vec::new()),
            Box::new(|_| {}),
        )
        .unwrap();
        let (replay, feed) = session.attach();
        let mut seen = replay;
        while !String::from_utf8_lossy(&seen).contains("HOME=[") {
            seen.extend(feed.recv_timeout(Duration::from_secs(10)).unwrap());
        }
        let text = String::from_utf8_lossy(&seen).into_owned();
        assert!(text.contains("HOME=[]"), "{text}");
        assert!(!text.contains("PATH=[]"), "{text}");
        session.close();
        assert_eq!(session.exit_success(), Some(false));
    }
}
