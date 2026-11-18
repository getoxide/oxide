//! Native system integration on Linux: `xdg-open`. Linux has no Dock icon.

use crate::diag;
use std::path::Path;

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
