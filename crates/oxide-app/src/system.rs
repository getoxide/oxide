//! The host shell integration of Core: opening links and showing folders. What needs an OS API
//! is the platform layer's (`oxide_platform::system`); this is the Tauri side.

use oxide_core::System;
use oxide_platform::system as os;
use tauri::AppHandle;

pub struct HostSystem;

impl HostSystem {
    pub fn new(_app: AppHandle) -> Self {
        Self
    }
}

impl System for HostSystem {
    fn open_url(&self, url: &str) {
        // Core passes only links it has checked: https GitHub pages and https links to other hosts the user confirmed.
        os::open_url(url);
    }

    fn reveal_in_finder(&self, path: &std::path::Path) {
        os::reveal_in_file_manager(path);
    }
}
