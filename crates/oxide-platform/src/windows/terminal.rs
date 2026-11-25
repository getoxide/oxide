//! The interactive shell of a Terminal on Windows: PowerShell with block markers. Children are
//! contained by Job Objects (see `process`), so there are no groups or sessions to clean up.

use crate::command::{find_in, os_tool};
use crate::{AvailableShell, ShellKind, ShellLaunch, ShellProcess, diag};
use base64::Engine;
use portable_pty::MasterPty;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

/// Oxide's prompt and `oxideEnd`, which returns the end marker of the running block (and forgets
/// its token) for the prompt to write and the block wrapper to emit as pipeline output. Outside a
/// block the prompt writes a `prompt` marker with the folder; its first one tells Core the
/// profile has run and the REPL reads input.
const BLOCK_PROMPT_COMMAND: &str = r#"function global:oxideEnd($oxideCode) { $oxideMarker=([char]27)+']633;Oxide;'+$global:oxideCommandToken+';end;'+$oxideCode+';'+$pwd.ProviderPath+[char]7; $global:oxideCommandToken=$null; $oxideMarker }; function global:prompt { if ($null -ne $global:oxideCommandToken) { $oxideCode=if($null -ne $global:oxideExitCode){$global:oxideExitCode}else{if($global:LASTEXITCODE){$global:LASTEXITCODE}else{1}}; [Console]::Write((oxideEnd $oxideCode)) } else { [Console]::Write(([char]27)+']633;Oxide;prompt;'+$pwd.ProviderPath+[char]7) }; ' ' }"#;

fn resolve_pwsh() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH")
        && let Some(found) = find_in(
            &path,
            OsStr::new("pwsh.exe"),
            std::env::var_os("PATHEXT").as_deref(),
        )
    {
        return Some(found);
    }
    let standard = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
    standard.is_file().then_some(standard)
}

/// Installed shells supported by Oxide on Windows (ADR-0016 allowlist).
pub fn available_shells() -> Vec<AvailableShell> {
    let mut shells = vec![AvailableShell {
        kind: ShellKind::Default,
        label: "System default".into(),
        is_default: true,
    }];
    if os_tool("powershell").is_file()
        || find_in(
            &std::env::var_os("PATH").unwrap_or_default(),
            OsStr::new("powershell.exe"),
            None,
        )
        .is_some()
    {
        shells.push(AvailableShell {
            kind: ShellKind::PowerShell,
            label: "Windows PowerShell".into(),
            is_default: false,
        });
    }
    if resolve_pwsh().is_some() {
        shells.push(AvailableShell {
            kind: ShellKind::Pwsh,
            label: "PowerShell (pwsh)".into(),
            is_default: false,
        });
    }
    shells
}

/// Whether `shell` is in Windows's Terminal allowlist (ADR-0016).
pub fn is_shell_supported(shell: ShellKind) -> bool {
    matches!(shell, ShellKind::Default | ShellKind::PowerShell)
        || (shell == ShellKind::Pwsh && resolve_pwsh().is_some())
}

/// The shell to start. With `blocks`, PowerShell's real REPL with the block prompt: Ctrl+C
/// cancels a pipeline without killing the shell.
pub fn shell_launch(
    blocks: bool,
    _init_file: Option<&Path>,
    shell: ShellKind,
    load_user_config: bool,
) -> ShellLaunch {
    let_children_receive_ctrl_c();
    let (name, program) = match shell {
        ShellKind::Pwsh => (
            "pwsh".to_string(),
            resolve_pwsh()
                .map(Into::into)
                .unwrap_or_else(|| "pwsh.exe".into()),
        ),
        _ => ("PowerShell".to_string(), "powershell.exe".into()),
    };
    let mut launch = ShellLaunch {
        name,
        program,
        args: Vec::new(),
        env: Vec::new(),
    };
    if !load_user_config {
        launch.args.push("-NoProfile".into());
    }
    if blocks {
        launch.args.extend([
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            BLOCK_PROMPT_COMMAND.into(),
        ]);
    }
    launch
}

/// Clears this process's "ignore Ctrl+C" flag, so the shell started next can be interrupted.
/// A process started in a new process group (as CI runners and test harnesses start theirs)
/// ignores Ctrl+C, and every child inherits the flag: the Ctrl+C event ConPTY makes of the 0x03
/// key would then reach neither PowerShell nor the program it runs.
fn let_children_receive_ctrl_c() {
    // SAFETY: a null handler passes no pointer; with FALSE the call only clears the flag.
    if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
        diag::best_effort::<(), _>("SetConsoleCtrlHandler", Err(io::Error::last_os_error()));
    }
}

/// What to type into the shell to run `command` as a block marked by `token`. The leading `;`
/// ends whatever stray input sits in the line editor as a statement of its own, and the prompt
/// is defined before and after the command, so a block that replaces it never gets its own
/// printed. The command runs from base64 (a syntax error fails the block), then the end is marked
/// inline, as pipeline output so it follows any output PowerShell is still formatting; the prompt
/// marks the end only of a block stopped by Ctrl+C. A token other than ASCII letters, digits and
/// `-` is refused.
pub fn block_script(token: &str, command: &str) -> io::Result<String> {
    let token = crate::block_token(token)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(command);
    Ok(format!(
        "; {BLOCK_PROMPT_COMMAND}; [Console]::Clear(); $global:oxideCommandToken='{token}'; $global:oxideExitCode=$null; $global:LASTEXITCODE=0; $oxideOk=$true; [Console]::Write(([char]27)+']633;Oxide;{token};start'+[char]7); try {{ . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))); $oxideOk=$? }} catch {{ Write-Error $_; $oxideOk=$false }} finally {{ $global:oxideExitCode=if($oxideOk){{$global:LASTEXITCODE}}else{{if($global:LASTEXITCODE){{$global:LASTEXITCODE}}else{{1}}}} }}; if ($null -ne $global:oxideCommandToken) {{ oxideEnd $global:oxideExitCode }}; {BLOCK_PROMPT_COMMAND}\r"
    ))
}

/// A script that asks PowerShell itself for completions (`TabExpansion2`) and prints the answer
/// as an `OSC 633;Oxide;complete;<token>;<base64 JSON>` marker.
pub fn completion_script(token: u32, line: &str, cursor: usize) -> Option<String> {
    let input = base64::engine::general_purpose::STANDARD.encode(line);
    Some(format!(
        "$oxideLineText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{input}')); $oxideCompletion=TabExpansion2 $oxideLineText {cursor}; $oxideResult=@{{replacementIndex=[Math]::Max(0,$oxideCompletion.ReplacementIndex); replacementLength=[Math]::Max(0,$oxideCompletion.ReplacementLength); matches=@($oxideCompletion.CompletionMatches | Select-Object -First 200 | ForEach-Object {{ @{{text=[string]$_.CompletionText; label=[string]$_.ListItemText; detail=[string]$_.ToolTip}} }})}} | ConvertTo-Json -Depth 5 -Compress; [Console]::Write(([char]27)+']633;Oxide;complete;{token};'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($oxideResult))+[char]7)\r"
    ))
}

/// PowerShell needs no rc file.
pub fn create_shell_init_file(
    _home: &Path,
    _id: u32,
    _shell: ShellKind,
    _load_user_config: bool,
) -> io::Result<Option<PathBuf>> {
    Ok(None)
}

/// Windows contains a shell's tree in a Job Object, not in a process group.
pub fn session_group(_shell_pid: u32, _master: &dyn MasterPty) -> Option<i32> {
    None
}

/// Writes `input` to the shell. Ctrl+C (0x03) goes through ConPTY like any key: the console
/// turns it into a Ctrl+C event for a program that processes input, or hands it to one that reads
/// raw keys (and may want a second press to quit). PowerShell's REPL survives it.
pub fn write_input(
    writer: &mut dyn Write,
    input: &[u8],
    _shell_pid: u32,
    _master: &dyn MasterPty,
) -> io::Result<()> {
    writer.write_all(input)?;
    writer.flush()
}

/// Ends a shell: killing the process ends its Job Object, and with it the rest.
pub fn close_session(_group: Option<i32>, _grace: Duration, shell: &mut dyn ShellProcess) {
    shell.kill();
}

/// Nothing outlives a Job Object.
pub fn clean_up_session(_group: Option<i32>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ShellKind;

    #[test]
    fn the_block_wrapper_is_one_line_that_marks_its_own_end() {
        let script = block_script("tok", "Write-Output 'a'\nWrite-Output \"b\"").expect("script");
        assert_eq!(script.matches('\r').count(), 1, "{script}");
        assert!(!script.contains('\n'), "{script}");
        assert!(script.ends_with('\r'));
        assert!(script.starts_with("; "), "{script}");
        assert!(
            script.contains("$global:oxideCommandToken='tok'"),
            "{script}"
        );
        let start = script.find("Oxide;tok;start").expect("start marker");
        let end = script
            .find("oxideEnd $global:oxideExitCode")
            .expect("inline end marker");
        assert!(start < end);
        // The prompt and the end marker live in one place, shared by the prompt and the wrapper.
        assert!(BLOCK_PROMPT_COMMAND.contains("function global:oxideEnd"));
        assert!(BLOCK_PROMPT_COMMAND.contains("$global:oxideCommandToken=$null"));
    }

    /// A block that defines its own `prompt` gets Oxide's back before and after it runs, so the
    /// user's prompt never prints into the Terminal.
    #[test]
    fn the_block_wrapper_restores_the_prompt_after_the_command() {
        let script = block_script("tok", "function global:prompt { 'mine> ' }").expect("script");
        let end = script
            .find("oxideEnd $global:oxideExitCode")
            .expect("inline end marker");
        let before = script[..end].find("function global:prompt");
        let after = script[end..].find("function global:prompt");
        assert!(before.is_some() && after.is_some(), "{script}");
    }

    #[test]
    fn the_block_wrapper_refuses_a_token_that_could_break_out_of_it() {
        for token in ["", "a'b", "a;b", "a\"b", "a b", "$x"] {
            assert!(block_script(token, "Write-Output hi").is_err(), "{token:?}");
        }
    }

    #[test]
    fn available_shells_lists_default_and_powershell_without_unix_shells() {
        let shells = available_shells();
        assert!(
            shells
                .iter()
                .any(|s| s.kind == ShellKind::Default && s.is_default)
        );
        assert!(shells.iter().any(|s| s.kind == ShellKind::PowerShell));
        assert!(
            !shells
                .iter()
                .any(|s| matches!(s.kind, ShellKind::Zsh | ShellKind::Bash))
        );
    }

    #[test]
    fn clean_shell_launch_adds_noprofile_while_keeping_block_prompt() {
        let with_config = shell_launch(true, None, ShellKind::PowerShell, true);
        assert_eq!(with_config.name, "PowerShell");
        assert!(!with_config.args.iter().any(|a| a == "-NoProfile"));
        assert!(with_config.args.iter().any(|a| a == "-Command"));

        let clean = shell_launch(true, None, ShellKind::PowerShell, false);
        assert_eq!(clean.name, "PowerShell");
        assert!(clean.args.iter().any(|a| a == "-NoProfile"));
        assert!(clean.args.iter().any(|a| a == "-Command"));
    }

    #[test]
    fn pwsh_launch_uses_pwsh_and_respects_load_user_config() {
        let launch = shell_launch(true, None, ShellKind::Pwsh, false);
        assert_eq!(launch.name, "pwsh");
        assert!(
            launch
                .program
                .to_string_lossy()
                .to_lowercase()
                .contains("pwsh")
        );
        assert!(launch.args.iter().any(|a| a == "-NoProfile"));
        assert!(launch.args.iter().any(|a| a == "-Command"));
    }
}
