//! Signed application updates. URLs and public keys stay native; the webview only
//! checks the configured feed and installs the update returned by that check.
use crate::{AppError, Core};
use oxide_core::LockExt as _;
use serde::Serialize;
use specta::Type;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    phase: UpdatePhase,
    downloaded: f64,
    total: Option<f64>,
}

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    phase: UpdatePhase,
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Pending>,
    busy: AtomicBool,
}

#[allow(clippy::needless_pass_by_value)]
fn error(message: impl ToString) -> AppError {
    AppError {
        message: message.to_string(),
    }
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updates {
    fn begin(&self) -> Result<Operation<'_>, AppError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| error("An update operation is already running."))?;
        Ok(Operation(&self.busy))
    }
    fn status(&self, app: &AppHandle) -> UpdateStatus {
        let pending = self.pending.lock_recover();
        UpdateStatus {
            current_version: app.package_info().version.to_string(),
            version: pending.update.as_ref().map(|u| u.version.clone()),
            notes: pending.update.as_ref().and_then(|u| u.body.clone()),
            phase: pending.phase,
            downloaded: pending.downloaded as f64,
            total: pending.total.map(|n| n as f64),
        }
    }
    fn recover(&self) {
        let mut pending = self.pending.lock_recover();
        pending.phase = if pending.update.is_some() {
            UpdatePhase::Available
        } else {
            UpdatePhase::Idle
        };
    }
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn app_update_status(app: AppHandle, updates: State<'_, Arc<Updates>>) -> UpdateStatus {
    updates.status(&app)
}

#[tauri::command]
#[specta::specta]
pub async fn check_app_update(
    app: AppHandle,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateStatus, AppError> {
    let _operation = updates.begin()?;
    updates.pending.lock_recover().phase = UpdatePhase::Checking;
    let handle = app.clone();
    let result = async {
        app.updater_builder().timeout(Duration::from_secs(30))
            .on_before_exit(move || {
                handle.state::<Arc<Core>>().quit();
                handle.cleanup_before_exit();
            }).build().map_err(error)?.check().await.map_err(|e| {
                error(format!("Could not check for updates. Check your connection and try again. The update feed may not be published yet. ({e})"))
            })
    }.await;
    match result {
        Ok(update) => {
            let mut pending = updates.pending.lock_recover();
            pending.phase = if update.is_some() {
                UpdatePhase::Available
            } else {
                UpdatePhase::UpToDate
            };
            pending.update = update;
            pending.downloaded = 0;
            pending.total = None;
        }
        Err(e) => {
            updates.recover();
            return Err(e);
        }
    }
    Ok(updates.status(&app))
}

fn validate_install(dirty: u32, active: u32) -> Result<(), AppError> {
    if dirty > 0 {
        return Err(error("Save your open files before installing the update."));
    }
    if active > 0 {
        return Err(error(
            "Stop working Threads and resolve pending approvals before installing the update.",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn install_app_update(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    updates: State<'_, Arc<Updates>>,
    on_progress: tauri::ipc::Channel<UpdateStatus>,
) -> Result<(), AppError> {
    let _operation = updates.begin()?;
    validate_install(core.dirty_editor_count(), core.active_thread_count())?;
    let mut update = updates
        .pending
        .lock_recover()
        .update
        .clone()
        .ok_or_else(|| error("Check for updates before installing."))?;
    // Checking is short-lived; downloading a full app can take longer.
    update.timeout = Some(Duration::from_secs(600));
    {
        let mut pending = updates.pending.lock_recover();
        pending.phase = UpdatePhase::Downloading;
        pending.downloaded = 0;
        pending.total = None;
    }
    let result = async {
        let bytes = update
            .download(
                |length, total| {
                    {
                        let mut pending = updates.pending.lock_recover();
                        pending.downloaded += length as u64;
                        pending.total = total;
                    }
                    oxide_core::diag::best_effort(
                        "progress",
                        on_progress.send(updates.status(&app)),
                    );
                },
                || {},
            )
            .await
            .map_err(error)?;
        validate_install(core.dirty_editor_count(), core.active_thread_count())?;
        updates.pending.lock_recover().phase = UpdatePhase::Installing;
        oxide_core::diag::best_effort("progress", on_progress.send(updates.status(&app)));
        // Verify the signature again, then invoke the platform installer.
        update.verify(&bytes).map_err(error)?;
        tauri::async_runtime::spawn_blocking(move || install_verified_update(&update, bytes))
            .await
            .map_err(error)?
            .map_err(error)?;
        Ok::<_, AppError>(())
    }
    .await;
    if let Err(e) = result {
        updates.recover();
        return Err(e);
    }
    app.restart();
}

fn install_verified_update(update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !is_gzip(&bytes) {
        return macos_dmg::install(&bytes);
    }
    update.install(bytes).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", test))]
fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1f, 0x8b])
}

#[cfg(any(target_os = "macos", test))]
fn find_app_bundle(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .map(std::path::Path::to_path_buf)
}

#[cfg(any(target_os = "macos", test))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(any(target_os = "macos", test))]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// System helpers the macOS updater runs, by absolute path so nothing earlier on `PATH` (the
/// login shell's `PATH` is merged in at startup) can shadow them.
#[cfg(any(target_os = "macos", test))]
mod helpers {
    pub const HDIUTIL: &str = "/usr/bin/hdiutil";
    pub const DITTO: &str = "/usr/bin/ditto";
    pub const XATTR: &str = "/usr/bin/xattr";
    pub const OSASCRIPT: &str = "/usr/bin/osascript";
    pub const TOUCH: &str = "/usr/bin/touch";
    pub const MV: &str = "/bin/mv";
    pub const RM: &str = "/bin/rm";
}

/// Shell script for the privileged install. It copies from the read-only mounted image, inside
/// the privileged shell, so nothing unprivileged can change what is installed after the
/// signature check. On failure the previous bundle is put back.
#[cfg(any(target_os = "macos", test))]
fn privileged_install_script(source: &str, target: &str, backup: &str) -> String {
    use helpers::{DITTO, MV, RM, XATTR};
    install_script_with([MV, DITTO, XATTR, RM], source, target, backup)
}

/// The script body with the four helpers (`mv`, `ditto`, `xattr`, `rm`) injected, so a test can
/// run the real control flow against harmless stand-ins.
///
/// The first `mv` must succeed before anything else is touched: if it fails, the installed
/// bundle is still where it was and the script just stops. Only a failure after the bundle
/// was moved aside removes the partial copy and puts the backup back.
#[cfg(any(target_os = "macos", test))]
fn install_script_with(
    [mv, ditto, xattr, rm]: [&str; 4],
    source: &str,
    target: &str,
    backup: &str,
) -> String {
    let (s, t, b) = (
        shell_quote(source),
        shell_quote(target),
        shell_quote(backup),
    );
    format!(
        "{mv} {t} {b} || exit 1; \
         ( {ditto} {s} {t} && {xattr} -dr com.apple.quarantine {t} ) \
         || {{ {rm} -rf {t}; {mv} {b} {t}; exit 1; }}"
    )
}

#[cfg(target_os = "macos")]
mod macos_dmg {
    use super::{applescript_string, find_app_bundle, helpers, privileged_install_script};
    use std::fs;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct ScopedDir(PathBuf);

    impl ScopedDir {
        fn new_in(parent: &Path, prefix: &str) -> Result<Self, String> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            for attempt in 0..16u32 {
                let path =
                    parent.join(format!("{prefix}-{}-{nanos}-{attempt}", std::process::id()));
                match fs::DirBuilder::new().mode(0o700).create(&path) {
                    Ok(()) => return Ok(Self(path)),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(format!("Failed to create temporary directory: {e}")),
                }
            }
            Err("Failed to allocate temporary directory for update.".into())
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScopedDir {
        fn drop(&mut self) {
            oxide_core::diag::best_effort("remove_dir_all", fs::remove_dir_all(&self.0));
        }
    }

    #[cfg(test)]
    pub(super) fn new_scoped_dir_for_test(parent: &Path) -> PathBuf {
        let dir = ScopedDir::new_in(parent, "oxide-update-test").unwrap();
        let path = dir.0.clone();
        std::mem::forget(dir);
        path
    }

    struct MountedDmg(PathBuf);

    impl Drop for MountedDmg {
        fn drop(&mut self) {
            oxide_core::diag::best_effort(
                "hdiutil",
                oxide_core::desktop_tools::resolved_command(helpers::HDIUTIL)
                    .args(["detach", "-force"])
                    .arg(&self.0)
                    .status(),
            );
        }
    }

    fn same_volume_root(target: &Path) -> Result<PathBuf, String> {
        let target_dev = fs::symlink_metadata(target)
            .map_err(|e| format!("Cannot inspect installed app at {}: {e}", target.display()))?
            .dev();
        let candidates = [
            Some(std::env::temp_dir()),
            target.parent().map(Path::to_path_buf),
        ];
        candidates
            .into_iter()
            .flatten()
            .find(|dir| dir.metadata().is_ok_and(|m| m.dev() == target_dev))
            .ok_or_else(|| "No writable staging directory on the application's volume.".into())
    }

    fn find_dmg_app(mount_dir: &Path) -> Result<PathBuf, String> {
        let preferred = mount_dir.join("Oxide.app");
        if preferred.is_dir() {
            return Ok(preferred);
        }
        let entries =
            fs::read_dir(mount_dir).map_err(|e| format!("Cannot read mounted disk image: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.extension().and_then(|e| e.to_str()) == Some("app") {
                return Ok(path);
            }
        }
        Err("No application bundle found inside the update disk image.".into())
    }

    fn replace_bundle(target: &Path, staged: &Path, backup: &Path) -> std::io::Result<()> {
        fs::rename(target, backup)?;
        if let Err(err) = fs::rename(staged, target) {
            oxide_core::diag::best_effort("rename", fs::rename(backup, target));
            return Err(err);
        }
        Ok(())
    }

    fn run_privileged_install(source: &Path, target: &Path, backup: &Path) -> Result<(), String> {
        let script = privileged_install_script(
            &source.to_string_lossy(),
            &target.to_string_lossy(),
            &backup.to_string_lossy(),
        );
        let apple_script = format!(
            "do shell script {} with administrator privileges",
            applescript_string(&script)
        );
        let out = oxide_core::desktop_tools::resolved_command(helpers::OSASCRIPT)
            .args(["-e", &apple_script])
            .output()
            .map_err(|e| format!("Failed to request administrator privileges: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Failed to replace the installed application.".into()
            } else {
                stderr
            });
        }
        Ok(())
    }

    enum InstallError {
        PermissionDenied,
        Failed(String),
    }

    fn stage_and_replace(
        source_app: &Path,
        target: &Path,
        staged_app: &Path,
        backup_app: &Path,
    ) -> Result<(), InstallError> {
        let copy = oxide_core::desktop_tools::resolved_command(helpers::DITTO)
            .arg(source_app)
            .arg(staged_app)
            .output()
            .map_err(|e| {
                InstallError::Failed(format!("Failed to copy updated application: {e}"))
            })?;
        if !copy.status.success() {
            let stderr = String::from_utf8_lossy(&copy.stderr).trim().to_string();
            return Err(InstallError::Failed(format!(
                "Failed to copy updated application: {stderr}"
            )));
        }
        oxide_core::diag::best_effort(
            "xattr",
            oxide_core::desktop_tools::resolved_command(helpers::XATTR)
                .args(["-dr", "com.apple.quarantine"])
                .arg(staged_app)
                .output(),
        );
        fs::set_permissions(staged_app, fs::Permissions::from_mode(0o755)).map_err(|e| {
            InstallError::Failed(format!("Failed to set application permissions: {e}"))
        })?;
        match replace_bundle(target, staged_app, backup_app) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                Err(InstallError::PermissionDenied)
            }
            Err(e) => Err(InstallError::Failed(format!(
                "Failed to install updated application: {e}"
            ))),
        }
    }

    pub(super) fn install(bytes: &[u8]) -> Result<(), String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Cannot locate running executable: {e}"))?;
        let target = find_app_bundle(&exe).ok_or_else(|| {
            "In-place updates require running Oxide from a .app bundle.".to_string()
        })?;

        let sys_tmp = std::env::temp_dir();
        let dmg_dir = ScopedDir::new_in(&sys_tmp, "oxide-update-dmg")?;
        let dmg_path = dmg_dir.path().join("update.dmg");
        fs::write(&dmg_path, bytes)
            .map_err(|e| format!("Failed to write update disk image: {e}"))?;

        let mount_dir = ScopedDir::new_in(&sys_tmp, "oxide-update-mnt")?;
        let attach = oxide_core::desktop_tools::resolved_command(helpers::HDIUTIL)
            .args([
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(mount_dir.path())
            .arg(&dmg_path)
            .output()
            .map_err(|e| format!("Failed to run hdiutil: {e}"))?;
        if !attach.status.success() {
            let stderr = String::from_utf8_lossy(&attach.stderr).trim().to_string();
            return Err(format!("Failed to mount update disk image: {stderr}"));
        }
        let _mounted = MountedDmg(mount_dir.path().to_path_buf());

        let source_app = find_dmg_app(mount_dir.path())?;
        let volume_root = same_volume_root(&target)?;
        let stage_dir = ScopedDir::new_in(&volume_root, "oxide-update-stage")?;
        let backup_dir = ScopedDir::new_in(&volume_root, "oxide-update-backup")?;
        let staged_app = stage_dir.path().join("Oxide.app");
        let backup_app = backup_dir.path().join("Oxide.app");

        match stage_and_replace(&source_app, &target, &staged_app, &backup_app) {
            Ok(()) => {}
            Err(InstallError::PermissionDenied) => {
                // Copy from the mounted image inside the privileged script: the user-writable
                // staged copy is never what gets installed.
                oxide_core::diag::best_effort("remove_dir_all", fs::remove_dir_all(&staged_app));
                run_privileged_install(&source_app, &target, &backup_app)?;
            }
            Err(InstallError::Failed(message)) => return Err(message),
        }

        oxide_core::diag::best_effort(
            "touch",
            oxide_core::desktop_tools::resolved_command(helpers::TOUCH)
                .arg(&target)
                .status(),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_waits_for_unsaved_files_and_active_threads() {
        assert!(validate_install(0, 0).is_ok());
        assert!(validate_install(1, 0).unwrap_err().message.contains("Save"));
        assert!(validate_install(0, 1).unwrap_err().message.contains("Stop"));
    }
    #[test]
    fn operations_cannot_overlap_and_errors_release_the_lock() {
        let updates = Updates::default();
        let first = updates.begin().unwrap();
        assert!(updates.begin().is_err());
        drop(first);
        assert!(updates.begin().is_ok());
    }
    #[test]
    fn macos_helpers_detect_bundle_and_escape_paths() {
        assert!(is_gzip(&[0x1f, 0x8b, 0x08]));
        assert!(!is_gzip(b"koly"));
        let bundle = find_app_bundle(std::path::Path::new(
            "/Applications/Oxide.app/Contents/MacOS/Oxide",
        ));
        assert_eq!(
            bundle.as_deref(),
            Some(std::path::Path::new("/Applications/Oxide.app"))
        );
        assert_eq!(
            find_app_bundle(std::path::Path::new("/usr/local/bin/oxide")),
            None
        );
        assert_eq!(
            shell_quote("/Applications/O'Brien.app"),
            "'/Applications/O'\\''Brien.app'"
        );
        assert_eq!(
            applescript_string("echo \"hi\" \\"),
            "\"echo \\\"hi\\\" \\\\\""
        );
    }
    #[test]
    fn helpers_are_absolute_paths() {
        for tool in [
            helpers::HDIUTIL,
            helpers::DITTO,
            helpers::XATTR,
            helpers::OSASCRIPT,
            helpers::TOUCH,
            helpers::MV,
            helpers::RM,
        ] {
            assert!(
                tool.starts_with("/usr/bin/") || tool.starts_with("/bin/"),
                "{tool}"
            );
        }
    }
    #[test]
    fn privileged_script_copies_from_the_image_and_quotes_both_quote_kinds() {
        let target = "/Applications/O'Br\"ien.app";
        let script = privileged_install_script("/mnt/Oxide.app", target, "/b/Oxide.app");
        let quoted = shell_quote(target);
        assert_eq!(quoted, "'/Applications/O'\\''Br\"ien.app'");
        assert!(script.contains(&format!("{} '/mnt/Oxide.app' {quoted}", helpers::DITTO)));
        assert!(!script.contains("stage"));
        // The AppleScript layer escapes every double quote, so none survives unescaped.
        let wrapped = applescript_string(&script);
        let inner = &wrapped[1..wrapped.len() - 1];
        assert!(!inner.replace("\\\\", "").replace("\\\"", "").contains('"'));
    }
    /// Runs the script text with `/bin/sh` and stand-in helpers: `mv` and `rm` are the real
    /// ones (on temp paths), `ditto` and `xattr` are shell functions that succeed or fail.
    #[cfg(unix)]
    fn run_install_script(mv: &str, ditto: &str, xattr: &str) -> (bool, bool, bool) {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Oxide.app");
        let backup = dir.path().join("backup.app");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("marker"), "installed").unwrap();
        let tools = dir.path().join("tools");
        std::fs::create_dir(&tools).unwrap();
        let tool = |name: &str, body: &str| {
            use std::os::unix::fs::PermissionsExt;
            let path = tools.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        };
        let mv = tool("mv", mv);
        let ditto = tool("ditto", ditto);
        let xattr = tool("xattr", xattr);
        let script = install_script_with(
            [&mv, &ditto, &xattr, "/bin/rm"],
            "/nonexistent/source.app",
            &target.to_string_lossy(),
            &backup.to_string_lossy(),
        );
        let ok = oxide_core::desktop_tools::resolved_command("/bin/sh")
            .args(["-c", &script])
            .status()
            .unwrap()
            .success();
        (ok, target.join("marker").exists(), backup.exists())
    }

    #[cfg(unix)]
    const REAL_MV: &str = "/bin/mv \"$@\"";

    #[cfg(unix)]
    #[test]
    fn a_failed_first_move_leaves_the_installed_app_alone() {
        let (ok, installed_survives, _) = run_install_script("exit 1", "exit 0", "exit 0");
        assert!(!ok);
        assert!(installed_survives, "the installed app was deleted");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_puts_the_previous_app_back() {
        let (ok, installed_survives, backup_left) = run_install_script(REAL_MV, "exit 1", "exit 0");
        assert!(!ok);
        assert!(installed_survives, "the previous app was not restored");
        assert!(!backup_left);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_quarantine_removal_puts_the_previous_app_back() {
        let (ok, installed_survives, _) = run_install_script(REAL_MV, "exit 0", "exit 1");
        assert!(!ok);
        assert!(installed_survives);
    }

    #[cfg(unix)]
    #[test]
    fn a_good_install_succeeds_and_keeps_the_backup() {
        // The stand-in ditto creates nothing, so the target is gone and the backup holds the old app.
        let (ok, installed_survives, backup_left) = run_install_script(REAL_MV, "exit 0", "exit 0");
        assert!(ok);
        assert!(!installed_survives);
        assert!(backup_left);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn staging_folders_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = macos_dmg::new_scoped_dir_for_test(&std::env::temp_dir());
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        oxide_core::diag::best_effort("remove_dir_all", std::fs::remove_dir_all(&dir));
        assert_eq!(mode, 0o700);
    }
}
