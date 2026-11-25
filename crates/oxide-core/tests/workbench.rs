#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::disallowed_methods,
    reason = "integration tests: a failed unwrap or panic is a test failure; fixtures start their own repositories and share state through plain mutexes"
)]
use oxide_core::Core;
use oxide_core::diag;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fixture() -> (tempfile::TempDir, Core, u32) {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    std::fs::create_dir_all(project.join("subdir")).unwrap();
    let core = Core::open(temporary.path().join("home")).unwrap();
    let id = core.add_project(&project.to_string_lossy()).unwrap().id;
    (temporary, core, id)
}

#[test]
fn saves_complete_files_but_never_overwrites_a_stale_buffer() {
    let (temporary, core, id) = fixture();
    let path = temporary.path().join("project/main.py");
    std::fs::write(&path, "print('before')\r\n").unwrap();
    let original = core.read_file(id, "main.py").unwrap().content;
    core.write_file(id, "main.py", &original, "print('after')\r\n")
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "print('after')\r\n"
    );
    std::fs::write(&path, "changes made elsewhere").unwrap();
    assert!(
        core.write_file(id, "main.py", "print('after')\r\n", "my changes")
            .unwrap_err()
            .to_string()
            .contains("changed on disk")
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "changes made elsewhere"
    );
    assert!(core.write_file(id, "../outside", "", "no").is_err());
}

#[test]
fn new_files_do_not_overwrite_existing_files_or_escape_the_project() {
    let (temporary, core, id) = fixture();
    core.create_file(id, "subdir/new.rs").unwrap();
    assert!(temporary.path().join("project/subdir/new.rs").is_file());
    assert!(core.create_file(id, "subdir/new.rs").is_err());
    assert!(core.create_file(id, "../escape.py").is_err());
    std::fs::write(temporary.path().join("project/.gitignore"), "ignored/\n").unwrap();
    std::fs::create_dir_all(temporary.path().join("project/ignored")).unwrap();
    std::fs::write(temporary.path().join("project/ignored/secret.rs"), "no").unwrap();
    assert_eq!(core.find_files(id, ".rs").unwrap(), ["subdir/new.rs"]);
    core.set_editor_dirty("project-main".into(), true);
    assert_eq!(core.dirty_editor_count(), 1);
    core.set_editor_dirty("project-main".into(), false);
    assert_eq!(core.dirty_editor_count(), 0);
}

fn until(core: &Core, id: u32, rx: &crossbeam_channel::Receiver<Vec<u8>>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut bytes = Vec::new();
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            if chunk.windows(4).any(|window| window == b"\x1b[6n") {
                core.write_terminal(id, b"\x1b[1;1R").unwrap();
            }
            bytes.extend(chunk);
        }
        let output = String::from_utf8_lossy(&bytes);
        if output.contains(needle) {
            return output.into_owned();
        }
    }
    panic!(
        "Did not receive {needle:?}: {}",
        String::from_utf8_lossy(&bytes)
    );
}

/// A terminal view that keeps reading for the whole test, as the app's own view does:
/// `until` stops reading as soon as it has what it waited for, and a view left behind
/// must not hold up the shell (see `a_stalled_terminal_view_never_stalls_the_shell`).
struct Drained {
    bytes: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    reader: Option<std::thread::JoinHandle<()>>,
}

fn drain_terminal(core: &Arc<Core>, terminal_id: u32) -> Drained {
    let rx = core.subscribe_terminal(terminal_id).unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let core = Arc::clone(core);
        let bytes = Arc::clone(&bytes);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) else {
                    continue;
                };
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    diag::best_effort(
                        "write_terminal",
                        core.write_terminal(terminal_id, b"\x1b[1;1R"),
                    );
                }
                bytes.lock().unwrap().extend(chunk);
            }
        })
    };
    Drained {
        bytes,
        stop,
        reader: Some(reader),
    }
}

impl Drained {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }

    fn wait_for(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let output = self.text();
            if output.contains(needle) {
                return output;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = self.text();
        panic!(
            "Did not receive {needle:?} in {} bytes: {}",
            output.len(),
            &output[output.len().saturating_sub(2000)..]
        );
    }
}

impl Drop for Drained {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(reader) = self.reader.take() {
            diag::joined("join", reader.join());
        }
    }
}

/// A view that stops reading must not stop the shell for the views that do read.
#[test]
fn a_stalled_terminal_view_never_stalls_the_shell() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    let terminal = core.start_block_terminal(id).unwrap();
    // Never read: the view's buffer fills and stays full.
    let _stalled = core.subscribe_terminal(terminal.id).unwrap();
    let live = drain_terminal(&core, terminal.id);
    // More than the stalled view's buffer holds, so the terminal has to drop it
    // rather than wait for it before the reading view gets anything.
    #[cfg(windows)]
    let command = "Write-Output ('x' * 3000000)";
    #[cfg(not(windows))]
    let command = "head -c 3000000 /dev/zero | tr '\\0' x";
    core.run_terminal_block(terminal.id, command, "flood")
        .unwrap();
    live.wait_for("flood;end;0;");
    assert!(
        live.text().contains("xxxxxx"),
        "the reading view never saw the flood"
    );
    core.close_terminal(terminal.id).unwrap();
}

/// The shells a Command block runs in on this OS: zsh and bash where installed, else PowerShell.
fn block_shells(core: &Core) -> Vec<oxide_core::ShellKind> {
    use oxide_core::ShellKind;
    if cfg!(windows) {
        return vec![ShellKind::Default];
    }
    core.available_shells()
        .into_iter()
        .map(|shell| shell.kind)
        .filter(|kind| matches!(kind, ShellKind::Zsh | ShellKind::Bash))
        .collect()
}

fn start_terminal_in(core: &Core, project_id: u32, shell: oxide_core::ShellKind) -> u32 {
    core.set_terminal_settings(oxide_core::TerminalSettings {
        shell,
        load_user_config: true,
    })
    .unwrap();
    core.start_block_terminal(project_id).unwrap().id
}

/// The exit code and folder a block's `end` marker reports, once it has arrived.
fn block_end(view: &Drained, token: &str) -> (String, String) {
    let needle = format!("{token};end;");
    let output = view.wait_for(&needle);
    let rest = &output[output.find(&needle).unwrap() + needle.len()..];
    let marker = rest.split('\x07').next().unwrap();
    let (code, cwd) = marker.split_once(';').unwrap();
    (code.to_string(), cwd.to_string())
}

/// Keystrokes and terminal replies that reach the shell's line editor before a block is typed
/// (typeahead, a cursor-position reply) must not break the block's wrapper.
#[test]
fn stray_input_before_a_block_cannot_leave_it_running() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    for shell in block_shells(&core) {
        let terminal = start_terminal_in(&core, id, shell);
        let view = drain_terminal(&core, terminal);
        core.run_terminal_block(terminal, "echo READY", "ready")
            .unwrap();
        block_end(&view, "ready");
        let stray: &[u8] = if cfg!(windows) {
            b"stray\x1b[1;1R"
        } else {
            b"stray'\x1b[1;1R"
        };
        core.write_terminal(terminal, stray).unwrap();
        core.run_terminal_block(terminal, "printf 'AFTER_%s\\n' STRAY", "after")
            .unwrap();
        let (code, _) = block_end(&view, "after");
        assert_eq!(code, "0", "{shell:?}");
        assert!(view.text().contains("AFTER_STRAY"), "{shell:?}");
        core.close_terminal(terminal).unwrap();
    }
}

/// Built-ins that finish at once (`cd`, `ls`) close every block, one right after the other,
/// and each block reports the folder the shell is in.
#[test]
fn rapid_built_in_commands_close_every_block_with_the_new_directory() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    for shell in block_shells(&core) {
        let terminal = start_terminal_in(&core, id, shell);
        let view = drain_terminal(&core, terminal);
        let steps = [
            ("ls", "project"),
            ("cd subdir", "subdir"),
            ("cd ..", "project"),
            ("cd ..", ""),
        ];
        for (index, (command, folder)) in steps.into_iter().enumerate() {
            let token = format!("rapid-{index}");
            core.run_terminal_block(terminal, command, &token).unwrap();
            let (code, cwd) = block_end(&view, &token);
            assert_eq!(code, "0", "{shell:?} {command}");
            let name = std::path::Path::new(&cwd)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if folder.is_empty() {
                assert_ne!(name, "project", "{shell:?} {command}: {cwd}");
            } else {
                assert_eq!(name, folder, "{shell:?} {command}: {cwd}");
            }
        }
        core.close_terminal(terminal).unwrap();
    }
}

/// A command the shell cannot parse fails its block instead of waiting at a continuation prompt.
#[test]
fn a_syntax_error_fails_the_block_and_keeps_the_shell_usable() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    for shell in block_shells(&core) {
        let terminal = start_terminal_in(&core, id, shell);
        let view = drain_terminal(&core, terminal);
        core.run_terminal_block(terminal, "echo 'unclosed", "broken")
            .unwrap();
        let (code, _) = block_end(&view, "broken");
        assert_ne!(code, "0", "{shell:?}");
        core.run_terminal_block(terminal, "echo STILL_''USABLE", "after")
            .unwrap();
        let (code, _) = block_end(&view, "after");
        assert_eq!(code, "0", "{shell:?}");
        assert!(view.text().contains("STILL_USABLE"), "{shell:?}");
        core.close_terminal(terminal).unwrap();
    }
}

/// A command with a quote and a later `!` runs as typed: bash before 4.4 (macOS's /bin/bash)
/// expands history inside the wrapper's quoting, which would fail with "event not found" and
/// leave the block without a start or an end.
#[test]
fn an_exclamation_mark_after_a_quote_runs_as_typed() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    for shell in block_shells(&core) {
        let terminal = start_terminal_in(&core, id, shell);
        let view = drain_terminal(&core, terminal);
        core.run_terminal_block(terminal, "echo 'fix!'", "bang")
            .unwrap();
        let (code, _) = block_end(&view, "bang");
        assert_eq!(code, "0", "{shell:?}: {}", view.text());
        assert!(
            view.text().contains("fix!\r\n"),
            "{shell:?}: {}",
            view.text()
        );
        core.close_terminal(terminal).unwrap();
    }
}

/// A user's own hooks and options (a cleared `precmd_functions` or `PROMPT_COMMAND`, a prompt
/// theme, `nounset`) never stop blocks from ending, Ctrl+C included, and their prompt never
/// shows up in the Terminal.
#[test]
fn user_hooks_and_prompts_never_stop_blocks_from_ending() {
    use oxide_core::ShellKind;
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    for shell in block_shells(&core) {
        let terminal = start_terminal_in(&core, id, shell);
        let view = drain_terminal(&core, terminal);
        // The prompt text is split in the typed command, so only a printed prompt contains it.
        let clobber = match shell {
            ShellKind::Zsh => {
                "precmd_functions=(); chpwd() { echo CHPWD_RAN; }; PROMPT='OXIDE_''BLEED> '; RPROMPT='OXIDE_''BLEED'; PS2='OXIDE_''BLEED> '; setopt nounset"
            }
            ShellKind::Bash => {
                "PROMPT_COMMAND=':'; PS1='OXIDE_''BLEED> '; PS2='OXIDE_''BLEED> '; set -u"
            }
            _ => "function global:prompt { 'OXIDE_' + 'BLEED> ' }",
        };
        core.run_terminal_block(terminal, clobber, "clobber")
            .unwrap();
        assert_eq!(block_end(&view, "clobber").0, "0", "{shell:?}");
        let cd = if cfg!(windows) {
            "Set-Location subdir"
        } else {
            "cd subdir"
        };
        core.run_terminal_block(terminal, cd, "cd").unwrap();
        let (code, cwd) = block_end(&view, "cd");
        assert_eq!(code, "0", "{shell:?}");
        assert!(cwd.ends_with("subdir"), "{shell:?}: {cwd}");
        core.run_terminal_block(
            terminal,
            "python -c \"import time; print('WAITING_FOR_' + 'INTERRUPT',flush=True); time.sleep(30)\"",
            "wait",
        )
        .unwrap();
        view.wait_for("WAITING_FOR_INTERRUPT");
        core.write_terminal(terminal, b"\x03").unwrap();
        block_end(&view, "wait");
        core.run_terminal_block(terminal, "echo AFTER_''HOOKS", "after")
            .unwrap();
        assert_eq!(block_end(&view, "after").0, "0", "{shell:?}");
        assert!(view.text().contains("AFTER_HOOKS"), "{shell:?}");
        assert!(
            !view.text().contains("OXIDE_BLEED"),
            "{shell:?}: {}",
            view.text()
        );
        core.close_terminal(terminal).unwrap();
    }
}

#[test]
fn terminal_blocks_keep_shell_variables_directory_and_exit_status() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    #[cfg(windows)]
    let first = "$savedValue=42; Set-Location subdir; Write-Output 'first output'";
    #[cfg(not(windows))]
    let first = "savedValue=42; cd subdir; printf 'first output\\n'";
    core.run_terminal_block(terminal.id, first, "first")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "first;end;0;");
    assert!(output.contains("first output"), "{output}");
    assert!(output.contains("subdir"), "{output}");
    #[cfg(windows)]
    let second = "Write-Output \"kept:$savedValue\"; cmd /c exit 7";
    #[cfg(not(windows))]
    let second = "printf 'kept:%s\\n' \"$savedValue\"; sh -c 'exit 7'";
    core.run_terminal_block(terminal.id, second, "second")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "second;end;7;");
    assert!(output.contains("kept:42"), "{output}");
    assert!(
        core.run_terminal_block(terminal.id, "echo bad", "bad;token")
            .is_err()
    );
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn terminal_block_accepts_interactive_input() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    #[cfg(windows)]
    let command = "$name=Read-Host 'Enter name'; Write-Output \"Hello $name\"";
    #[cfg(not(windows))]
    let command = "printf 'Enter name'; read name; printf 'Hello %s\\n' \"$name\"";
    core.run_terminal_block(terminal.id, command, "interactive")
        .unwrap();
    until(&core, terminal.id, &rx, "Enter name");
    core.write_terminal(
        terminal.id,
        if cfg!(windows) { b"Ada\r\n" } else { b"Ada\n" },
    )
    .unwrap();
    let output = until(&core, terminal.id, &rx, "interactive;end;0;");
    assert!(output.contains("Hello Ada"), "{output}");
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn language_server_transports_unsaved_diagnostics_and_completion() {
    let (_temporary, core, id) = fixture();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/lsp.py");
    // The user's configuration file names the server: the fixture script run by `python`.
    let python = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| {
            dir.join(if cfg!(windows) {
                "python.exe"
            } else {
                "python"
            })
        })
        .find(|candidate| candidate.is_file())
        .expect("a `python` on the PATH");
    std::fs::write(
        _temporary.path().join("home/language-servers.json"),
        serde_json::json!({
            "python": {
                "command": python,
                "args": [script],
                "interpreter": null
            }
        })
        .to_string(),
    )
    .unwrap();
    let (server, rx) = core.start_language_server(id, "python").unwrap();
    core.language_server_message(
        server.id,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    )
    .unwrap();
    fn next(rx: &crossbeam_channel::Receiver<String>) -> serde_json::Value {
        loop {
            let message: serde_json::Value =
                serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
            if message["method"] != "window/logMessage" {
                return message;
            }
        }
    }
    let initialized = next(&rx);
    assert_eq!(initialized["id"], 1, "{initialized}");
    core.language_server_message(server.id, r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///main.py","text":"broken"}}}"#).unwrap();
    let diagnostics = next(&rx);
    assert_eq!(
        diagnostics["params"]["diagnostics"][0]["message"],
        "Syntax error: broken"
    );
    core.language_server_message(
        server.id,
        r#"{"jsonrpc":"2.0","id":2,"method":"textDocument/completion","params":{}}"#,
    )
    .unwrap();
    let completion = next(&rx);
    assert_eq!(completion["result"][0]["label"], "print");
    core.stop_language_server(server.id);
    assert!(core.language_server_message(server.id, "{}").is_err());
}

#[test]
fn shell_completion_uses_the_live_directory_and_never_runs_the_typed_command() {
    let (temporary, core, id) = fixture();
    std::fs::write(
        temporary
            .path()
            .join("project/subdir/completion-example.txt"),
        "fixture",
    )
    .unwrap();
    let terminal = core.start_block_terminal(id).unwrap();
    assert!(!terminal.cwd.starts_with("\\\\?\\"));
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(terminal.id, "cd subdir", "change")
        .unwrap();
    until(&core, terminal.id, &rx, "change;end;0;");
    let line = "cat comp";
    let result = core
        .complete_terminal(terminal.id, line, line.len())
        .unwrap();
    assert_eq!(result.replacement_index, 4);
    assert!(
        result
            .matches
            .iter()
            .any(|item| item.text.contains("completion-example.txt")),
        "{result:?}"
    );
    let absent = core
        .complete_terminal(terminal.id, "cat no-such-file-oxide-123", 25)
        .unwrap();
    assert!(absent.matches.is_empty());
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn a_failing_block_keeps_the_error_the_shell_printed() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(terminal.id, "cd missing-oxide-dir/", "fails")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "fails;end;");
    let start = output.find("fails;start").unwrap();
    let end = output.find("fails;end;").unwrap();
    let block = &output[start..end];
    assert!(block.to_lowercase().contains("no such file"), "{block:?}");
    assert!(output[end..].starts_with("fails;end;1;"), "{output:?}");
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn shell_completion_follows_the_directory_a_block_moved_the_shell_to() {
    let (temporary, core, id) = fixture();
    // Outside every open checkout, as `cd /Users` is.
    let elsewhere = temporary.path().join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("only-here-dir")).unwrap();
    std::fs::write(elsewhere.join("only-here.txt"), "fixture").unwrap();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    let change = format!("cd '{}'", elsewhere.to_string_lossy());
    core.run_terminal_block(terminal.id, &change, "away")
        .unwrap();
    until(&core, terminal.id, &rx, "away;end;0;");
    let result = core.complete_terminal(terminal.id, "ls only", 7).unwrap();
    let labels: Vec<_> = result
        .matches
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    assert_eq!(labels, ["only-here-dir/", "only-here.txt"], "{result:?}");
    // Back in the project, its files again.
    core.run_terminal_block(terminal.id, "cd -", "back")
        .unwrap();
    until(&core, terminal.id, &rx, "back;end;0;");
    let result = core.complete_terminal(terminal.id, "ls sub", 6).unwrap();
    assert!(
        result.matches.iter().any(|item| item.label == "subdir/"),
        "{result:?}"
    );
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn interrupting_a_program_keeps_the_shell_usable() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(
        terminal.id,
        "python -c \"import time; print('WAITING_FOR_' + 'INTERRUPT',flush=True); time.sleep(30)\"",
        "wait",
    )
    .unwrap();
    // The needle is only in the output, never in the typed command a line editor echoes.
    until(&core, terminal.id, &rx, "WAITING_FOR_INTERRUPT");
    core.write_terminal(terminal.id, b"\x03").unwrap();
    until(&core, terminal.id, &rx, "wait;end;");
    core.run_terminal_block(terminal.id, "echo STILL_USABLE", "after")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "after;end;0;");
    assert!(output.contains("STILL_USABLE"));
    core.close_terminal(terminal.id).unwrap();
}

/// A program that reads raw keys (a TUI that wants Ctrl+C twice before it quits) gets the
/// Ctrl+C byte itself, not a signal that ends it.
#[test]
fn a_program_reading_raw_keys_receives_ctrl_c_as_a_key() {
    // Python's raw tty mode is Unix-only; Windows hands Ctrl+C to ConPTY unchanged.
    if cfg!(windows) {
        return;
    }
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(
        terminal.id,
        "python -c \"import sys, tty; tty.setraw(0); print('RAW_' + 'READY', flush=True); key = sys.stdin.buffer.read(1); print('KEY_' + str(ord(key)), flush=True)\"",
        "raw",
    )
    .unwrap();
    until(&core, terminal.id, &rx, "RAW_READY");
    core.write_terminal(terminal.id, b"\x03").unwrap();
    let output = until(&core, terminal.id, &rx, "raw;end;");
    assert!(output.contains("KEY_3"), "{output}");
    assert!(output.contains("raw;end;0;"), "{output}");
    core.close_terminal(terminal.id).unwrap();
}
