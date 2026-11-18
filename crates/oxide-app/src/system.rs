//! The host shell integration of Core: opening links and showing folders.

use oxide_core::System;
use oxide_core::diag;
use tauri::AppHandle;

pub struct HostSystem;

impl HostSystem {
    pub fn new(_app: AppHandle) -> Self {
        Self
    }
}

/// The `explorer /select,` argument for `path`, quoted whole so a comma in a folder name cannot
/// split it into several arguments.
#[cfg(any(windows, test))]
fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('/', "\\"))
}

impl System for HostSystem {
    fn open_url(&self, url: &str) {
        // Core passes only links it has checked: https GitHub pages and https links to other hosts the user confirmed.
        #[cfg(target_os = "macos")]
        diag::best_effort(
            "open",
            oxide_core::desktop_tools::os_command("open")
                .arg(url)
                .spawn(),
        );

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::UI::Shell::ShellExecuteW;

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
                    oxide_core::desktop_tools::os_command("rundll32")
                        .args(["url.dll,FileProtocolHandler", url])
                        .spawn(),
                );
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        diag::best_effort(
            "xdg-open",
            oxide_core::desktop_tools::os_command("xdg-open")
                .arg(url)
                .spawn(),
        );
    }

    #[cfg(target_os = "macos")]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        diag::best_effort(
            "open",
            oxide_core::desktop_tools::os_command("open")
                .arg("-R")
                .arg(path)
                .spawn(),
        );
    }

    #[cfg(target_os = "windows")]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        use std::os::windows::process::CommandExt;
        // `raw_arg`: the quoted path is one argument, so a comma in a folder name cannot split it.
        diag::best_effort(
            "explorer",
            oxide_core::desktop_tools::os_command("explorer")
                .raw_arg(explorer_select_arg(&path.to_string_lossy()))
                .spawn(),
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        diag::best_effort(
            "xdg-open",
            oxide_core::desktop_tools::os_command("xdg-open")
                .arg(path)
                .spawn(),
        );
    }
}

/// Shows the "Oxide Dev" icon in the Dock. `tauri dev` runs a bare binary with no bundle, so
/// macOS would otherwise show a generic icon and the dev build could not be told from a release.
#[cfg(all(target_os = "macos", debug_assertions))]
pub fn set_dev_dock_icon(png: &[u8]) {
    use objc2::AllocAnyThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png));
    if let Some(image) = image {
        // SAFETY: `main` proves we are on the main thread, which AppKit requires, and `image` is
        // a valid NSImage that outlives the call.
        unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)) };
    }
}

#[cfg(test)]
mod explorer_tests {
    use super::explorer_select_arg;

    #[test]
    fn explorer_receives_the_path_as_one_quoted_argument() {
        assert_eq!(
            explorer_select_arg("C:/Users/me/a, b/file.txt"),
            "/select,\"C:\\Users\\me\\a, b\\file.txt\""
        );
    }
}
