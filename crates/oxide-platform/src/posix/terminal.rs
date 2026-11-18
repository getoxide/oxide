//! The interactive shell of a Terminal on Unix: bash with block markers, process groups and
//! sessions for interrupting and cleaning up.

use super::process::terminate_group;
use super::signal::{session_of, signal_group, signal_process};
use crate::diag;
use crate::{ShellLaunch, ShellProcess};
use portable_pty::MasterPty;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

const BLOCK_PROMPT: &str = r#"$(_oxide_prompt_status=$?; if [ -n "${_oxide_token-}" ]; then printf '\033]633;Oxide;%s;end;%s;%s\007' "$_oxide_token" "${_oxide_exit:-$_oxide_prompt_status}" "$PWD"; fi)"#;

/// The shell to start. With `blocks`, bash with the block prompt (and `init_file` as its rc
/// file); without, the user's own shell.
pub fn shell_launch(blocks: bool, init_file: Option<&Path>) -> ShellLaunch {
    let mut launch = ShellLaunch {
        program: if blocks {
            "/bin/bash".into()
        } else {
            std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
        },
        args: Vec::new(),
        env: Vec::new(),
    };
    if blocks {
        launch.env.push(("PS1".into(), BLOCK_PROMPT.into()));
        launch.env.push(("PS2".into(), String::new()));
        // Debian and Ubuntu build bash to run /etc/bash.bashrc even with `--rcfile`, and that file
        // resets PS1. The init file puts the block prompt back once the system file has run.
        launch.env.push(("_OXIDE_PS1".into(), BLOCK_PROMPT.into()));
        launch.args.push("--noprofile".into());
        if let Some(init_file) = init_file {
            launch.args.push("--rcfile".into());
            launch.args.push(init_file.into());
        }
        launch.args.extend(["-m".into(), "-i".into()]);
    }
    launch
}

/// What to type into the shell to run `command` as a block marked by `token`.
pub fn block_script(token: &str, command: &str) -> String {
    format!(
        "_oxide_token='{token}'; _oxide_exit=; printf '\\033]633;Oxide;{token};start\\007'; __oxide_run_block() {{\n{command}\n}}; __oxide_run_block; _oxide_exit=$?; unset -f __oxide_run_block\n"
    )
}

/// A script that asks the shell itself for completions, or `None` when the shell cannot (the
/// caller then completes paths and commands without evaluating anything).
pub fn completion_script(_token: u32, _line: &str, _cursor: usize) -> Option<String> {
    None
}

/// Creates the rc file bash reads for a block terminal, in Oxide's private home and not the
/// shared temp directory: any local account could otherwise plant or read a file there.
pub fn create_shell_init_file(home: &Path, id: u32) -> io::Result<Option<PathBuf>> {
    static NEXT_INIT_FILE: AtomicU32 = AtomicU32::new(0);

    let dir = home.join("terminal");
    super::fs::create_private_dir_all(&dir)?;
    let path = dir.join(format!(
        "oxide-terminal-{}-{id}-{}.bashrc",
        std::process::id(),
        NEXT_INIT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = super::fs::create_new_private_file(&path)?;
    file.write_all(
        b"PS1=$_OXIDE_PS1\nPS2=\nunset _OXIDE_PS1 PROMPT_COMMAND\nstty isig -echo\ntrap ':' INT\n",
    )?;
    Ok(Some(path))
}

/// The process group to supervise for a shell: the PTY's own (the PTY child leads its session
/// and its group), or the shell's pid. `None` where the OS has no groups.
pub fn session_group(shell_pid: u32, master: &dyn MasterPty) -> Option<i32> {
    Some(master.process_group_leader().unwrap_or(shell_pid as i32))
}

/// Writes `input` to the shell, turning Ctrl+C (0x03) into an interrupt of what the shell runs:
/// the foreground group when there is one, else the processes of the shell's session. A Ctrl+C
/// that cannot interrupt anything is written through.
pub fn write_input(
    writer: &mut dyn Write,
    input: &[u8],
    shell_pid: u32,
    master: &dyn MasterPty,
) -> io::Result<()> {
    let shell_pid = shell_pid as i32;
    let mut start = 0;
    for (index, byte) in input.iter().enumerate() {
        if *byte != 0x03 {
            continue;
        }
        writer.write_all(&input[start..index])?;
        let signaled = master.process_group_leader().is_some_and(|process_group| {
            process_group > 0
                && if process_group == shell_pid {
                    interrupt_session_processes(shell_pid)
                } else {
                    signal_group(process_group, libc::SIGINT).is_ok()
                }
        });
        if !signaled {
            writer.write_all(&input[index..=index])?;
        }
        start = index + 1;
    }
    writer.write_all(&input[start..])?;
    writer.flush()
}

/// Ends a shell and everything it started. Interactive shells ignore SIGTERM but hang up on
/// SIGHUP, so the group gets that first; the shell is reaped on every poll so a zombie leader does
/// not keep the group looking alive.
pub fn close_session(group: Option<i32>, grace: Duration, shell: &mut dyn ShellProcess) {
    let Some(group) = group else { return };
    diag::best_effort("signal_group", signal_group(group, libc::SIGHUP));
    terminate_group(group, grace, || shell.reap());
    clean_up_session(Some(group));
}

/// Ends what is left of a shell's session: anything that moved to its own process group but
/// stayed in the session.
pub fn clean_up_session(group: Option<i32>) {
    let Some(session_id) = group else { return };
    if let Ok(output) = crate::command::os_command("ps")
        .args(["-A", "-o", "pid="])
        .output()
    {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<i32>()
                && session_of(pid) == Some(session_id)
            {
                diag::best_effort("signal_process", signal_process(pid, libc::SIGKILL));
            }
        }
    }
    diag::best_effort("signal_group", signal_group(session_id, libc::SIGKILL));
}

fn interrupt_session_processes(session_id: i32) -> bool {
    let Ok(output) = crate::command::os_command("ps")
        .args(["-A", "-o", "pid="])
        .output()
    else {
        return false;
    };
    let mut interrupted = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(pid) = line.trim().parse::<i32>() else {
            continue;
        };
        if pid != session_id && session_of(pid) == Some(session_id) {
            interrupted |= signal_process(pid, libc::SIGTERM).is_ok();
        }
    }
    interrupted
}
