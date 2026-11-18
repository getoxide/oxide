//! The host shell integration of Core's activity: activity assertions, notifications,
//! opening URLs and files, and the window badge. What needs an OS API is the platform layer's
//! (`oxide_platform::system`); this is the Tauri side.

use oxide_core::LockExt as _;
use oxide_core::diag;
use oxide_core::{Notification, NotificationKind, System};
use oxide_platform::system::{self as os, ActivityHold};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct HostSystem {
    app: AppHandle,
    activity: std::sync::Mutex<Option<ActivityHold>>,
}

impl HostSystem {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            activity: std::sync::Mutex::new(None),
        }
    }
}

impl System for HostSystem {
    fn hold_activity(&self) {
        let mut held = self.activity.lock_recover();
        if held.is_none() {
            *held = os::hold_activity();
        }
    }

    fn release_activity(&self) {
        // Dropping the hold ends it.
        drop(self.activity.lock_recover().take());
    }

    fn notify(&self, notification: Notification) {
        let body = match notification.kind {
            NotificationKind::NeedsInput => "A Thread needs your input",
            NotificationKind::Completed => "A Thread finished",
        };
        diag::best_effort(
            "notification",
            self.app
                .notification()
                .builder()
                .title("Oxide")
                .body(body)
                .show(),
        );
    }

    fn open_url(&self, url: &str) {
        // Core passes only links it has checked: https GitHub pages, Project Service
        // loopback URLs and https links to other hosts the user confirmed.
        os::open_url(url);
    }

    fn reveal_in_finder(&self, path: &std::path::Path) {
        os::reveal_in_file_manager(path);
    }

    fn set_badge(&self, count: u32) {
        if let Some(window) = self.app.get_webview_window("main") {
            diag::best_effort(
                "set_badge_count",
                window.set_badge_count((count > 0).then_some(i64::from(count))),
            );
        }
    }
}
