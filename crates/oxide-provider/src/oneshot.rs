//! One-shot headless Provider runs: start the Provider's CLI once, hand it a prompt, collect its
//! closing message and let the process end. Blind review uses this instead of an interactive
//! session, so it needs no chat adapter.
//!
//! A run is read-only by construction: each Provider is launched with its own read-only
//! configuration (Claude Code in plan mode with read tools only, Codex in its read-only sandbox),
//! never with a permission-widening flag. The prompt goes through stdin, never the command line.

use crate::ProviderError;
use crate::process::{self, ProcessRegistry};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The longest closing message a run may produce before Oxide stops reading.
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

/// How long a run may last before it is stopped.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneShotRequest {
    /// `claude` or `codex`.
    pub provider: String,
    /// The CLI to launch instead of the Provider's default name.
    pub command: Option<String>,
    pub working_dir: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub timeout: Duration,
}

impl OneShotRequest {
    pub fn new(
        provider: impl Into<String>,
        working_dir: impl Into<PathBuf>,
        prompt: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.into(),
            command: None,
            working_dir: working_dir.into(),
            prompt: prompt.into(),
            model: None,
            effort: None,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

/// Whether Oxide can run `provider` as a one-shot, read-only run.
pub fn supports_one_shot(provider: &str) -> bool {
    matches!(provider, "claude" | "codex")
}

/// A Model or Effort value that is safe to hand over as one argument: it names something, never
/// starts with `-` and holds no quote, control character or whitespace. Shared with the
/// interactive launch recipes.
pub fn is_flag_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'[' | b']' | b':' | b'/')
        })
}

/// The CLI arguments of a one-shot run. Read-only: Claude Code plan mode with read tools only,
/// the Codex read-only sandbox. The user's hooks, MCP servers and slash commands stay out, so
/// the reviewer sees only what Oxide sends.
pub fn one_shot_args(request: &OneShotRequest) -> Result<Vec<String>, ProviderError> {
    for value in [&request.model, &request.effort].into_iter().flatten() {
        if !is_flag_value(value) {
            return Err(ProviderError::NotAvailable(
                "the model or effort is not a plain value".into(),
            ));
        }
    }
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| (*s).to_string()));
    match request.provider.as_str() {
        "claude" => {
            push(&[
                "-p",
                "--output-format",
                "text",
                "--permission-mode",
                "plan",
                "--tools",
                "Read,Grep,Glob",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--settings",
                r#"{"disableAllHooks":true}"#,
            ]);
            if let Some(model) = &request.model {
                push(&["--model", model]);
            }
            if let Some(effort) = &request.effort {
                push(&["--effort", effort]);
            }
        }
        "codex" => {
            push(&[
                "exec",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
            ]);
            if let Some(model) = &request.model {
                push(&["-m", model]);
            }
            if let Some(effort) = &request.effort {
                push(&["-c", &format!("model_reasoning_effort=\"{effort}\"")]);
            }
            // `-` reads the prompt from stdin.
            push(&["-"]);
        }
        other => {
            return Err(ProviderError::NotAvailable(format!(
                "'{other}' cannot run one-shot"
            )));
        }
    }
    Ok(args)
}

fn default_command(provider: &str) -> &'static str {
    match provider {
        "codex" => "codex",
        _ => "claude",
    }
}

/// Runs the Provider once and returns its closing message. Fails when the CLI cannot start, exits
/// with an error, produces nothing, or outlasts `request.timeout`.
pub fn run_one_shot(
    request: &OneShotRequest,
    registry: Option<&Arc<ProcessRegistry>>,
) -> Result<String, ProviderError> {
    let args = one_shot_args(request)?;
    let program = request
        .command
        .clone()
        .unwrap_or_else(|| default_command(&request.provider).to_string());
    let mut cmd = crate::command::provider_command(&program, &Default::default());
    cmd.args(&args)
        .current_dir(&request.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if request.provider == "claude" {
        // The user's CLAUDE.md is not part of what a Blind review may see.
        cmd.env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1");
    }
    process::spawn_in_own_group(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| ProviderError::StartFailed(format!("failed to start `{program}`: {e}")))?;
    let pgid = child.id() as i32;
    if let Err(error) = process::attach_child_to_job(&mut child) {
        let _ = child.kill();
        return Err(ProviderError::StartFailed(format!(
            "failed to contain `{program}`: {error}"
        )));
    }
    if let Some(registry) = registry {
        registry.register(pgid, &program);
    }

    let stdin = process::require_pipe(child.stdin.take(), &mut child, "stdin")?;
    let stdout = process::require_pipe(child.stdout.take(), &mut child, "stdout")?;
    let stderr = process::require_pipe(child.stderr.take(), &mut child, "stderr")?;
    let prompt = request.prompt.clone();
    let writer = std::thread::spawn(move || {
        let mut stdin = stdin;
        // The CLI may exit before reading everything; that surfaces through its exit status.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.take(MAX_OUTPUT_BYTES).read_to_end(&mut out);
        out
    });
    let stderr_tail = process::drain_stderr(stderr);

    let deadline = Instant::now() + request.timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Whatever the outcome, nothing of the run may outlive it.
    process::terminate_group(pgid, Duration::from_secs(2), || {
        let _ = child.try_wait();
    });
    let _ = child.wait();
    let _ = writer.join();
    let output = reader.join().unwrap_or_default();
    let stderr_tail = stderr_tail.join().ok().flatten();
    if let Some(registry) = registry {
        registry.unregister(pgid);
    }
    process::release_job(pgid);

    if timed_out {
        return Err(ProviderError::CommandFailed(format!(
            "`{program}` did not finish within {} seconds",
            request.timeout.as_secs()
        )));
    }
    let Some(status) = status else {
        return Err(ProviderError::CommandFailed(format!(
            "could not wait for `{program}`"
        )));
    };
    if !status.success() {
        let detail = stderr_tail.unwrap_or_default();
        return Err(ProviderError::CommandFailed(format!(
            "`{program}` exited with {status}: {}",
            detail.trim()
        )));
    }
    let message = String::from_utf8_lossy(&output).trim().to_string();
    if message.is_empty() {
        return Err(ProviderError::CommandFailed(format!(
            "`{program}` produced no closing message"
        )));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str) -> OneShotRequest {
        OneShotRequest::new(provider, ".", "review this")
    }

    #[test]
    fn a_model_or_effort_that_is_not_a_plain_value_never_reaches_the_command_line() {
        for bad in ["high\"", "-x", "a b", "", &"a".repeat(129), "x\") -c foo=\"1"] {
            for provider in ["claude", "codex"] {
                let mut r = request(provider);
                r.effort = Some(bad.to_string());
                assert!(one_shot_args(&r).is_err(), "{provider} effort {bad:?}");
                let mut r = request(provider);
                r.model = Some(bad.to_string());
                assert!(one_shot_args(&r).is_err(), "{provider} model {bad:?}");
            }
        }
    }

    #[test]
    fn claude_runs_in_plan_mode_with_read_tools_only() {
        let mut r = request("claude");
        r.model = Some("opus".into());
        r.effort = Some("high".into());
        let args = one_shot_args(&r).unwrap();
        let has = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has("--permission-mode", "plan"));
        assert!(has("--tools", "Read,Grep,Glob"));
        assert!(has("--model", "opus"));
        assert!(has("--effort", "high"));
        for forbidden in [
            "acceptEdits",
            "bypassPermissions",
            "--dangerously-skip-permissions",
        ] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden}");
        }
        assert!(
            !args.iter().any(|a| a.contains("review this")),
            "no prompt in argv"
        );
    }

    #[test]
    fn codex_runs_in_its_read_only_sandbox_and_reads_the_prompt_from_stdin() {
        let mut r = request("codex");
        r.model = Some("gpt-x".into());
        r.effort = Some("low".into());
        let args = one_shot_args(&r).unwrap();
        let has = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has("--sandbox", "read-only"));
        assert!(has("-m", "gpt-x"));
        assert!(has("-c", "model_reasoning_effort=\"low\""));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(
            !args
                .iter()
                .any(|a| a.contains("danger") || a.contains("workspace-write"))
        );
    }

    #[test]
    fn a_provider_without_a_one_shot_mode_is_refused() {
        assert!(!supports_one_shot("agy"));
        assert!(matches!(
            one_shot_args(&request("agy")),
            Err(ProviderError::NotAvailable(_))
        ));
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn script(dir: &std::path::Path, body: &str) -> String {
            let path = dir.join("fake-cli");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        #[test]
        fn the_prompt_goes_through_stdin_and_the_closing_message_comes_back() {
            let dir = tempfile::tempdir().unwrap();
            let mut r = request("claude");
            r.working_dir = dir.path().to_path_buf();
            r.command = Some(script(
                dir.path(),
                r#"echo "args:$*"; echo "stdin:$(cat)"; echo "cwd:$(pwd -P)""#,
            ));
            let out = run_one_shot(&r, None).unwrap();
            assert!(out.contains("stdin:review this"), "{out}");
            assert!(
                !out.contains("args:")
                    || !out.split("stdin:").next().unwrap().contains("review this")
            );
            assert!(out.contains("--permission-mode plan"), "{out}");
            let real = dir.path().canonicalize().unwrap();
            assert!(out.contains(&format!("cwd:{}", real.display())), "{out}");
        }

        #[test]
        fn a_failing_cli_reports_its_error() {
            let dir = tempfile::tempdir().unwrap();
            let mut r = request("codex");
            r.working_dir = dir.path().to_path_buf();
            r.command = Some(script(dir.path(), "cat >/dev/null; echo boom >&2; exit 3"));
            let error = run_one_shot(&r, None).unwrap_err().to_string();
            assert!(error.contains("boom"), "{error}");
        }

        #[test]
        fn an_empty_closing_message_is_an_error() {
            let dir = tempfile::tempdir().unwrap();
            let mut r = request("codex");
            r.working_dir = dir.path().to_path_buf();
            r.command = Some(script(dir.path(), "cat >/dev/null"));
            assert!(run_one_shot(&r, None).is_err());
        }

        #[test]
        fn a_run_that_outlasts_its_timeout_is_stopped() {
            let dir = tempfile::tempdir().unwrap();
            let mut r = request("claude");
            r.working_dir = dir.path().to_path_buf();
            r.timeout = Duration::from_millis(300);
            r.command = Some(script(dir.path(), "sleep 30"));
            let started = Instant::now();
            let error = run_one_shot(&r, None).unwrap_err().to_string();
            assert!(error.contains("did not finish"), "{error}");
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }
}
