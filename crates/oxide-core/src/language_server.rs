//! Local language servers. Core owns process lifetime and stdio framing; the editor owns LSP.
use crate::{Error, Result};
use crossbeam_channel::{Receiver, bounded};
use oxide_provider::bounded_lines::{BoundedLines, LOG_LINE_CAP, read_bounded_line};
use oxide_provider::command::find_in;
use oxide_provider::diag;
use oxide_provider::diag::SenderExt as _;
use oxide_provider::process::{
    ProcessRegistry, SHUTDOWN_GRACE, attach_child_to_job, release_job, spawn_in_own_group,
    terminate_group,
};
use oxide_provider::sync::LockExt as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const LANGUAGES: [(&str, &str, &str, &[&str]); 4] = [
    (
        "python",
        "Python · Pyright",
        "pyright-langserver",
        &["--stdio"],
    ),
    ("cpp", "C / C++ · clangd", "clangd", &[]),
    (
        "typescript",
        "JavaScript / TypeScript",
        "typescript-language-server",
        &["--stdio"],
    ),
    ("rust", "Rust · rust-analyzer", "rust-analyzer", &[]),
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub interpreter: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTool {
    pub language: String,
    pub name: String,
    pub config: LanguageServerConfig,
    pub installed: bool,
    pub resolved_path: Option<String>,
    pub install_command: String,
    pub documentation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerSummary {
    pub id: u32,
    pub root: String,
    pub language: String,
    pub initialization_options: String,
}

#[allow(clippy::needless_pass_by_value)]
fn failure(message: impl ToString) -> Error {
    Error::Editor(message.to_string())
}

fn definition(language: &str) -> Result<(&'static str, &'static str, &'static [&'static str])> {
    LANGUAGES
        .iter()
        .find(|d| d.0 == language)
        .map(|d| (d.1, d.2, d.3))
        .ok_or_else(|| failure("Unsupported language server."))
}

fn configurations(home: &Path) -> HashMap<String, LanguageServerConfig> {
    std::fs::read(home.join("language-servers.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn resolve(program: &str, home: &Path) -> Option<PathBuf> {
    let mut directories = vec![
        home.join("tools/language-servers/python/node_modules/.bin"),
        home.join("tools/language-servers/typescript/node_modules/.bin"),
        home.join("tools/language-servers/bin"),
    ];
    if let Some(user) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        directories.push(PathBuf::from(user).join(".cargo/bin"));
    }
    #[cfg(windows)]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(program_files).join("LLVM/bin"));
    }
    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/opt/llvm/bin"),
        PathBuf::from("/usr/local/opt/llvm/bin"),
    ]);
    directories.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    find_in(
        &std::env::join_paths(directories).ok()?,
        OsStr::new(program),
        std::env::var_os("PATHEXT").as_deref(),
    )
}

pub fn tools(home: &Path) -> Vec<LanguageTool> {
    let saved = configurations(home);
    let prefix = home
        .join("tools/language-servers")
        .to_string_lossy()
        .replace('"', "");
    LANGUAGES
        .iter()
        .map(|(id, name, command, args)| {
            let config = saved
                .get(*id)
                .cloned()
                .unwrap_or_else(|| LanguageServerConfig {
                    command: command.to_string(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    interpreter: None,
                });
            let resolved = resolve(&config.command, home);
            let install_command = match *id {
                "python" => format!(
                    "npm install --ignore-scripts --prefix \"{prefix}/python\" pyright@1.1.414"
                ),
                "typescript" => format!(
                    "npm install --ignore-scripts --prefix \"{prefix}/typescript\" typescript@6.0.3 typescript-language-server@6.0.2"
                ),
                "rust" => "rustup component add rust-analyzer".into(),
                _ if cfg!(windows) => "winget install --id LLVM.LLVM --exact".into(),
                _ if cfg!(target_os = "macos") => "brew install llvm".into(),
                _ => "sudo apt install clangd".into(),
            };
            let documentation = match *id {
                "python" => "https://github.com/microsoft/pyright/blob/main/docs/installation.md",
                "typescript" => {
                    "https://github.com/typescript-language-server/typescript-language-server"
                }
                "rust" => "https://rust-analyzer.github.io/book/installation.html",
                _ => "https://clangd.llvm.org/installation",
            };
            LanguageTool {
                language: id.to_string(),
                name: name.to_string(),
                installed: resolved.is_some(),
                resolved_path: resolved.map(|p| p.to_string_lossy().into_owned()),
                config,
                install_command,
                documentation: documentation.into(),
            }
        })
        .collect()
}

pub fn configure(home: &Path, language: &str, mut config: LanguageServerConfig) -> Result<()> {
    definition(language)?;
    let command = config.command.trim();
    if command.is_empty()
        || command.chars().any(char::is_control)
        || config.args.iter().any(|a| a.chars().any(char::is_control))
    {
        return Err(failure("Enter an executable path and valid arguments."));
    }
    // A path with directories must be absolute: a relative one would depend on the app's
    // working directory. A bare name is looked up in the same places the server starts from.
    let given = Path::new(command);
    if given.components().count() > 1 && !given.is_absolute() {
        return Err(failure("Enter the full path of the executable."));
    }
    // The absolute path as found, symlinks left in place: `~/.cargo/bin/rust-analyzer` is a
    // proxy that dispatches on its own name, and a Homebrew link must survive an upgrade. A
    // symlink is followed only to check that it ends at a regular file.
    let resolved = resolve(command, home)
        .and_then(|found| std::path::absolute(found).ok())
        .filter(|found| found.is_file())
        .ok_or_else(|| failure(format!("{command} is not an existing executable file.")))?;
    config.command = dunce::simplified(&resolved).to_string_lossy().into_owned();
    let path = home.join("language-servers.json");
    let mut saved: HashMap<String, LanguageServerConfig> = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path).map_err(failure)?)
            .map_err(|e| failure(format!("Repair language-servers.json before saving: {e}")))?
    } else {
        HashMap::new()
    };
    saved.insert(language.into(), config);
    let mut file = tempfile::NamedTempFile::new_in(home).map_err(failure)?;
    file.write_all(&serde_json::to_vec_pretty(&saved).map_err(failure)?)
        .map_err(failure)?;
    file.persist(home.join("language-servers.json"))
        .map_err(failure)?;
    Ok(())
}

pub struct LanguageServers {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    install_lock: Mutex<()>,
}
impl Default for LanguageServers {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
            install_lock: Mutex::new(()),
        }
    }
}
struct Session {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    registry: Arc<ProcessRegistry>,
    pid: i32,
}
impl Session {
    fn stop(&self) {
        let mut child = self.child.lock_recover();
        terminate_group(self.pid, SHUTDOWN_GRACE, || {
            diag::best_effort("try_wait", child.try_wait());
        });
        diag::best_effort("wait", child.wait());
        release_job(self.pid);
        self.registry.unregister(self.pid);
    }
}
impl LanguageServers {
    pub fn install(
        &self,
        home: &Path,
        language: &str,
        progress: impl Fn(&str),
    ) -> Result<LanguageTool> {
        definition(language)?;
        let _lock = self.install_lock.lock_recover();
        crate::language_install::install(home, language, &progress)?;
        tools(home)
            .into_iter()
            .find(|t| t.language == language)
            .ok_or_else(|| failure("Unknown language"))
    }
    pub fn start(
        &self,
        home: &Path,
        root: &Path,
        language: &str,
        registry: Arc<ProcessRegistry>,
    ) -> Result<(LanguageServerSummary, Receiver<String>)> {
        definition(language)?;
        let tool = tools(home)
            .into_iter()
            .find(|t| t.language == language)
            .ok_or_else(|| failure(format!("{language} has no language server tool")))?;
        let executable = tool.resolved_path.ok_or_else(|| {
            failure(format!(
                "{} is not installed. Open Language tools to install or configure it.",
                tool.name
            ))
        })?;
        let mut command = oxide_provider::command::resolved_command(&executable);
        command
            .args(tool.config.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let node = home.join("tools/node");
        let mut paths = vec![node.clone(), node.join("bin")];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
        let mut child = spawn_in_own_group(&mut command).spawn().map_err(failure)?;
        attach_child_to_job(&mut child).map_err(failure)?;
        let pid = child.id() as i32;
        registry.register(pid, &executable);
        let (Some(input), Some(output), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            diag::best_effort("kill", child.kill());
            registry.unregister(pid);
            return Err(failure("language server pipes were not available"));
        };
        let session = Arc::new(Session {
            child: Mutex::new(child),
            input: Mutex::new(input),
            registry,
            pid,
        });
        let (sender, receiver) = bounded(128);
        let errors = sender.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            while let Ok(Some(message)) = read_message(&mut reader) {
                if sender.send(message).is_err() {
                    return;
                }
            }
            sender.tell(
                serde_json::json!({"jsonrpc":"2.0", "method":"$/oxide/serverExited", "params":{}})
                    .to_string(),
            );
        });
        std::thread::spawn(move || {
            let mut stderr = BufReader::new(stderr);
            for line in
                BoundedLines::new(&mut stderr, LOG_LINE_CAP).map_while(std::result::Result::ok)
            {
                if errors.send(serde_json::json!({"jsonrpc":"2.0", "method":"window/logMessage", "params":{"type":4,"message":line.chars().take(2000).collect::<String>()}}).to_string()).is_err() { break; }
            }
            // A line over the cap ends the log feed; keep emptying the pipe so the server never blocks.
            diag::best_effort("copy", std::io::copy(&mut stderr, &mut std::io::sink()));
        });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions.lock_recover().insert(id, session);
        Ok((
            LanguageServerSummary {
                id,
                root: root.to_string_lossy().into_owned(),
                language: language.into(),
                initialization_options: if language == "typescript" {
                    let local = root.join("node_modules/typescript/lib/tsserver.js");
                    let managed = home.join(
                        "tools/language-servers/typescript/node_modules/typescript/lib/tsserver.js",
                    );
                    let sdk = if local.is_file() {
                        Some(local)
                    } else if managed.is_file() {
                        Some(managed)
                    } else {
                        None
                    };
                    serde_json::json!({"hostInfo":"oxide","tsserver":{"path":sdk.map(|path| path.to_string_lossy().into_owned())}}).to_string()
                } else {
                    "{}".into()
                },
            },
            receiver,
        ))
    }
    pub fn send(&self, id: u32, message: &str) -> Result<()> {
        if message.len() > MAX_MESSAGE {
            return Err(failure("Language server message is too large."));
        }
        serde_json::from_str::<serde_json::Value>(message).map_err(failure)?;
        let session = self
            .sessions
            .lock_recover()
            .get(&id)
            .cloned()
            .ok_or_else(|| failure("Language server stopped."))?;
        let mut input = session.input.lock_recover();
        write!(
            input,
            "Content-Length: {}\r\n\r\n{}",
            message.len(),
            message
        )
        .and_then(|_| input.flush())
        .map_err(failure)
    }
    pub fn stop(&self, id: u32) {
        if let Some(session) = self.sessions.lock_recover().remove(&id) {
            session.stop();
        }
    }
    pub fn shutdown(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock_recover()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.stop();
        }
    }
}

/// LSP headers may include Content-Type. Length is in bytes and may span arbitrary pipe reads.
fn read_message(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut length = None;
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        if !read_bounded_line(reader, &mut line, LOG_LINE_CAP)? {
            return Ok(None);
        }
        let header = String::from_utf8_lossy(&line);
        // The terminator is stripped by the reader; count it back for the total.
        total += header.len() + 2;
        if total > 8192 {
            return Err(std::io::Error::other("LSP header too large"));
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("Content-Length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length
        .filter(|n| *n <= MAX_MESSAGE)
        .ok_or_else(|| std::io::Error::other("Invalid LSP Content-Length"))?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_utf8_byte_lengths_multiple_messages_and_content_type() {
        let first = "{\"text\":\"è\"}";
        let wire = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}Content-Length: 2\r\n\r\n{{}}",
            first.len(),
            first
        );
        let mut reader = std::io::Cursor::new(wire);
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some(first));
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{}"));
        assert!(read_message(&mut reader).unwrap().is_none());
    }
    fn config(command: &str, args: &[&str]) -> LanguageServerConfig {
        LanguageServerConfig {
            command: command.into(),
            args: args.iter().map(|a| (*a).into()).collect(),
            interpreter: None,
        }
    }

    #[test]
    fn configuring_refuses_a_missing_executable_a_directory_and_a_relative_path() {
        let home = tempfile::tempdir().unwrap();
        let missing = home.path().join("nope");
        for command in [
            missing.to_string_lossy().into_owned(),
            home.path().to_string_lossy().into_owned(),
            "definitely-not-installed-oxide-ls".into(),
            "./relative/server".into(),
            "bad\ncommand".into(),
        ] {
            assert!(
                configure(home.path(), "python", config(&command, &[])).is_err(),
                "{command}"
            );
        }
        assert!(!home.path().join("language-servers.json").exists());
    }

    #[test]
    fn configuring_refuses_control_characters_in_arguments() {
        let home = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let command = executable.to_string_lossy();
        for argument in ["a\nb", "a\0b", "a\u{1b}[0m"] {
            assert!(configure(home.path(), "python", config(&command, &[argument])).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn configuring_keeps_a_symlink_as_given_and_refuses_a_dangling_one() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        // `rust-analyzer` in `~/.cargo/bin` is a link to `rustup`, which acts on its own name.
        let real = bin.join("rustup");
        std::fs::write(&real, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = bin.join("rust-analyzer");
        symlink(&real, &link).unwrap();
        let dangling = bin.join("gone");
        symlink(bin.join("missing"), &dangling).unwrap();

        configure(home.path(), "rust", config(&link.to_string_lossy(), &[])).unwrap();
        assert!(
            configure(
                home.path(),
                "python",
                config(&dangling.to_string_lossy(), &[])
            )
            .is_err()
        );

        let saved: HashMap<String, LanguageServerConfig> = serde_json::from_slice(
            &std::fs::read(home.path().join("language-servers.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["rust"].command, link.to_string_lossy());
    }

    #[test]
    fn configuring_stores_the_resolved_absolute_path() {
        let home = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        configure(
            home.path(),
            "python",
            config(
                &format!("  {}  ", executable.to_string_lossy()),
                &["--stdio"],
            ),
        )
        .unwrap();
        let saved = configurations(home.path());
        let stored = Path::new(&saved["python"].command);
        assert!(stored.is_absolute() && stored.is_file());
        assert_eq!(saved["python"].args, ["--stdio"]);
    }

    /// A server that never ends its header line must fail the session, not fill memory.
    #[test]
    fn a_header_line_over_the_cap_is_an_error_with_bounded_memory() {
        struct Endless(usize);
        impl std::io::Read for Endless {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                self.0 += out.len();
                assert!(
                    self.0 < 10 * 1024 * 1024,
                    "reader kept consuming past the cap"
                );
                out.fill(b'x');
                Ok(out.len())
            }
        }
        let mut reader = BufReader::new(Endless(0));
        let error = read_message(&mut reader).unwrap_err();
        assert!(oxide_provider::bounded_lines::is_line_too_long(&error));
    }
    #[test]
    fn rejects_unbounded_messages_and_invalid_utf8() {
        assert!(
            read_message(&mut std::io::Cursor::new(
                "Content-Length: 999999999\r\n\r\n"
            ))
            .is_err()
        );
        assert!(read_message(&mut std::io::Cursor::new(b"Content-Length: 1\r\n\r\n\xff")).is_err());
    }
}
