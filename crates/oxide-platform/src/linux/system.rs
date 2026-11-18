//! Native system integration on Linux: `xdg-open`. Linux has no activity assertion to hold and
//! no Dock icon.

use crate::diag;
use std::path::Path;

/// What keeps the app awake while a Thread works. Linux holds nothing, so none is ever made.
pub struct ActivityHold;

/// Keeps the app awake while a Thread works. Nothing to hold on Linux.
pub fn hold_activity() -> Option<ActivityHold> {
    None
}

/// Opens `url` in the default browser. Core passes only links it has checked.
pub fn open_url(url: &str) {
    diag::best_effort(
        "xdg-open",
        crate::command::os_command("xdg-open").arg(url).spawn(),
    );
}

/// Opens the file manager at `path`.
pub fn reveal_in_file_manager(path: &Path) {
    diag::best_effort(
        "xdg-open",
        crate::command::os_command("xdg-open").arg(path).spawn(),
    );
}

/// Linux shows no Dock icon.
pub fn set_dev_dock_icon(_png: &[u8]) {}
