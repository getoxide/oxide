//! In-app updates (ADR-0021): which feed an install reads, how it was installed, and the update
//! state Core keeps for the window. Core does no network I/O here: the App shell asks the Tauri
//! updater plugin (the only code that downloads or verifies a package) and reports what it found.

use oxide_platform::sync::LockExt as _;
use semver::Version;
use std::sync::Mutex;

/// Stable installs read the `latest.json` of the latest GitHub release. GitHub's "latest" never
/// resolves to a draft or a pre-release. Compiled into every install: changing it strands them.
pub const STABLE_FEED: &str =
    "https://github.com/getoxide/oxide/releases/latest/download/latest.json";
/// Installs whose own version is a pre-release read the newest published release of any kind.
pub const PRERELEASE_FEED: &str = "https://getoxide.github.io/oxide/updates/prerelease.json";
/// How often Oxide asks the feed, after the check at launch.
pub const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);
const RELEASE_PAGE: &str = "https://github.com/getoxide/oxide/releases/tag/";

/// The kind of package the running binary was built into, as Tauri records it in the binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleKind {
    App,
    Nsis,
    AppImage,
    Deb,
    Rpm,
    /// Any other kind (an MSI), which Oxide does not ship.
    Other,
}

/// How this install keeps up to date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallChannel {
    /// macOS app, Windows NSIS installer or Linux AppImage: Oxide installs updates itself.
    InApp,
    /// A `.deb`: updated by APT; Oxide only says a new version exists.
    Apt,
    /// An `.rpm`: updated by DNF; Oxide only says a new version exists.
    Dnf,
    /// A development build, or a binary outside any package: never checks.
    Development,
}

impl InstallChannel {
    /// `bundle` is `None` for a binary Tauri did not package. A debug build is always a
    /// development build: on macOS Tauri reports "app" even for `tauri dev`.
    pub fn detect(bundle: Option<BundleKind>, debug_build: bool) -> Self {
        if debug_build {
            return Self::Development;
        }
        match bundle {
            Some(BundleKind::App | BundleKind::Nsis | BundleKind::AppImage) => Self::InApp,
            Some(BundleKind::Deb) => Self::Apt,
            Some(BundleKind::Rpm) => Self::Dnf,
            Some(BundleKind::Other) | None => Self::Development,
        }
    }

    /// Whether this install asks the feed at all.
    pub fn checks(self) -> bool {
        self != Self::Development
    }

    /// The channel named by the debug override: `in-app`, `apt`, `dnf` or `none`.
    pub fn parse_override(name: &str) -> Option<Self> {
        match name {
            "in-app" => Some(Self::InApp),
            "apt" => Some(Self::Apt),
            "dnf" => Some(Self::Dnf),
            "none" => Some(Self::Development),
            _ => None,
        }
    }
}

/// What a debug build may change about updates, so the flow can be tried against a local feed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DebugOverride {
    pub feed: Option<String>,
    pub channel: Option<InstallChannel>,
}

/// The feed an install of `version` reads: the pre-release feed for a pre-release, else the stable one.
pub fn feed_for(version: &Version) -> &'static str {
    if version.pre.is_empty() {
        STABLE_FEED
    } else {
        PRERELEASE_FEED
    }
}

/// Whether `candidate` is a newer version than `current`; `0.1.0` is newer than `0.1.0-rc.2`.
/// An unreadable version is never newer.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (Version::parse(current), Version::parse(candidate)) {
        (Ok(current), Ok(candidate)) => candidate > current,
        _ => false,
    }
}

/// Where and whether an install checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlan {
    pub channel: InstallChannel,
    pub feed: String,
}

impl UpdatePlan {
    /// `debug_build` must be `cfg!(debug_assertions)` and nothing else: only a debug build
    /// honours `overrides`. A release build reads only the compiled-in feed addresses.
    pub fn resolve(
        version: &Version,
        bundle: Option<BundleKind>,
        debug_build: bool,
        overrides: &DebugOverride,
    ) -> Self {
        let mut channel = InstallChannel::detect(bundle, debug_build);
        let mut feed = feed_for(version).to_string();
        if debug_build {
            if let Some(forced) = overrides.channel {
                channel = forced;
            }
            if let Some(address) = &overrides.feed {
                feed.clone_from(address);
            }
        }
        Self { channel, feed }
    }
}

/// A newer release the feed offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailableUpdate {
    pub version: String,
    /// The release page, built here from the version: the feed's own text is never trusted as a link.
    pub release_notes_url: String,
}

/// What the window shows about updates. The Updates section and the titlebar button read the same state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateState {
    pub channel: InstallChannel,
    pub current_version: String,
    /// Unix seconds of the last check that reached the feed.
    pub last_checked_at: Option<i64>,
    pub available: Option<AvailableUpdate>,
}

pub(crate) struct UpdateTracker {
    state: Mutex<UpdateState>,
}

impl UpdateTracker {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(UpdateState {
                channel: InstallChannel::Development,
                current_version: String::new(),
                last_checked_at: None,
                available: None,
            }),
        }
    }

    pub(crate) fn configure(&self, channel: InstallChannel, current_version: &str) {
        let mut state = self.state.lock_recover();
        state.channel = channel;
        state.current_version = current_version.to_string();
        state.last_checked_at = None;
        state.available = None;
    }

    pub(crate) fn snapshot(&self) -> UpdateState {
        self.state.lock_recover().clone()
    }

    /// Records a check that reached the feed. `found` is the version the feed offers, if any.
    /// Returns the new state when it changed, so the caller pushes it to the window.
    pub(crate) fn record_check(&self, found: Option<&str>, now: i64) -> Option<UpdateState> {
        let mut state = self.state.lock_recover();
        let available = found
            .filter(|version| state.channel.checks() && is_newer(&state.current_version, version))
            .map(|version| AvailableUpdate {
                version: version.to_string(),
                release_notes_url: format!("{RELEASE_PAGE}v{version}"),
            });
        let before = state.clone();
        state.available = available;
        state.last_checked_at = Some(now);
        (*state != before).then(|| state.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn bundle_kind_decides_the_channel() {
        use BundleKind::*;
        for (bundle, channel) in [
            (Some(App), InstallChannel::InApp),
            (Some(Nsis), InstallChannel::InApp),
            (Some(AppImage), InstallChannel::InApp),
            (Some(Deb), InstallChannel::Apt),
            (Some(Rpm), InstallChannel::Dnf),
            (Some(Other), InstallChannel::Development),
            (None, InstallChannel::Development),
        ] {
            assert_eq!(InstallChannel::detect(bundle, false), channel, "{bundle:?}");
        }
    }

    #[test]
    fn a_debug_build_is_a_development_build_even_inside_an_app_bundle() {
        assert_eq!(
            InstallChannel::detect(Some(BundleKind::App), true),
            InstallChannel::Development
        );
        assert!(!InstallChannel::Development.checks());
        assert!(InstallChannel::Apt.checks());
    }

    #[test]
    fn stable_installs_never_read_the_prerelease_feed() {
        for version in ["0.1.0", "1.0.0", "2.3.4+build5"] {
            assert_eq!(feed_for(&v(version)), STABLE_FEED, "{version}");
        }
    }

    #[test]
    fn prerelease_installs_read_the_prerelease_feed() {
        for version in ["0.1.0-rc.1", "1.0.0-beta", "0.2.0-rc.10"] {
            assert_eq!(feed_for(&v(version)), PRERELEASE_FEED, "{version}");
        }
    }

    #[test]
    fn the_feed_addresses_are_the_published_ones() {
        assert_eq!(
            STABLE_FEED,
            "https://github.com/getoxide/oxide/releases/latest/download/latest.json"
        );
        assert_eq!(
            PRERELEASE_FEED,
            "https://getoxide.github.io/oxide/updates/prerelease.json"
        );
    }

    #[test]
    fn versions_compare_by_semver() {
        assert!(is_newer("0.1.0", "0.1.1"));
        assert!(is_newer("0.1.0-rc.2", "0.1.0"));
        assert!(is_newer("0.1.0-rc.2", "0.1.0-rc.10"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0-rc.3"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(!is_newer("0.1.0", "not a version"));
    }

    #[test]
    fn only_a_debug_build_honours_the_override() {
        let overrides = DebugOverride {
            feed: Some("http://127.0.0.1:9/latest.json".into()),
            channel: Some(InstallChannel::InApp),
        };
        let debug = UpdatePlan::resolve(&v("0.1.0"), None, true, &overrides);
        assert_eq!(debug.channel, InstallChannel::InApp);
        assert_eq!(debug.feed, "http://127.0.0.1:9/latest.json");

        let release = UpdatePlan::resolve(&v("0.1.0"), Some(BundleKind::Deb), false, &overrides);
        assert_eq!(release.channel, InstallChannel::Apt);
        assert_eq!(release.feed, STABLE_FEED);
        let release = UpdatePlan::resolve(&v("0.1.0-rc.1"), None, false, &overrides);
        assert_eq!(release.channel, InstallChannel::Development);
        assert_eq!(release.feed, PRERELEASE_FEED);
    }

    #[test]
    fn a_debug_build_without_an_override_never_checks() {
        let plan = UpdatePlan::resolve(
            &v("0.1.0"),
            Some(BundleKind::App),
            true,
            &DebugOverride::default(),
        );
        assert!(!plan.channel.checks());
    }

    #[test]
    fn the_override_channel_names() {
        assert_eq!(
            InstallChannel::parse_override("in-app"),
            Some(InstallChannel::InApp)
        );
        assert_eq!(
            InstallChannel::parse_override("none"),
            Some(InstallChannel::Development)
        );
        assert_eq!(InstallChannel::parse_override("bogus"), None);
    }

    fn tracker(current: &str, channel: InstallChannel) -> UpdateTracker {
        let tracker = UpdateTracker::new();
        tracker.configure(channel, current);
        tracker
    }

    #[test]
    fn a_newer_version_in_the_feed_becomes_available_with_its_release_page() {
        let tracker = tracker("0.1.0", InstallChannel::InApp);
        let state = tracker.record_check(Some("0.2.0"), 100).unwrap();
        assert_eq!(state.last_checked_at, Some(100));
        assert_eq!(
            state.available,
            Some(AvailableUpdate {
                version: "0.2.0".into(),
                release_notes_url: "https://github.com/getoxide/oxide/releases/tag/v0.2.0".into(),
            })
        );
        assert_eq!(tracker.snapshot(), state);
    }

    #[test]
    fn the_same_or_an_older_version_offers_nothing() {
        let tracker = tracker("0.2.0", InstallChannel::InApp);
        tracker.record_check(None, 1);
        assert!(
            tracker.record_check(Some("0.2.0"), 2).is_some(),
            "the check time moved"
        );
        assert_eq!(tracker.snapshot().available, None);
        tracker.record_check(Some("0.1.0"), 3);
        assert_eq!(tracker.snapshot().available, None);
    }

    #[test]
    fn a_repeated_check_with_the_same_result_changes_nothing_once_the_time_is_the_same() {
        let tracker = tracker("0.1.0", InstallChannel::InApp);
        assert!(tracker.record_check(Some("0.2.0"), 100).is_some());
        assert!(tracker.record_check(Some("0.2.0"), 100).is_none());
    }

    #[test]
    fn a_development_build_never_shows_an_update() {
        let tracker = tracker("0.1.0", InstallChannel::Development);
        tracker.record_check(Some("0.2.0"), 1);
        assert_eq!(tracker.snapshot().available, None);
    }

    #[test]
    fn a_package_install_still_learns_of_a_new_version() {
        let tracker = tracker("0.1.0", InstallChannel::Apt);
        tracker.record_check(Some("0.2.0"), 1);
        assert_eq!(
            tracker.snapshot().available.map(|update| update.version),
            Some("0.2.0".into())
        );
    }
}
