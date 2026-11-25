//! The interactive shell of a Terminal on Unix: the user's zsh (or bash) with block markers,
//! process groups and sessions for interrupting and cleaning up.

use super::process::terminate_group;
use super::signal::{session_of, signal_group, signal_process};
use crate::command::find_in;
use crate::diag;
use crate::{AvailableShell, ShellKind, ShellLaunch, ShellProcess};
use portable_pty::MasterPty;
use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

const BLOCK_PROMPT: &str = r#"$(_oxide_prompt_status=$?; if [ -n "${_oxide_token-}" ]; then printf '\033]633;Oxide;%s;end;%s;%s\007' "$_oxide_token" "${_oxide_exit:-$_oxide_prompt_status}" "$PWD"; fi)"#;

/// The suffix of the `ZDOTDIR` a zsh block terminal starts with; any other init file is bash's.
const ZSH_INIT_SUFFIX: &str = ".zsh";

/// What every zsh block terminal's `.zshrc` ends with: the hook that marks the end of a block the
/// wrapper could not finish (Ctrl+C), and empty prompts, as a block shows only what its command
/// prints. `_oxide_rearm` puts both back first and last in `precmd_functions` after user files,
/// themes or commands replaced them; it runs here, after `.zlogin` and around every block.
/// `emulate -L zsh` keeps a user's `nounset` (or any other option) out of them.
macro_rules! zsh_block_hooks {
    () => {
        r#"# The output of a block ends where the block ends: no reverse-video % for a missing newline.
setopt hist_ignore_space
unsetopt prompt_cr prompt_sp
_oxide_precmd() {
  local _oxide_status=$?
  emulate -L zsh
  if [[ -n ${_oxide_token-} ]]; then
    builtin printf '\033]633;Oxide;%s;end;%s;%s\007' "$_oxide_token" "${_oxide_exit:-$_oxide_status}" "$PWD"
    _oxide_token=
  fi
}
_oxide_quiet_prompt() {
  PROMPT= RPROMPT= PS2=
}
_oxide_rearm() {
  emulate -L zsh
  precmd_functions=(_oxide_precmd ${precmd_functions:#(_oxide_precmd|_oxide_quiet_prompt)} _oxide_quiet_prompt)
  _oxide_quiet_prompt
}
_oxide_rearm
"#
    };
}

/// Each startup file zsh reads from the block terminal's `ZDOTDIR` runs the user's own file of
/// that name (from their `ZDOTDIR`, else the home), so aliases, `PATH` and plugins load as in
/// their own terminal. `.zshrc` then adds the hook that marks the end of a block, and `.zlogin`
/// (the last file of a login shell) hands `ZDOTDIR` back to the user.
const ZSH_STARTUP_FILES: [(&str, &str); 4] = [
    (
        ".zshenv",
        r#"_oxide_zdotdir=$ZDOTDIR
OXIDE_USER_ZDOTDIR=${OXIDE_USER_ZDOTDIR:-$HOME}
if [[ -f "$OXIDE_USER_ZDOTDIR/.zshenv" ]]; then
  ZDOTDIR=$OXIDE_USER_ZDOTDIR
  builtin source "$OXIDE_USER_ZDOTDIR/.zshenv"
  OXIDE_USER_ZDOTDIR=$ZDOTDIR
fi
ZDOTDIR=$_oxide_zdotdir
"#,
    ),
    (
        ".zprofile",
        r#"if [[ -f "$OXIDE_USER_ZDOTDIR/.zprofile" ]]; then
  ZDOTDIR=$OXIDE_USER_ZDOTDIR
  builtin source "$OXIDE_USER_ZDOTDIR/.zprofile"
  ZDOTDIR=$_oxide_zdotdir
fi
"#,
    ),
    (
        ".zshrc",
        concat!(
            r#"[[ $HISTFILE == "$_oxide_zdotdir/.zsh_history" ]] && HISTFILE="$OXIDE_USER_ZDOTDIR/.zsh_history"
if [[ -f "$OXIDE_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR=$OXIDE_USER_ZDOTDIR
  builtin source "$OXIDE_USER_ZDOTDIR/.zshrc"
  ZDOTDIR=$_oxide_zdotdir
fi
"#,
            zsh_block_hooks!()
        ),
    ),
    (
        ".zlogin",
        r#"if [[ -f "$OXIDE_USER_ZDOTDIR/.zlogin" ]]; then
  ZDOTDIR=$OXIDE_USER_ZDOTDIR
  builtin source "$OXIDE_USER_ZDOTDIR/.zlogin"
fi
_oxide_rearm
export ZDOTDIR=$OXIDE_USER_ZDOTDIR
unset _oxide_zdotdir OXIDE_USER_ZDOTDIR
"#,
    ),
];

const ZSH_CLEAN_STARTUP_FILES: [(&str, &str); 1] = [(".zshrc", zsh_block_hooks!())];

const BASH_USER_CONFIG_INIT: &str = r#"if [ -f "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then
  . "$HOME/.profile"
fi
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
"#;

const BASH_BLOCK_HOOKS: &str = r#"case ":${HISTCONTROL-}:" in
  *:ignorespace:*|*:ignoreboth:*) ;;
  *) HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac
export HISTCONTROL
_oxide_prompt_command() {
  local _oxide_prompt_status=$?
  if [ -n "${_oxide_token-}" ]; then
    builtin printf '\033]633;Oxide;%s;end;%s;%s\007' "$_oxide_token" "${_oxide_exit:-$_oxide_prompt_status}" "$PWD"
    _oxide_token=
  fi
}
_oxide_quiet_prompt() {
  PS1= PS2=
}
_oxide_rearm() {
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    if [[ "${PROMPT_COMMAND[0]-}" != _oxide_prompt_command || "${PROMPT_COMMAND[${#PROMPT_COMMAND[@]}-1]}" != _oxide_quiet_prompt ]]; then
      PROMPT_COMMAND=(_oxide_prompt_command "${PROMPT_COMMAND[@]}" _oxide_quiet_prompt)
    fi
  else
    case "${PROMPT_COMMAND-}" in
      "_oxide_prompt_command; "*"_oxide_quiet_prompt") ;;
      *) PROMPT_COMMAND="_oxide_prompt_command; ${PROMPT_COMMAND:+$PROMPT_COMMAND; }_oxide_quiet_prompt" ;;
    esac
  fi
  _oxide_quiet_prompt
}
_oxide_rearm
stty isig -echo
trap ':' INT
"#;

fn resolve_unix_shell(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH")
        && let Some(found) = find_in(&path, OsStr::new(name), None)
        && found.is_file()
    {
        return Some(found);
    }
    fallbacks
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn resolve_zsh() -> Option<PathBuf> {
    user_zsh().or_else(|| {
        resolve_unix_shell(
            "zsh",
            &[
                "/bin/zsh",
                "/usr/bin/zsh",
                "/opt/homebrew/bin/zsh",
                "/usr/local/bin/zsh",
            ],
        )
    })
}

fn resolve_bash() -> Option<PathBuf> {
    resolve_unix_shell(
        "bash",
        &[
            "/bin/bash",
            "/usr/bin/bash",
            "/opt/homebrew/bin/bash",
            "/usr/local/bin/bash",
        ],
    )
}

/// The zsh a block terminal runs: the user's login shell when it is zsh (`SHELL`; macOS's
/// default when unset), else `None` and the terminal runs bash.
fn user_zsh() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .or_else(|| cfg!(target_os = "macos").then(|| PathBuf::from("/bin/zsh")))?;
    (shell.file_name() == Some("zsh".as_ref()) && shell.is_file()).then_some(shell)
}

/// Installed shells supported by Oxide on Unix (ADR-0016 allowlist).
pub fn available_shells() -> Vec<AvailableShell> {
    let mut shells = vec![AvailableShell {
        kind: ShellKind::Default,
        label: "System default".into(),
        is_default: true,
    }];
    if resolve_zsh().is_some() {
        shells.push(AvailableShell {
            kind: ShellKind::Zsh,
            label: "Zsh".into(),
            is_default: false,
        });
    }
    if resolve_bash().is_some() {
        shells.push(AvailableShell {
            kind: ShellKind::Bash,
            label: "Bash".into(),
            is_default: false,
        });
    }
    shells
}

/// Whether `shell` is in Unix's Terminal allowlist (ADR-0016).
pub fn is_shell_supported(shell: ShellKind) -> bool {
    match shell {
        ShellKind::Default => true,
        ShellKind::Zsh => resolve_zsh().is_some(),
        ShellKind::Bash => resolve_bash().is_some(),
        ShellKind::PowerShell | ShellKind::Pwsh => false,
    }
}

fn is_zsh_init(init_file: Option<&Path>) -> bool {
    init_file.is_some_and(|path| {
        path.extension()
            .is_some_and(|extension| extension == &ZSH_INIT_SUFFIX[1..])
    })
}

fn use_zsh(shell: ShellKind, init_file: Option<&Path>) -> bool {
    match shell {
        ShellKind::Zsh => true,
        ShellKind::Bash => false,
        _ => is_zsh_init(init_file) || (init_file.is_none() && user_zsh().is_some()),
    }
}

/// The shell to start. With `blocks`, the chosen shell (or user's login shell for `Default`)
/// reading Oxide's private startup files through `init_file`; without, the user's own shell.
pub fn shell_launch(
    blocks: bool,
    init_file: Option<&Path>,
    shell: ShellKind,
    load_user_config: bool,
) -> ShellLaunch {
    if blocks && use_zsh(shell, init_file) {
        let zsh = resolve_zsh().unwrap_or_else(|| PathBuf::from("/bin/zsh"));
        let mut env = vec![(
            "ZDOTDIR".into(),
            init_file
                .unwrap_or(Path::new(""))
                .to_string_lossy()
                .into_owned(),
        )];
        if load_user_config
            && let Some(user) = std::env::var_os("ZDOTDIR").filter(|dir| !dir.is_empty())
        {
            env.push((
                "OXIDE_USER_ZDOTDIR".into(),
                user.to_string_lossy().into_owned(),
            ));
        }
        return ShellLaunch {
            name: "zsh".into(),
            program: zsh.into(),
            args: vec!["-l".into(), "-i".into()],
            env,
        };
    }
    let program: OsString = if blocks {
        resolve_bash()
            .unwrap_or_else(|| PathBuf::from("/bin/bash"))
            .into()
    } else {
        std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
    };
    let mut launch = ShellLaunch {
        name: Path::new(&program)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sh".into()),
        program,
        args: Vec::new(),
        env: Vec::new(),
    };
    if blocks {
        launch.env.push(("PS1".into(), BLOCK_PROMPT.into()));
        launch.env.push(("PS2".into(), String::new()));
        // Debian and Ubuntu build bash to run /etc/bash.bashrc even with `--rcfile`, and that file
        // resets PS1. The init file puts the block prompt back when user config is disabled.
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

/// What to type into the shell to run `command` as a block marked by `token`: one line, so a
/// syntax error in `command` is reported by `eval` instead of leaving the shell at a continuation
/// prompt. Ctrl+U first empties the line editor of anything typed or replied before it. The
/// wrapper re-arms the prompt hooks, marks the start, runs the command at the top level of the
/// live shell through `eval`, exactly as typed (its `cd`, variables, aliases and functions stay,
/// and `return` or bash's `local` behave as at the prompt), and marks the end itself; the prompt
/// hook only marks the end of a command that never got back to the wrapper (Ctrl+C). The leading
/// space keeps the wrapper out of the user's history (`hist_ignore_space`, `ignorespace`). A
/// token other than ASCII letters, digits and `-` is refused.
pub fn block_script(token: &str, command: &str) -> io::Result<String> {
    let token = crate::block_token(token)?;
    let command = ansi_c_quoted(command);
    Ok(format!(
        "\x15 _oxide_token='{token}'; _oxide_exit=; {{ _oxide_rearm; }} 2>/dev/null; builtin printf '\\033]633;Oxide;%s;start\\007' \"$_oxide_token\"; eval {command}; _oxide_exit=$?; builtin printf '\\033]633;Oxide;%s;end;%s;%s\\007' \"$_oxide_token\" \"$_oxide_exit\" \"$PWD\"; _oxide_token=; {{ _oxide_rearm; }} 2>/dev/null\n"
    ))
}

/// `text` as one `$'...'` word, which bash and zsh both read back unchanged, with every line
/// break and ASCII control character escaped so the word stays on one line. `!` is escaped too:
/// bash before 4.4 (macOS's /bin/bash) expands history inside `$'...'` once a quote precedes it.
fn ansi_c_quoted(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 3);
    quoted.push_str("$'");
    for character in text.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '\'' => quoted.push_str("\\'"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            '!' => quoted.push_str("\\041"),
            c if c.is_ascii_control() => quoted.push_str(&format!("\\{:03o}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('\'');
    quoted
}

/// A script that asks the shell itself for completions, or `None` when the shell cannot (the
/// caller then completes paths and commands without evaluating anything).
pub fn completion_script(_token: u32, _line: &str, _cursor: usize) -> Option<String> {
    None
}

/// Creates what the block terminal's shell reads at startup, in Oxide's private home and not the
/// shared temp directory: any local account could otherwise plant or read a file there. For zsh
/// it is a `ZDOTDIR` folder of startup files, for bash one rc file.
pub fn create_shell_init_file(
    home: &Path,
    id: u32,
    shell: ShellKind,
    load_user_config: bool,
) -> io::Result<Option<PathBuf>> {
    static NEXT_INIT_FILE: AtomicU32 = AtomicU32::new(0);

    let dir = home.join("terminal");
    super::fs::create_private_dir_all(&dir)?;
    let stem = format!(
        "oxide-terminal-{}-{id}-{}",
        std::process::id(),
        NEXT_INIT_FILE.fetch_add(1, Ordering::Relaxed)
    );
    let wants_zsh = match shell {
        ShellKind::Zsh => true,
        ShellKind::Bash => false,
        _ => user_zsh().is_some(),
    };
    if wants_zsh {
        let zdotdir = dir.join(format!("{stem}{ZSH_INIT_SUFFIX}"));
        let files: &[(&str, &str)] = if load_user_config {
            &ZSH_STARTUP_FILES
        } else {
            &ZSH_CLEAN_STARTUP_FILES
        };
        create_zsh_startup_files(&zdotdir, files)?;
        return Ok(Some(zdotdir));
    }
    let path = dir.join(format!("{stem}.bashrc"));
    let mut file = super::fs::create_new_private_file(&path)?;
    if load_user_config {
        file.write_all(BASH_USER_CONFIG_INIT.as_bytes())?;
        file.write_all(b"unset _OXIDE_PS1\n")?;
    } else {
        file.write_all(b"PS1=$_OXIDE_PS1\nPS2=\nunset _OXIDE_PS1 PROMPT_COMMAND\n")?;
    }
    file.write_all(BASH_BLOCK_HOOKS.as_bytes())?;
    Ok(Some(path))
}

fn create_zsh_startup_files(zdotdir: &Path, files: &[(&str, &str)]) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    // Not recursive: a folder that already exists is refused rather than trusted.
    std::fs::DirBuilder::new().mode(0o700).create(zdotdir)?;
    for (name, content) in files {
        super::fs::create_new_private_file(&zdotdir.join(name))?.write_all(content.as_bytes())?;
    }
    Ok(())
}

/// The process group to supervise for a shell: the PTY's own (the PTY child leads its session
/// and its group), or the shell's pid. `None` where the OS has no groups.
pub fn session_group(shell_pid: u32, master: &dyn MasterPty) -> Option<i32> {
    Some(master.process_group_leader().unwrap_or(shell_pid as i32))
}

/// Writes `input` to the shell. Ctrl+C (0x03) goes through the PTY like any key, so the line
/// discipline turns it into SIGINT for the foreground program, or hands it to a program that
/// reads raw keys (and may want a second press to quit). Only when the shell itself is in the
/// foreground does it interrupt the processes of the shell's session instead; a Ctrl+C that
/// interrupts nothing there is written through too.
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
        let shell_in_foreground = master.process_group_leader() == Some(shell_pid);
        if !(shell_in_foreground && interrupt_session_processes(shell_pid)) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_zsh_block_terminal_is_a_login_shell_reading_private_startup_files() {
        let home = tempfile::tempdir().expect("temporary home");
        let zdotdir = home.path().join(format!("terminal{ZSH_INIT_SUFFIX}"));
        create_zsh_startup_files(&zdotdir, &ZSH_STARTUP_FILES).expect("startup files");
        let mode = |path: &Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(&zdotdir), 0o700);
        for (name, _) in ZSH_STARTUP_FILES {
            assert_eq!(mode(&zdotdir.join(name)), 0o600, "{name}");
        }
        // A folder that is already there (planted or left over) is never reused.
        assert!(create_zsh_startup_files(&zdotdir, &ZSH_STARTUP_FILES).is_err());

        let launch = shell_launch(true, Some(&zdotdir), ShellKind::Zsh, true);
        assert_eq!(launch.name, "zsh");
        assert_eq!(launch.args, ["-l", "-i"]);
        assert!(
            launch
                .env
                .contains(&("ZDOTDIR".into(), zdotdir.to_string_lossy().into_owned()))
        );
    }

    #[test]
    fn a_clean_zsh_block_terminal_skips_user_startup_files() {
        let home = tempfile::tempdir().expect("temporary home");
        let zdotdir = create_shell_init_file(home.path(), 1, ShellKind::Zsh, false)
            .expect("init")
            .expect("zdotdir");
        let zshrc = std::fs::read_to_string(zdotdir.join(".zshrc")).expect("zshrc");
        assert!(!zshrc.contains("OXIDE_USER_ZDOTDIR"));
        assert!(zshrc.contains("_oxide_precmd"));
        assert!(zshrc.contains("hist_ignore_space"));
    }

    #[test]
    fn a_bash_block_terminal_reads_its_rc_file_and_loads_user_config_when_enabled() {
        let home = tempfile::tempdir().expect("temporary home");
        let rc = create_shell_init_file(home.path(), 2, ShellKind::Bash, true)
            .expect("init")
            .expect("rcfile");
        let content = std::fs::read_to_string(&rc).expect("read rc");
        assert!(content.contains(".bash_profile"));
        assert!(content.contains(".bash_login"));
        assert!(content.contains(".profile"));
        assert!(content.contains(".bashrc"));
        assert!(content.contains("ignorespace"));
        assert!(content.contains("_oxide_prompt_command"));

        let launch = shell_launch(true, Some(&rc), ShellKind::Bash, true);
        assert_eq!(launch.name, "bash");
        assert!(launch.args.iter().any(|arg| arg == "--rcfile"));
    }

    #[test]
    fn a_clean_bash_block_terminal_skips_user_config_while_keeping_hooks() {
        let home = tempfile::tempdir().expect("temporary home");
        let rc = create_shell_init_file(home.path(), 3, ShellKind::Bash, false)
            .expect("init")
            .expect("rcfile");
        let content = std::fs::read_to_string(&rc).expect("read rc");
        assert!(!content.contains(".bash_profile"));
        assert!(!content.contains(".bashrc"));
        assert!(content.contains("ignorespace"));
        assert!(content.contains("_oxide_prompt_command"));
    }

    /// The user's own startup files run first; whatever they do to the hooks and prompts
    /// (`nounset`, a theme in `precmd_functions`, a `.zlogin` that clears it), the block hooks
    /// come out first and last and the prompts empty.
    #[test]
    fn user_startup_files_cannot_unhook_a_zsh_block_terminal() {
        let Some(zsh) = resolve_zsh() else { return };
        let home = tempfile::tempdir().expect("temporary home");
        let user = home.path().join("user");
        std::fs::create_dir(&user).expect("user zdotdir");
        std::fs::write(
            user.join(".zshrc"),
            "setopt nounset\ntheme() { PROMPT='$ '; }\nprecmd_functions=(theme)\nPROMPT='$ '\n",
        )
        .expect("user zshrc");
        std::fs::write(user.join(".zlogin"), "precmd_functions=()\nPS2='> '\n")
            .expect("user zlogin");
        let zdotdir = create_shell_init_file(home.path(), 4, ShellKind::Zsh, true)
            .expect("init")
            .expect("zdotdir");
        let output = crate::command::resolved_command(&zsh)
            .args(["-l", "-i", "-c"])
            .arg(r#"print -r -- "[${precmd_functions[1]}|${precmd_functions[-1]}|$PROMPT|$PS2]""#)
            .env("ZDOTDIR", &zdotdir)
            .env("OXIDE_USER_ZDOTDIR", &user)
            .env("HOME", home.path())
            .output()
            .expect("run zsh");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("[_oxide_precmd|_oxide_quiet_prompt||]"),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn user_startup_files_cannot_unhook_a_bash_block_terminal() {
        let Some(bash) = resolve_bash() else { return };
        let home = tempfile::tempdir().expect("temporary home");
        std::fs::write(
            home.path().join(".bashrc"),
            "set -u\nPROMPT_COMMAND='theme=1'\nPS1='$ '\nPS2='> '\n",
        )
        .expect("user bashrc");
        let rc = create_shell_init_file(home.path(), 5, ShellKind::Bash, true)
            .expect("init")
            .expect("rcfile");
        let output = crate::command::resolved_command(&bash)
            .args(["--noprofile", "--rcfile"])
            .arg(&rc)
            .args([
                "-i",
                "-c",
                r#"printf '[%s|%s|%s]' "$PROMPT_COMMAND" "$PS1" "$PS2""#,
            ])
            .env("HOME", home.path())
            .output()
            .expect("run bash");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("[_oxide_prompt_command; theme=1; _oxide_quiet_prompt||]"),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// The wrapper is one line whatever the command holds, and the shell reads the command
    /// back unchanged: quotes, backslashes, line breaks and control characters.
    #[test]
    fn the_block_wrapper_is_one_line_that_runs_the_command_unchanged() {
        let command = "printf '%s|' \"it's\" 'a\\b' \"$(printf 'x\\001y' | od -An -c | tr -s ' ')\"\nprintf 'second line\\n'";
        let script = block_script("tok", command).expect("script");
        assert_eq!(script.matches('\n').count(), 1, "{script}");
        assert!(script.ends_with('\n'));
        for shell in [resolve_zsh(), resolve_bash()].into_iter().flatten() {
            let line = script.strip_prefix('\u{15}').expect("line editor clear");
            let output = crate::command::resolved_command(&shell)
                .arg("-c")
                .arg(line)
                .output()
                .expect("run shell");
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                stdout.contains("\x1b]633;Oxide;tok;start\x07it's|a\\b|"),
                "{shell:?}: {stdout:?}"
            );
            assert!(
                stdout.contains("second line\n\x1b]633;Oxide;tok;end;0;"),
                "{shell:?}: {stdout:?}"
            );
        }
    }

    #[test]
    fn unix_allowlist_rejects_windows_shells() {
        assert!(is_shell_supported(ShellKind::Default));
        assert!(!is_shell_supported(ShellKind::PowerShell));
        assert!(!is_shell_supported(ShellKind::Pwsh));
    }

    #[test]
    fn the_block_wrapper_refuses_a_token_that_could_break_out_of_it() {
        for token in ["", "a'b", "a;b", "a\"b", "a b", "$(x)"] {
            assert!(block_script(token, "echo hi").is_err(), "{token:?}");
        }
    }

    #[test]
    fn the_block_wrapper_stays_out_of_the_shell_history() {
        // Ctrl+U clears the line editor; the line it then reads starts with a space.
        let script = block_script("token", "echo hi").expect("script");
        assert!(script.strip_prefix('\u{15}').unwrap().starts_with(' '));
    }
}
