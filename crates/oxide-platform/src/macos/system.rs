//! Native system integration on macOS: `open` and the Dock icon.

use crate::diag;
use std::path::Path;

/// Opens `url` in the default browser. Core passes only links it has checked.
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
