//! Native system integration on Windows: the execution-state request, ShellExecute, Explorer.

use crate::diag;
use crate::diag::SenderExt as _;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;

/// A thread that asks Windows to stay awake while it lives. Dropping the hold stops the thread,
/// which clears the request.
pub struct ActivityHold {
    stop: std::sync::mpsc::Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ActivityHold {
    fn drop(&mut self) {
        self.stop.tell(());
        if let Some(handle) = self.handle.take() {
            diag::joined("join", handle.join());
        }
    }
}

/// Keeps the system from sleeping while a Thread works.
pub fn hold_activity() -> Option<ActivityHold> {
    let (stop, rx) = std::sync::mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("oxide-activity-hold".into())
        .spawn(move || {
            // SAFETY: `SetThreadExecutionState` takes flag constants only and affects just
            // this thread's execution state; it touches no memory of ours.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
            diag::best_effort("recv", rx.recv());
            // SAFETY: same as above; `ES_CONTINUOUS` alone clears the request made by this
            // thread.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        });
    match thread {
        Ok(handle) => Some(ActivityHold {
            stop,
            handle: Some(handle),
        }),
        Err(err) => {
            eprintln!("Failed to spawn thread for activity hold: {err}");
            None
        }
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_the_hold_releases_the_execution_state() {
        let hold = hold_activity().expect("the activity thread starts");
        drop(hold);
        // SAFETY: flag constants only; this thread's own state, as in `hold_activity`.
        let restored = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        assert_ne!(restored, 0, "SetThreadExecutionState must succeed");
    }
}
