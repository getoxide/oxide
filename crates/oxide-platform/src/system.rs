//! Native system integration: the browser, the file manager, the Dock and installed fonts.

use crate::imp::system as imp;
use std::path::Path;

/// Opens `url` in the default browser. Core passes only links it has checked.
pub fn open_url(url: &str) {
    imp::open_url(url);
}

/// Shows `path` in the file manager (selected in Finder and Explorer; its folder elsewhere).
pub fn reveal_in_file_manager(path: &Path) {
    imp::reveal_in_file_manager(path);
}

/// Shows the "Oxide Dev" icon in the Dock. `tauri dev` runs a bare binary with no bundle, so
/// macOS would otherwise show a generic icon and the dev build could not be told from a release.
/// Only macOS has a Dock; elsewhere it does nothing.
pub fn set_dev_dock_icon(png: &[u8]) {
    imp::set_dev_dock_icon(png);
}

/// The installed font families, sorted and deduplicated.
pub fn system_fonts() -> Vec<String> {
    imp::system_fonts()
}

/// Directories where an LLVM installed by the usual package manager keeps `clangd` and the
/// other LLVM tools when they are not on the `PATH` (`winget` on Windows, Homebrew on macOS).
pub fn llvm_dirs() -> Vec<std::path::PathBuf> {
    imp::llvm_dirs()
}
