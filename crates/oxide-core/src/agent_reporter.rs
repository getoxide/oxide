//! The reporter (ADR-0016, ADR-0017): how Oxide learns the session id of a Provider that cannot
//! be given one, Codex today.
//!
//! Codex runs a per-launch `notify` command after each Turn. That command is Oxide's own
//! executable started with [`REPORTER_FLAG`]. It tells Oxide the session id over an owner-only
//! socket in the Oxide home, authenticated by a per-launch token, and then runs the user's own
//! `notify` command unchanged. Oxide never writes Codex's configuration files.
//!
//! The socket accepts one short JSON message of a session id and a status for one Agent terminal.
//! Input is bounded, a wrong token or an unknown field is refused, and nothing else is accepted.

// The socket is Unix-only for now; elsewhere only the chaining and the launch recipe remain.
#![cfg_attr(not(unix), allow(dead_code))]

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The first argument that makes Oxide's executable act as the reporter instead of the app.
pub const REPORTER_FLAG: &str = "--oxide-reporter";

/// The environment variables that carry the socket path and the per-launch token to the
/// reporter (through Codex, which passes its environment to `notify`).
pub(crate) const SOCKET_ENV: &str = "OXIDE_REPORTER_SOCKET";
pub(crate) const TOKEN_ENV: &str = "OXIDE_REPORTER_TOKEN";

/// The most bytes the socket reads from one connection.
pub(crate) const MAX_MESSAGE_BYTES: usize = 1024;

/// The most bytes of Codex's `notify` payload the reporter reads. Only two fields are used.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

/// The largest `config.toml` read to find the user's own `notify`.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// What happened in the Provider session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    /// A Turn ended.
    TurnComplete,
}

/// The one message the socket accepts.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    token: String,
    session_id: String,
    status: Status,
}

/// Called with the Agent terminal's Thread and the session id its token reported.
pub(crate) type OnReport = Arc<dyn Fn(u32, &str) + Send + Sync>;

/// Checks one message read from the socket and returns the Thread it speaks for.
fn accept(bytes: &[u8], tokens: &Mutex<HashMap<String, u32>>) -> Option<(u32, String)> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let report: Report = serde_json::from_slice(bytes).ok()?;
    if !crate::agent_launch::is_uuid(&report.session_id) {
        return None;
    }
    let thread = *tokens
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&report.token)?;
    let Status::TurnComplete = report.status;
    Some((thread, report.session_id))
}

/// The `notify` command of the user's own Codex configuration, for the reporter to chain.
/// Only reads `config.toml` in `codex_home`; a missing, oversized or malformed file or a `notify`
/// that is not a list of strings means no command.
pub(crate) fn user_notify_command(codex_home: &Path) -> Vec<String> {
    let path = codex_home.join("config.toml");
    let Ok(file) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    let mut text = String::new();
    {
        use std::io::Read;
        if file
            .take(MAX_CONFIG_BYTES)
            .read_to_string(&mut text)
            .is_err()
        {
            return Vec::new();
        }
    }
    let Ok(config) = text.parse::<toml::Table>() else {
        return Vec::new();
    };
    let Some(toml::Value::Array(items)) = config.get("notify") else {
        return Vec::new();
    };
    let command: Vec<String> = items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    if command.len() == items.len() && !command.is_empty() {
        command
    } else {
        Vec::new()
    }
}

/// Codex's home: `CODEX_HOME`, else `.codex` in the user's home.
pub(crate) fn codex_home(user_home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(|| user_home.join(".codex"), PathBuf::from)
}

/// The `notify` array Codex is launched with: Oxide's executable as the reporter, how many
/// arguments the user's own command has, and that command. Codex appends its JSON payload.
pub(crate) fn notify_array(executable: &Path, user_command: &[String]) -> Vec<String> {
    let mut array = vec![
        executable.to_string_lossy().into_owned(),
        REPORTER_FLAG.to_string(),
        user_command.len().to_string(),
    ];
    array.extend(user_command.iter().cloned());
    array
}

/// What Codex's `notify` payload says that the reporter uses.
#[derive(Deserialize)]
struct Payload {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "thread-id")]
    thread_id: Option<String>,
}

/// Runs the reporter: `args` are the arguments after [`REPORTER_FLAG`], `env` looks a variable
/// up. Starts the user's own command first so it is never held up, reports the session id, then
/// returns the user's exit code (0 when there is none). A failure to report is never fatal.
pub fn run_reporter(args: &[String], env: &dyn Fn(&str) -> Option<String>) -> i32 {
    let Some((count, rest)) = args.split_first() else {
        return 2;
    };
    let Ok(count) = count.parse::<usize>() else {
        return 2;
    };
    if rest.len() != count + 1 {
        return 2;
    }
    let (user, payload) = rest.split_at(count);
    let payload = &payload[0];

    let child = user.split_first().and_then(|(program, args)| {
        std::process::Command::new(program)
            .args(args)
            .arg(payload)
            .env_remove(SOCKET_ENV)
            .env_remove(TOKEN_ENV)
            .stdin(std::process::Stdio::null())
            .spawn()
            .ok()
    });

    if payload.len() <= MAX_PAYLOAD_BYTES
        && let Ok(parsed) = serde_json::from_str::<Payload>(payload)
        && parsed.kind.as_deref() == Some("agent-turn-complete")
        && let Some(session_id) = parsed.thread_id
        && let (Some(socket), Some(token)) = (env(SOCKET_ENV), env(TOKEN_ENV))
    {
        let _ = send_report(Path::new(&socket), &token, &session_id);
    }

    child
        .and_then(|mut child| child.wait().ok())
        .and_then(|status| status.code())
        .unwrap_or(0)
}

#[cfg(unix)]
fn send_report(socket: &Path, token: &str, session_id: &str) -> std::io::Result<()> {
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let message = serde_json::to_vec(&Report {
        token: token.to_string(),
        session_id: session_id.to_string(),
        status: Status::TurnComplete,
    })
    .map_err(std::io::Error::other)?;
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(&message)?;
    stream.shutdown(Shutdown::Write)?;
    let mut reply = Vec::new();
    stream.take(16).read_to_end(&mut reply)?;
    Ok(())
}

#[cfg(not(unix))]
fn send_report(_: &Path, _: &str, _: &str) -> std::io::Result<()> {
    Err(std::io::Error::other("no local socket on this OS"))
}

/// The socket Core listens on and the tokens it accepts, one per launched Agent terminal.
pub(crate) struct ReporterServer {
    inner: imp::Listener,
    tokens: Arc<Mutex<HashMap<String, u32>>>,
}

impl ReporterServer {
    /// Starts listening on an owner-only socket in `home`.
    pub(crate) fn start(home: &Path, on_report: OnReport) -> Result<Self> {
        let tokens: Arc<Mutex<HashMap<String, u32>>> = Arc::default();
        let inner = imp::Listener::start(home, Arc::clone(&tokens), on_report)?;
        Ok(Self { inner, tokens })
    }

    pub(crate) fn socket_path(&self) -> &Path {
        self.inner.path()
    }

    /// A new token for the Thread's launch; the Thread's earlier token stops working.
    pub(crate) fn register(&self, thread_id: u32) -> Result<String> {
        let token = random_token()?;
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, id| *id != thread_id);
        tokens.insert(token.clone(), thread_id);
        Ok(token)
    }

    /// Stops accepting the Thread's token (its agent ended for good).
    pub(crate) fn revoke(&self, thread_id: u32) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, id| *id != thread_id);
    }
}

/// 256 bits from the operating system's random source, as hexadecimal.
#[cfg(unix)]
fn random_token() -> Result<String> {
    use std::io::Read;
    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| Error::Provider(format!("No random token for the reporter: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(not(unix))]
fn random_token() -> Result<String> {
    Err(Error::Provider(
        "The session reporter is not available on this OS yet.".into(),
    ))
}

#[cfg(unix)]
mod imp {
    use super::{Arc, Error, HashMap, MAX_MESSAGE_BYTES, Mutex, OnReport, Path, PathBuf, Result};
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// The folder of the socket, `0700`, so the socket is never reachable by others even before
    /// its own mode is set. Short, because a socket path may hold about 100 bytes.
    const DIR: &str = "rp";
    const SOCKET: &str = "s";

    pub(super) struct Listener {
        path: PathBuf,
        stop: Arc<AtomicBool>,
    }

    impl Listener {
        pub(super) fn path(&self) -> &Path {
            &self.path
        }

        pub(super) fn start(
            home: &Path,
            tokens: Arc<Mutex<HashMap<String, u32>>>,
            on_report: OnReport,
        ) -> Result<Self> {
            let io = |e: std::io::Error| Error::Provider(format!("The session reporter: {e}"));
            let dir = home.join(DIR);
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir)
                .map_err(io)?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
            let path = dir.join(SOCKET);
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).map_err(io)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(io)?;
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = Arc::clone(&stop);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(stream) = stream {
                        serve(stream, &tokens, &on_report);
                    }
                }
            });
            Ok(Self { path, stop })
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wakes the blocked accept so the thread ends.
            let _ = UnixStream::connect(&self.path);
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn serve(mut stream: UnixStream, tokens: &Mutex<HashMap<String, u32>>, on_report: &OnReport) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let mut bytes = Vec::new();
        // One byte over the limit tells an oversized message from one that fits.
        let read = (&stream)
            .take(MAX_MESSAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes);
        let reply: &[u8] = match read.ok().and_then(|_| super::accept(&bytes, tokens)) {
            Some((thread, session)) => {
                on_report(thread, &session);
                b"ok\n"
            }
            None => b"refused\n",
        };
        let _ = stream.write_all(reply);
    }
}

#[cfg(not(unix))]
mod imp {
    use super::{Arc, Error, HashMap, Mutex, OnReport, Path, PathBuf, Result};

    pub(super) struct Listener(PathBuf);

    impl Listener {
        pub(super) fn path(&self) -> &Path {
            &self.0
        }

        pub(super) fn start(
            _: &Path,
            _: Arc<Mutex<HashMap<String, u32>>>,
            _: OnReport,
        ) -> Result<Self> {
            Err(Error::Provider(
                "The session reporter is not available on this OS yet.".into(),
            ))
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;

    const ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    struct Fixture {
        _dir: tempfile::TempDir,
        server: ReporterServer,
        reports: mpsc::Receiver<(u32, String)>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let (tx, reports) = mpsc::channel();
        let tx = Mutex::new(tx);
        let server = ReporterServer::start(
            dir.path(),
            Arc::new(move |thread, session| {
                let _ = tx.lock().unwrap().send((thread, session.to_string()));
            }),
        )
        .unwrap();
        Fixture {
            _dir: dir,
            server,
            reports,
        }
    }

    fn talk(f: &Fixture, bytes: &[u8]) -> String {
        let mut stream = UnixStream::connect(f.server.socket_path()).unwrap();
        let _ = stream.write_all(bytes);
        // An oversized message makes the server answer and hang up before the end is written.
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    fn message(token: &str) -> String {
        format!(r#"{{"token":"{token}","session_id":"{ID}","status":"turn-complete"}}"#)
    }

    #[test]
    fn a_report_with_the_launch_token_reaches_its_thread() {
        let f = fixture();
        let token = f.server.register(7).unwrap();
        assert_eq!(talk(&f, message(&token).as_bytes()), "ok\n");
        assert_eq!(
            f.reports
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            (7, ID.to_string())
        );
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let f = fixture();
        f.server.register(7).unwrap();
        for token in ["", "nope", &"0".repeat(64)] {
            assert_eq!(talk(&f, message(token).as_bytes()), "refused\n");
        }
        assert!(f.reports.try_recv().is_err());
    }

    #[test]
    fn a_token_stops_working_when_its_thread_launches_again_or_is_revoked() {
        let f = fixture();
        let old = f.server.register(7).unwrap();
        let new = f.server.register(7).unwrap();
        assert_eq!(talk(&f, message(&old).as_bytes()), "refused\n");
        assert_eq!(talk(&f, message(&new).as_bytes()), "ok\n");
        f.server.revoke(7);
        assert_eq!(talk(&f, message(&new).as_bytes()), "refused\n");
    }

    #[test]
    fn oversized_input_is_refused_even_when_it_starts_valid() {
        let f = fixture();
        let token = f.server.register(7).unwrap();
        let mut big = message(&token);
        big.push_str(&" ".repeat(MAX_MESSAGE_BYTES * 8));
        assert_ne!(talk(&f, big.as_bytes()), "ok\n");
        assert!(
            f.reports
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err()
        );
    }

    #[test]
    fn unknown_missing_and_malformed_fields_are_refused() {
        let f = fixture();
        let token = f.server.register(7).unwrap();
        for bad in [
            format!(
                r#"{{"token":"{token}","session_id":"{ID}","status":"turn-complete","extra":1}}"#
            ),
            format!(r#"{{"token":"{token}","session_id":"{ID}"}}"#),
            format!(r#"{{"token":"{token}","session_id":"{ID}","status":"exploded"}}"#),
            format!(r#"{{"token":"{token}","session_id":"--last","status":"turn-complete"}}"#),
            format!(r#"{{"token":"{token}","session_id":7,"status":"turn-complete"}}"#),
            "not json".to_string(),
            String::new(),
        ] {
            assert_eq!(talk(&f, bad.as_bytes()), "refused\n", "{bad}");
        }
        assert!(f.reports.try_recv().is_err());
    }

    #[test]
    fn the_socket_and_its_folder_are_owner_only() {
        let f = fixture();
        let socket = std::fs::metadata(f.server.socket_path()).unwrap();
        assert_eq!(socket.permissions().mode() & 0o077, 0);
        let dir = std::fs::metadata(f.server.socket_path().parent().unwrap()).unwrap();
        assert_eq!(dir.permissions().mode() & 0o077, 0);
    }

    #[test]
    fn dropping_the_server_removes_the_socket() {
        let f = fixture();
        let path = f.server.socket_path().to_path_buf();
        drop(f.server);
        assert!(!path.exists());
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let f = fixture();
        let a = f.server.register(1).unwrap();
        let b = f.server.register(2).unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    fn env_of(socket: &Path, token: &str) -> impl Fn(&str) -> Option<String> + use<> {
        let socket = socket.to_string_lossy().into_owned();
        let token = token.to_string();
        move |name| match name {
            SOCKET_ENV => Some(socket.clone()),
            TOKEN_ENV => Some(token.clone()),
            _ => None,
        }
    }

    fn payload() -> String {
        format!(
            r#"{{"type":"agent-turn-complete","thread-id":"{ID}","turn-id":"t","cwd":"/x","input-messages":["hi"],"last-assistant-message":"done"}}"#
        )
    }

    #[test]
    fn the_reporter_sends_the_session_id_of_a_finished_turn() {
        let f = fixture();
        let token = f.server.register(3).unwrap();
        let env = env_of(f.server.socket_path(), &token);
        assert_eq!(run_reporter(&["0".into(), payload()], &env), 0);
        assert_eq!(
            f.reports
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            (3, ID.to_string())
        );
    }

    #[test]
    fn the_reporter_ignores_other_events_and_survives_a_missing_socket() {
        let f = fixture();
        let token = f.server.register(3).unwrap();
        let env = env_of(f.server.socket_path(), &token);
        let other = payload().replace("agent-turn-complete", "something-else");
        assert_eq!(run_reporter(&["0".into(), other], &env), 0);
        assert_eq!(run_reporter(&["0".into(), "{".into()], &env), 0);
        assert!(f.reports.try_recv().is_err());
        assert_eq!(run_reporter(&["0".into(), payload()], &|_| None), 0);
        let gone = env_of(Path::new("/nonexistent/s"), "t");
        assert_eq!(run_reporter(&["0".into(), payload()], &gone), 0);
        assert_eq!(run_reporter(&[], &gone), 2);
        assert_eq!(run_reporter(&["x".into(), payload()], &gone), 2);
        assert_eq!(run_reporter(&["3".into(), payload()], &gone), 2);
    }

    #[test]
    fn the_users_own_notify_command_runs_with_the_payload_and_without_the_token() {
        let f = fixture();
        let token = f.server.register(3).unwrap();
        let env = env_of(f.server.socket_path(), &token);
        let out = f._dir.path().join("chained");
        let script = f._dir.path().join("hook.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s|%s|%s|%s' \"$1\" \"$3\" \"${OXIDE_REPORTER_TOKEN:-none}\" \"${OXIDE_REPORTER_SOCKET:-none}\" > \"$2\"\nexit 5\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let code = run_reporter(
            &[
                "3".into(),
                script.to_string_lossy().into_owned(),
                "mine".into(),
                out.to_string_lossy().into_owned(),
                payload(),
            ],
            &env,
        );
        // The script gets its own arguments, then the payload last, unchanged.
        assert_eq!(code, 5);
        assert_eq!(
            std::fs::read_to_string(&out).unwrap(),
            format!("mine|{}|none|none", payload())
        );
        assert!(
            f.reports
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok()
        );
    }

    #[test]
    fn the_users_notify_is_read_from_codex_config_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        assert!(user_notify_command(dir.path()).is_empty());
        let config = dir.path().join("config.toml");
        let text = "model = \"x\"\nnotify = [\"python3\", \"/me/hook.py\"]\n";
        std::fs::write(&config, text).unwrap();
        assert_eq!(user_notify_command(dir.path()), ["python3", "/me/hook.py"]);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
        for bad in [
            "notify = \"x\"",
            "notify = [1]",
            "notify = []",
            "[[[",
            "notify = [\"a\", 2]",
        ] {
            std::fs::write(&config, bad).unwrap();
            assert!(user_notify_command(dir.path()).is_empty(), "{bad}");
        }
    }

    #[test]
    fn the_notify_array_names_the_reporter_and_counts_the_users_command() {
        let array = notify_array(Path::new("/opt/oxide"), &["a".into(), "b".into()]);
        assert_eq!(array, ["/opt/oxide", REPORTER_FLAG, "2", "a", "b"]);
        assert_eq!(
            notify_array(Path::new("/opt/oxide"), &[]),
            ["/opt/oxide", REPORTER_FLAG, "0"]
        );
    }
}
