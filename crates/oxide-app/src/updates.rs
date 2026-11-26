//! The App side of in-app updates (ADR-0021): asks the feed through the Tauri updater plugin
//! at launch and every 4 hours, hands what it found to Core, and pushes Core's state to the window.
//! The plugin is used from Rust only: the webview has no updater permission and cannot reach it.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oxide_core::{BundleKind, Core, DebugOverride, UpdatePlan, diag};
use semver::Version;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// The event the window listens to for every change of the update state.
pub const STATE_EVENT: &str = "update-state-changed";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallChannel {
    InApp,
    Apt,
    Dnf,
    Development,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub release_notes_url: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub channel: InstallChannel,
    pub current_version: String,
    /// Unix seconds (a float: the bindings forbid 64-bit integers).
    pub last_checked_at: Option<f64>,
    pub available: Option<AvailableUpdate>,
}

impl From<oxide_core::InstallChannel> for InstallChannel {
    fn from(channel: oxide_core::InstallChannel) -> Self {
        match channel {
            oxide_core::InstallChannel::InApp => Self::InApp,
            oxide_core::InstallChannel::Apt => Self::Apt,
            oxide_core::InstallChannel::Dnf => Self::Dnf,
            oxide_core::InstallChannel::Development => Self::Development,
        }
    }
}

impl From<oxide_core::UpdateState> for UpdateState {
    fn from(state: oxide_core::UpdateState) -> Self {
        Self {
            channel: state.channel.into(),
            current_version: state.current_version,
            last_checked_at: state.last_checked_at.map(|seconds| seconds as f64),
            available: state.available.map(|update| AvailableUpdate {
                version: update.version,
                release_notes_url: update.release_notes_url,
            }),
        }
    }
}

/// Debug builds only: two environment variables replace the feed address and the install channel
/// (`in-app`, `apt`, `dnf`, `none`), so `tauri dev` can run the flow against a local feed signed
/// with a test key. This module does not exist in a release build, and
/// `tests/update_override_is_debug_only.rs` keeps it that way (ADR-0016).
#[cfg(debug_assertions)]
mod debug_override {
    use oxide_core::{DebugOverride, InstallChannel};

    pub(super) fn read() -> DebugOverride {
        DebugOverride {
            feed: std::env::var("OXIDE_UPDATE_FEED").ok().filter(|value| !value.is_empty()),
            channel: std::env::var("OXIDE_UPDATE_CHANNEL")
                .ok()
                .and_then(|name| InstallChannel::parse_override(&name)),
        }
    }
}

#[cfg(debug_assertions)]
fn debug_override() -> DebugOverride {
    debug_override::read()
}

#[cfg(not(debug_assertions))]
fn debug_override() -> DebugOverride {
    DebugOverride::default()
}

fn bundle_kind() -> Option<BundleKind> {
    use tauri::utils::config::BundleType;
    use tauri::utils::platform::bundle_type;
    bundle_type().map(|kind| match kind {
        BundleType::App => BundleKind::App,
        BundleType::Nsis => BundleKind::Nsis,
        BundleType::AppImage => BundleKind::AppImage,
        BundleType::Deb => BundleKind::Deb,
        BundleType::Rpm => BundleKind::Rpm,
        _ => BundleKind::Other,
    })
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or_default()
}

/// Configures Core with this install's channel and starts the periodic check.
pub fn start(app: &AppHandle, core: &Arc<Core>) {
    let current = app.package_info().version.to_string();
    let Ok(version) = Version::parse(&current) else {
        return;
    };
    let plan = UpdatePlan::resolve(&version, bundle_kind(), cfg!(debug_assertions), &debug_override());
    core.configure_updates(plan.channel, &current);
    if !plan.channel.checks() {
        return;
    }
    let app = app.clone();
    let core = Arc::clone(core);
    diag::best_effort(
        "updates thread",
        std::thread::Builder::new().name("updates".into()).spawn(move || loop {
            // A failed check is silent: no state change, no event, the next one comes in 4 hours.
            if let Ok(found) = tauri::async_runtime::block_on(check(&app, &plan.feed, &current))
                && let Some(state) = core.record_update_check(found.as_deref(), unix_now())
            {
                diag::best_effort("emit", app.emit(STATE_EVENT, UpdateState::from(state)));
            }
            std::thread::sleep(oxide_core::CHECK_INTERVAL);
        }),
    );
}

/// The version the feed offers when it is newer than the running one. The plugin verifies nothing
/// until a package is installed; the signature is checked against the compiled-in public key then.
async fn check(app: &AppHandle, feed: &str, current: &str) -> Result<Option<String>, String> {
    let url = feed.parse().map_err(|error| format!("{error}"))?;
    let current = current.to_string();
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .timeout(REQUEST_TIMEOUT)
        .version_comparator(move |_, remote| oxide_core::is_newer(&current, &remote.version.to_string()))
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| update.version))
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn update_state(core: tauri::State<'_, Arc<Core>>) -> UpdateState {
    core.update_state().into()
}
