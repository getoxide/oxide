//! The App side of in-app updates (ADR-0021): asks the feed through the Tauri updater plugin
//! at launch and every 4 hours, hands what it found to Core, and pushes Core's state to the window.
//! The plugin is used from Rust only: the webview has no updater permission and cannot reach it.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oxide_core::LockExt as _;
use oxide_core::{BundleKind, Core, DebugOverride, UpdatePlan, diag};
use semver::Version;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::Update;
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

/// Whether an install can update itself where it sits: a macOS app outside the Applications
/// folders must be moved first.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallLocation {
    Allowed,
    MoveToApplications,
}

impl From<oxide_core::InstallLocation> for InstallLocation {
    fn from(location: oxide_core::InstallLocation) -> Self {
        match location {
            oxide_core::InstallLocation::Allowed => Self::Allowed,
            oxide_core::InstallLocation::MoveToApplications => Self::MoveToApplications,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub release_notes_url: String,
}

/// A finished check; `at` is Unix seconds (a float: the bindings forbid 64-bit integers).
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LastCheck {
    pub at: f64,
    pub succeeded: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub channel: InstallChannel,
    pub install_location: InstallLocation,
    pub current_version: String,
    /// Unix seconds (a float: the bindings forbid 64-bit integers).
    pub last_checked_at: Option<f64>,
    /// The last check that finished, successful or not: a failed one shows only in Settings.
    pub last_check: Option<LastCheck>,
    /// A check is running.
    pub checking: bool,
    pub available: Option<AvailableUpdate>,
    pub operation: UpdateOperation,
    /// Why the last install failed; the installed Oxide keeps running and the update is offered again.
    pub error: Option<String>,
}

/// Sizes are floats: the bindings forbid 64-bit integers.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UpdateOperation {
    Idle,
    Downloading {
        downloaded: f64,
        total: Option<f64>,
    },
    Installing,
    /// Installed and waiting for a restart. `staged` (Windows): runs when Oxide quits.
    Installed {
        staged: bool,
    },
}

impl From<oxide_core::UpdateOperation> for UpdateOperation {
    #[allow(clippy::cast_precision_loss)]
    fn from(operation: oxide_core::UpdateOperation) -> Self {
        match operation {
            oxide_core::UpdateOperation::Idle => Self::Idle,
            oxide_core::UpdateOperation::Downloading { downloaded, total } => Self::Downloading {
                downloaded: downloaded as f64,
                total: total.map(|bytes| bytes as f64),
            },
            oxide_core::UpdateOperation::Installing => Self::Installing,
            oxide_core::UpdateOperation::Installed { staged } => Self::Installed { staged },
        }
    }
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
            install_location: state.install_location.into(),
            current_version: state.current_version,
            last_checked_at: state.last_checked_at.map(|seconds| seconds as f64),
            last_check: state.last_check.map(|check| LastCheck {
                at: check.at as f64,
                succeeded: check.succeeded,
            }),
            checking: state.checking,
            available: state.available.map(|update| AvailableUpdate {
                version: update.version,
                release_notes_url: update.release_notes_url,
            }),
            operation: state.operation.into(),
            error: state.error,
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
            feed: std::env::var("OXIDE_UPDATE_FEED")
                .ok()
                .filter(|value| !value.is_empty()),
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

/// A debug build runs from the build folder and is never placed: only a release build is held to the rule.
fn install_location() -> oxide_core::InstallLocation {
    if cfg!(debug_assertions) {
        return oxide_core::InstallLocation::Allowed;
    }
    let Ok(exe) = std::env::current_exe() else {
        return oxide_core::InstallLocation::Allowed;
    };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    oxide_core::InstallLocation::detect(bundle_kind(), &exe, home.as_deref())
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
    let plan = Version::parse(&current).ok().map(|version| {
        UpdatePlan::resolve(
            &version,
            bundle_kind(),
            cfg!(debug_assertions),
            &debug_override(),
        )
    });
    // Managed first, whatever the version says: the commands take this state and must never meet it missing.
    app.manage(Arc::new(Installer {
        feed: plan.as_ref().map_or_else(
            || oxide_core::STABLE_FEED.to_string(),
            |plan| plan.feed.clone(),
        ),
        current: current.clone(),
        staged: Mutex::new(None),
    }));
    // An unreadable version leaves Core on the development channel: it never checks or installs.
    let Some(plan) = plan else {
        return;
    };
    core.configure_updates(plan.channel, &current);
    core.set_update_install_location(install_location());
    if !plan.channel.checks() {
        return;
    }
    let app = app.clone();
    let core = Arc::clone(core);
    diag::best_effort(
        "updates thread",
        std::thread::Builder::new()
            .name("updates".into())
            .spawn(move || {
                loop {
                    // Skipped (Busy) while an install or another check runs. A failed check is recorded
                    // for the Updates section; the window shows nothing, the next one is in 4 hours.
                    let outcome = tauri::async_runtime::block_on(run_check(
                        &app, &core, &plan.feed, &current,
                    ));
                    if outcome != Err(oxide_core::UpdateError::Busy) {
                        diag::best_effort("update check", outcome);
                    }
                    std::thread::sleep(oxide_core::CHECK_INTERVAL);
                }
            }),
    );
}

fn build_updater(
    app: &AppHandle,
    feed: &str,
    current: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let url = feed.parse().map_err(|error| format!("{error}"))?;
    let current = current.to_string();
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .timeout(REQUEST_TIMEOUT)
        .version_comparator(move |_, remote| {
            oxide_core::is_newer(&current, &remote.version.to_string())
        })
        .build()
        .map_err(|error| error.to_string())
}

async fn resolve_feed_url(feed: &str) -> Result<String, String> {
    if feed == oxide_core::PRERELEASE_FEED {
        return tauri::async_runtime::spawn_blocking(oxide_core::resolve_prerelease_feed_url)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(feed.to_string())
}

/// The version the feed offers when it is newer than the running one. The plugin verifies nothing
/// until a package is downloaded; the signature is checked against the compiled-in public key then.
async fn check(app: &AppHandle, feed: &str, current: &str) -> Result<Option<String>, String> {
    let resolved = resolve_feed_url(feed).await?;
    let update = build_updater(app, &resolved, current)?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| update.version))
}

/// One check from start to finish: marks Core as checking, asks the feed, records the outcome and
/// pushes each change. `Err(Busy)` when an install or another check is running.
async fn run_check(
    app: &AppHandle,
    core: &Arc<Core>,
    feed: &str,
    current: &str,
) -> Result<(), oxide_core::UpdateError> {
    push(app, core.begin_update_check()?);
    let state = match check(app, feed, current).await {
        Ok(found) => core.record_update_check(found.as_deref(), unix_now()),
        Err(_) => Some(core.record_update_check_failure(unix_now())),
    };
    if let Some(state) = state {
        push(app, state);
    }
    Ok(())
}

/// A verified Windows installer kept for the quit: the installer ends the process, so it cannot run before.
struct Staged {
    update: Update,
    bytes: Vec<u8>,
}

/// What an install needs besides Core's state: where the feed is and the staged installer.
pub struct Installer {
    feed: String,
    current: String,
    staged: Mutex<Option<Staged>>,
}

fn push(app: &AppHandle, state: oxide_core::UpdateState) {
    diag::best_effort("emit", app.emit(STATE_EVENT, UpdateState::from(state)));
}

/// Downloads (the plugin verifies the signature before returning the bytes), then installs or,
/// on Windows, stages. Always starts from a fresh check, so an install many releases behind
/// goes straight to what the feed offers now.
async fn run_install(
    app: &AppHandle,
    core: &Arc<Core>,
    installer: &Installer,
) -> Result<bool, String> {
    let resolved = resolve_feed_url(&installer.feed).await?;
    let update = build_updater(app, &resolved, &installer.current)?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("The update is no longer available.")?;
    let mut downloaded: u64 = 0;
    let mut last_pushed = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // About a hundred pushes per download, however many chunks arrive.
                let step = total.map_or(downloaded / (256 * 1024), |size| {
                    downloaded * 100 / size.max(1)
                });
                if step != last_pushed
                    && let Some(state) = core.record_update_progress(downloaded, total)
                {
                    last_pushed = step;
                    push(app, state);
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    if let Some(state) = core.begin_update_installing() {
        push(app, state);
    }
    if cfg!(windows) {
        *installer.staged.lock_recover() = Some(Staged { update, bytes });
        return Ok(true);
    }
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(false)
}

/// Runs the staged Windows installer when Oxide quits (after Core stopped its shells). Passive
/// mode: no wizard pages. The installer ends this process and the new version starts.
pub fn run_staged_install(app: &AppHandle, core: &Core) {
    if !core.staged_update_due_at_quit() {
        return;
    }
    let Some(installer) = app.try_state::<Arc<Installer>>() else {
        return;
    };
    let staged = installer.staged.lock_recover().take();
    if let Some(staged) = staged {
        // Only a confirmed "Restart now" relaunches Oxide; a plain quit installs and stays closed.
        let relaunch = core.update_exit_restarts();
        diag::best_effort(
            "staged update install",
            staged
                .update
                .restart_after_install(relaunch)
                .install(&staged.bytes),
        );
    }
}

/// Starts the install of the available update and returns at once: progress and the outcome
/// arrive as `update-state-changed`. Only one operation runs at a time. Outside any checkout, it
/// downloads the package from the compiled-in feed and, once the plugin has verified its signature
/// against the compiled-in key, replaces the installed app (macOS, AppImage) or stages the installer
/// it runs at quit (Windows). It takes no argument from the webview (ADR-0016).
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn install_update(
    app: AppHandle,
    core: tauri::State<'_, Arc<Core>>,
    installer: tauri::State<'_, Arc<Installer>>,
) -> Result<(), crate::AppError> {
    let (_, state) = core
        .begin_update_install()
        .map_err(|error| crate::AppError {
            message: error.message().to_string(),
        })?;
    push(&app, state);
    let core = Arc::clone(&core);
    let installer = Arc::clone(&installer);
    tauri::async_runtime::spawn(async move {
        let finished = match run_install(&app, &core, &installer).await {
            Ok(staged) => core.finish_update_install(staged),
            Err(reason) => core.fail_update_install(&reason),
        };
        push(&app, finished);
    });
    Ok(())
}

/// Checks the feed now, on demand from the Updates section, and returns the new state. A check that
/// cannot reach the feed is not an error: it is recorded in the state and shown only in Settings.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub async fn check_for_updates(
    app: AppHandle,
    core: tauri::State<'_, Arc<Core>>,
    installer: tauri::State<'_, Arc<Installer>>,
) -> Result<UpdateState, crate::AppError> {
    run_check(&app, &core, &installer.feed, &installer.current)
        .await
        .map_err(|error| crate::AppError {
            message: error.message().to_string(),
        })?;
    Ok(core.update_state().into())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn update_state(core: tauri::State<'_, Arc<Core>>) -> UpdateState {
    core.update_state().into()
}
