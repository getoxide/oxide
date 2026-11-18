//! The operating-system side of Core, injected by the App shell.

use std::path::Path;

/// What Core asks of the host: open a link and show a folder.
pub trait System: Send + Sync + 'static {
    /// Opens a web page in the user's browser.
    fn open_url(&self, _url: &str) {}
    /// Shows a file or folder in Finder or File Explorer.
    fn reveal_in_finder(&self, _path: &Path) {}
}

pub(crate) struct NoSystem;

impl System for NoSystem {}
