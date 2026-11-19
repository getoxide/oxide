use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, TrySendError, bounded, unbounded};
use oxide_platform::diag;
use oxide_platform::diag::SenderExt as _;
use oxide_platform::registry::{ProcessRegistry, SHUTDOWN_GRACE};
use oxide_platform::sync::LockExt as _;
use oxide_platform::terminal as os;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

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
        Self::spawn(id, cwd, registry, command, shell_init, blocks)
    }

    fn spawn(
        id: u32,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        mut command: CommandBuilder,
        shell_init: Option<PathBuf>,
        blocks: bool,
    ) -> Result<Self> {
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
        if let Err(error) = oxide_platform::process::attach_running_to_job(pid) {
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
        let (commands, receiver) = unbounded();
        std::thread::spawn(move || {
            read_output(reader, &output_subscribers, blocks);
        });
        std::thread::spawn(move || {
            let mut writer = writer;
            let master = pair.master;
            loop {
                let Ok(command) = receiver.recv() else {
                    break;
                };
                match command {
                    SessionCommand::Write(input, reply) => {
                        let result = os::write_input(&mut writer, &input, pid, master.as_ref());
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
                        diag::best_effort("wait", child.wait());
                        if let Some(path) = shell_init {
                            diag::best_effort("remove_file", std::fs::remove_file(path));
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
        })
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
    blocks: bool,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                deliver(subscribers, &buffer[..count]);
            }
        }
    }
    if blocks {
        deliver(subscribers, b"\x1b]633;Oxide;closed\x07");
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
}
