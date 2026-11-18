//! Native system integration on Windows: ShellExecute and Explorer.

use crate::diag;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::UI::Shell::ShellExecuteW;

/// Opens `url` in the default browser. Core passes only links it has checked.
pub fn open_url(url: &str) {
    let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_op: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: ShellExecuteW is called with valid null-terminated UTF-16 strings.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide_op.as_ptr(),
            wide_url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };
    if (result as usize) <= 32 {
        diag::best_effort(
            "rundll32",
            crate::command::os_command("rundll32")
                .args(["url.dll,FileProtocolHandler", url])
                .spawn(),
        );
    }
}

/// Shows `path` selected in Explorer.
pub fn reveal_in_file_manager(path: &Path) {
    use std::os::windows::process::CommandExt;
    // `raw_arg`: the quoted path is one argument, so a comma in a folder name cannot split it.
    diag::best_effort(
        "explorer",
        crate::command::os_command("explorer")
            .raw_arg(crate::explorer::select_arg(&path.to_string_lossy()))
            .spawn(),
    );
}

/// Windows shows no Dock icon.
pub fn set_dev_dock_icon(_png: &[u8]) {}
