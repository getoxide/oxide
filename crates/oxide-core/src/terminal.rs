use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, TrySendError, bounded, unbounded};
use oxide_platform::ShellKind;
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
    /// The shell the Terminal runs, as the header names it: `zsh`, `bash` or `PowerShell`.
    pub shell: String,
}

pub struct TerminalSession {
    pub summary: TerminalSummary,
    commands: Sender<SessionCommand>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    /// The folder the shell reported at the end of its last block; `summary.cwd` until then.
    live_cwd: Arc<Mutex<String>>,
    /// The token of the block that runs now: only its `end` marker may move `live_cwd`.
    block_token: Arc<Mutex<Option<String>>>,
}

enum SessionCommand {
    Write(Vec<u8>, Sender<std::io::Result<()>>),
    Interrupt(Sender<std::io::Result<()>>),
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
        let script =
            os::block_script(token, command).map_err(|error| Error::Terminal(error.to_string()))?;
        *self.block_token.lock_recover() = Some(token.to_string());
        self.write(script.as_bytes())
    }

    pub fn start(
        id: u32,
        home: &Path,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        blocks: bool,
        shell: ShellKind,
        load_user_config: bool,
    ) -> Result<Self> {
        let shell_init = if blocks {
            os::create_shell_init_file(home, id, shell, load_user_config).map_err(|error| {
                Error::Terminal(format!("create terminal shell init file: {error}"))
            })?
        } else {
            None
        };
        let (command, shell_name) =
            shell_command(cwd, blocks, shell_init.as_deref(), shell, load_user_config);
        Self::spawn(id, cwd, registry, command, shell_name, shell_init, blocks)
    }

    fn spawn(
        id: u32,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        mut command: CommandBuilder,
        shell_name: String,
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
                    remove_shell_init(path);
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
                    remove_shell_init(path);
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
        let start_cwd = dunce::simplified(cwd).to_string_lossy().into_owned();
        let live_cwd = Arc::new(Mutex::new(start_cwd.clone()));
        let output_cwd = Arc::clone(&live_cwd);
        let block_token = Arc::new(Mutex::new(None::<String>));
        let output_token = Arc::clone(&block_token);
        let (commands, receiver) = unbounded();
        let output = OutputState {
            subscribers: output_subscribers,
            blocks,
            cwd: output_cwd,
            block_token: output_token,
        };
        std::thread::spawn(move || read_output(reader, &output));
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
                    SessionCommand::Interrupt(reply) => {
                        let result = os::force_interrupt_foreground(pid, master.as_ref());
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
                            remove_shell_init(&path);
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
                cwd: start_cwd,
                shell: shell_name,
            },
            commands,
            subscribers,
            live_cwd,
            block_token,
        })
    }

    /// The shell's current folder, as its last block `end` marker reported it.
    pub fn live_cwd(&self) -> String {
        self.live_cwd.lock_recover().clone()
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

    pub fn interrupt(&self) -> Result<()> {
        let (reply, result) = bounded(1);
        self.commands
            .send(SessionCommand::Interrupt(reply))
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?;
        result
            .recv()
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?
            .map_err(|e| Error::Terminal(format!("interrupt terminal: {e}")))
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

/// Removes what [`os::create_shell_init_file`] made: one rc file, or a folder of startup files.
fn remove_shell_init(path: &Path) {
    if path.is_dir() {
        diag::best_effort("remove_dir_all", std::fs::remove_dir_all(path));
    } else {
        diag::best_effort("remove_file", std::fs::remove_file(path));
    }
}

fn shell_command(
    cwd: &Path,
    blocks: bool,
    shell_init: Option<&Path>,
    shell: ShellKind,
    load_user_config: bool,
) -> (CommandBuilder, String) {
    let launch = os::shell_launch(blocks, shell_init, shell, load_user_config);
    let mut command = CommandBuilder::new(launch.program);
    command.args(launch.args);
    for (name, value) in launch.env {
        command.env(name, value);
    }
    command.cwd(dunce::simplified(cwd));
    command.env("TERM", "xterm-256color");
    // The renderer draws 24-bit colour; CLIs only use it when they are told so.
    command.env("COLORTERM", "truecolor");
    (command, launch.name)
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

/// What the output thread shares with the session.
struct OutputState {
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    blocks: bool,
    cwd: Arc<Mutex<String>>,
    block_token: Arc<Mutex<Option<String>>>,
}

fn read_output(mut reader: Box<dyn Read + Send>, state: &OutputState) {
    let mut buffer = [0_u8; 16 * 1024];
    let mut markers = ShellMarkers::default();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if state.blocks {
                    for marker in markers.push(&buffer[..count]) {
                        follow(state, marker);
                    }
                }
                deliver(&state.subscribers, &buffer[..count]);
            }
        }
    }
    if state.blocks {
        deliver(&state.subscribers, b"\x1b]633;Oxide;closed\x07");
    }
}

/// Moves the live folder to where the shell reports it is: at the end of the block that runs
/// now, or at a prompt outside any block. A marker a program prints inside a block, without its
/// random token, moves nothing.
fn follow(state: &OutputState, marker: ShellMarker) {
    let mut token = state.block_token.lock_recover();
    let folder = match marker {
        ShellMarker::Prompt { folder } => {
            if token.is_some() {
                return;
            }
            folder
        }
        ShellMarker::End {
            token: marked,
            folder,
        } => {
            if token.as_deref() != Some(marked.as_str()) {
                return;
            }
            *token = None;
            folder
        }
    };
    if Path::new(&folder).is_absolute() && Path::new(&folder).is_dir() {
        *state.cwd.lock_recover() = folder;
    }
}

/// A marker the shell hooks print: `ESC ] 633;Oxide;<token>;end;<exit>;<folder> BEL` at the end
/// of a block, `ESC ] 633;Oxide;prompt;<folder> BEL` at a prompt outside one.
#[derive(Debug, PartialEq)]
enum ShellMarker {
    End { token: String, folder: String },
    Prompt { folder: String },
}

/// Finds the `end` and `prompt` markers in PTY output, across reads.
#[derive(Default)]
struct ShellMarkers {
    pending: Vec<u8>,
}

impl ShellMarkers {
    const PREFIX: &'static [u8] = b"\x1b]633;Oxide;";
    /// Longer than any marker a shell prints; an unterminated one past it is dropped.
    const LIMIT: usize = 8 * 1024;

    /// The markers this chunk completed, in order.
    fn push(&mut self, chunk: &[u8]) -> Vec<ShellMarker> {
        self.pending.extend_from_slice(chunk);
        let mut found = Vec::new();
        let mut rest = 0;
        let mut open = false;
        while let Some(start) = find(&self.pending[rest..], Self::PREFIX).map(|at| rest + at) {
            let body = start + Self::PREFIX.len();
            let Some(length) = self.pending[body..].iter().position(|&b| b == 0x07) else {
                rest = start;
                open = true;
                break;
            };
            let marker = String::from_utf8_lossy(&self.pending[body..body + length]);
            if let Some(folder) = marker.strip_prefix("prompt;") {
                found.push(ShellMarker::Prompt {
                    folder: folder.to_string(),
                });
            } else {
                let mut fields = marker.splitn(4, ';');
                if let (Some(token), Some("end"), Some(_exit), Some(folder)) =
                    (fields.next(), fields.next(), fields.next(), fields.next())
                {
                    found.push(ShellMarker::End {
                        token: token.to_string(),
                        folder: folder.to_string(),
                    });
                }
            }
            rest = body + length + 1;
        }
        // Keep an open marker, or else only a tail that could start the next prefix.
        let keep_from = if open {
            rest
        } else {
            let tail = self.pending.len().saturating_sub(Self::PREFIX.len() - 1);
            tail.max(rest)
        };
        self.pending.drain(..keep_from);
        if self.pending.len() > Self::LIMIT {
            self.pending.clear();
        }
        found
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn next_id(counter: &AtomicU32) -> u32 {
    counter.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_are_read_across_split_reads() {
        let mut markers = ShellMarkers::default();
        assert_eq!(
            markers.push(b"out\x1b]633;Oxide;t1;start\x07error\r\n\x1b]63"),
            vec![]
        );
        assert_eq!(markers.push(b"3;Oxide;t1;end;1;/Users/some;one"), vec![]);
        assert_eq!(
            markers.push(b"\x07\x1b]633;Oxide;prompt;/a;b\x07"),
            vec![
                ShellMarker::End {
                    token: "t1".into(),
                    folder: "/Users/some;one".into()
                },
                ShellMarker::Prompt {
                    folder: "/a;b".into()
                },
            ]
        );
    }

    fn state(token: Option<&str>) -> OutputState {
        OutputState {
            subscribers: Arc::default(),
            blocks: true,
            cwd: Arc::new(Mutex::new("start".into())),
            block_token: Arc::new(Mutex::new(token.map(str::to_string))),
        }
    }

    #[test]
    fn only_the_running_block_or_a_prompt_outside_one_moves_the_folder() {
        let here = std::env::temp_dir().to_string_lossy().into_owned();
        let end = |token: &str, folder: &str| ShellMarker::End {
            token: token.into(),
            folder: folder.into(),
        };
        let prompt = |folder: &str| ShellMarker::Prompt {
            folder: folder.into(),
        };
        let state = state(Some("mine"));
        let cwd = || state.cwd.lock_recover().clone();
        // A program inside the block prints markers: neither moves the folder.
        follow(&state, end("other", &here));
        follow(&state, prompt(&here));
        assert_eq!(cwd(), "start");
        // A folder that is relative or does not exist is not one the shell is in.
        follow(&state, end("mine", "/no/such/oxide/folder"));
        assert_eq!(cwd(), "start");
        // The block's end counts once; then a prompt outside a block counts.
        let state = self::state(Some("mine"));
        let cwd = || state.cwd.lock_recover().clone();
        follow(&state, end("mine", &here));
        assert_eq!(cwd(), here);
        assert_eq!(*state.block_token.lock_recover(), None);
        follow(&state, end("mine", "/"));
        assert_eq!(cwd(), here);
        let root = std::env::temp_dir()
            .ancestors()
            .last()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        follow(&state, prompt(&root));
        assert_eq!(cwd(), root);
    }

    #[test]
    fn a_pty_child_without_a_pid_fails_the_start() {
        assert!(matches!(require_pid(None), Err(Error::Terminal(_))));
        assert!(matches!(require_pid(Some(0)), Err(Error::Terminal(_))));
        assert_eq!(require_pid(Some(4242)).unwrap(), 4242);
    }
}
