//! The interactive shell of a Terminal on Windows: PowerShell with block markers. Children are
//! contained by Job Objects (see `process`), so there are no groups or sessions to clean up.

use crate::{ShellLaunch, ShellProcess};
use base64::Engine;
use portable_pty::MasterPty;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The shell to start. With `blocks`, PowerShell's real REPL with the block prompt: Ctrl+C
/// cancels a pipeline without killing the shell.
pub fn shell_launch(blocks: bool, _init_file: Option<&Path>) -> ShellLaunch {
    let mut launch = ShellLaunch {
        name: "PowerShell".into(),
        program: "powershell.exe".into(),
        args: Vec::new(),
        env: Vec::new(),
    };
    if blocks {
        launch.args.extend([
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            r#"function global:prompt { if ($null -ne $global:oxideCommandToken) { $oxideCode=if($null -ne $global:oxideExitCode){$global:oxideExitCode}else{if($global:LASTEXITCODE){$global:LASTEXITCODE}else{1}}; [Console]::Write(([char]27)+"]633;Oxide;$($global:oxideCommandToken);end;$oxideCode;$($pwd.ProviderPath)"+[char]7); $global:oxideCommandToken=$null }; ' ' }"#.into(),
        ]);
    }
    launch
}

/// What to type into the shell to run `command` as a block marked by `token`.
pub fn block_script(token: &str, command: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(command);
    format!(
        "[Console]::Clear(); $global:oxideCommandToken='{token}'; $global:oxideExitCode=$null; $global:LASTEXITCODE=0; $oxideOk=$true; [Console]::Write(([char]27)+']633;Oxide;{token};start'+[char]7); try {{ . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))); $oxideOk=$? }} catch {{ Write-Error $_; $oxideOk=$false }} finally {{ $global:oxideExitCode=if($oxideOk){{$global:LASTEXITCODE}}else{{if($global:LASTEXITCODE){{$global:LASTEXITCODE}}else{{1}}}} }}\r"
    )
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
pub fn create_shell_init_file(_home: &Path, _id: u32) -> io::Result<Option<PathBuf>> {
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
