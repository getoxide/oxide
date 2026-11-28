//! Native system integration on macOS: `open` and the Dock icon.

use crate::diag;
use std::path::Path;

/// `open`.
pub fn open_url(url: &str) {
    diag::best_effort("open", crate::command::os_command("open").arg(url).spawn());
}

/// Shows `path` selected in Finder.
pub fn reveal_in_file_manager(path: &Path) {
    diag::best_effort(
        "open",
        crate::command::os_command("open")
            .arg("-R")
            .arg(path)
            .spawn(),
    );
}

/// Shows the "Oxide Dev" icon in the Dock. `tauri dev` runs a bare binary with no bundle, so
/// macOS would otherwise show a generic icon and the dev build could not be told from a release.
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

/// Returns a sorted, deduplicated list of installed font family names via `atsutil`.
pub fn system_fonts() -> Vec<String> {
    let mut command = crate::command::os_command("atsutil");
    command.args(["fonts", "-list"]);
    crate::fonts::run_bounded_font_command(command, |lines| {
        let mut in_families = false;
        let mut families = Vec::new();
        for line in lines {
            let trimmed = line.trim();
            if trimmed == "System Families:" {
                in_families = true;
                continue;
            }
            if in_families {
                if trimmed.is_empty() || trimmed.ends_with(':') {
                    break;
                }
                families.push(trimmed.to_string());
            }
        }
        families
    })
}

/// Homebrew's `llvm` formula, on Apple silicon and on Intel.
pub fn llvm_dirs() -> Vec<std::path::PathBuf> {
    vec![
        "/opt/homebrew/opt/llvm/bin".into(),
        "/usr/local/opt/llvm/bin".into(),
    ]
}
