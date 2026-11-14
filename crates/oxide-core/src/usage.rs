//! Usage limits per Provider. A Usage limit belongs to the Provider's account, not to a Thread, so
//! every Thread of a Provider feeds and reads the same snapshot. Reports are merged window by
//! window and the latest snapshot is persisted so the ring has a value after a restart.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use oxide_provider::time::now_unix;
use oxide_provider::{UsageStatus, UsageWindow, UsageWindowKind};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One window of a Provider's Usage limits, with the time Oxide last heard about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    /// Share used, 0 to 100; `None` when the Provider reported a status without a figure.
    pub percent_used: Option<f64>,
    /// When the window resets, seconds since the Unix epoch (UTC).
    pub resets_at: Option<i64>,
    pub status: UsageStatus,
    /// When Oxide received this report, seconds since the Unix epoch (UTC).
    pub reported_at: i64,
}

/// Detailed Usage limits for a specific pool / model category.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePoolLimits {
    pub label: String,
    pub five_hour: Option<UsageLimitWindow>,
    pub weekly: Option<UsageLimitWindow>,
}

fn pool_label(key: &str) -> String {
    match key {
        "gemini" => "Gemini",
        "gemini-argon" => "Gemini Argon",
        "third-party" => "Third-party (Claude, GPT)",
        "sonnet" => "Claude Sonnet",
        "opus" => "Claude Opus",
        "haiku" => "Claude Haiku",
        "default" => "Default",
        other => other,
    }
    .to_string()
}

/// The latest 5-hour and weekly Usage limits of one Provider, including pool breakdowns.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub five_hour: Option<UsageLimitWindow>,
    pub weekly: Option<UsageLimitWindow>,
    #[serde(default)]
    pub pools: HashMap<String, UsagePoolLimits>,
}

impl UsageLimits {
    fn merge(&mut self, windows: &[UsageWindow], reported_at: i64) {
        for w in windows {
            if let Some(pool_key) = &w.pool {
                let pool = self
                    .pools
                    .entry(pool_key.clone())
                    .or_insert_with(|| UsagePoolLimits {
                        label: pool_label(pool_key),
                        five_hour: None,
                        weekly: None,
                    });
                let slot = match w.kind {
                    UsageWindowKind::FiveHour => &mut pool.five_hour,
                    UsageWindowKind::Weekly => &mut pool.weekly,
                };
                let previous = slot.take();
                *slot = Some(UsageLimitWindow {
                    percent_used: w
                        .percent_used
                        .or_else(|| previous.as_ref().and_then(|p| p.percent_used)),
                    resets_at: w
                        .resets_at
                        .or_else(|| previous.as_ref().and_then(|p| p.resets_at)),
                    status: w.status,
                    reported_at,
                });
            } else {
                let slot = match w.kind {
                    UsageWindowKind::FiveHour => &mut self.five_hour,
                    UsageWindowKind::Weekly => &mut self.weekly,
                };
                let previous = slot.take();
                *slot = Some(UsageLimitWindow {
                    percent_used: w
                        .percent_used
                        .or_else(|| previous.as_ref().and_then(|p| p.percent_used)),
                    resets_at: w
                        .resets_at
                        .or_else(|| previous.as_ref().and_then(|p| p.resets_at)),
                    status: w.status,
                    reported_at,
                });
            }
        }
    }
}

/// What a Thread actor shares with the rest of Core: its status feed, the Usage limits of its
/// Provider, and the Project Services it can detach agent commands into.
pub struct ActorServices {
    pub activity: std::sync::Arc<crate::activity::Activity>,
    pub usage: std::sync::Arc<UsageHub>,
    /// The Provider key Usage limits are filed under.
    pub provider: String,
    /// The Project the Thread belongs to, recorded on a Project Service.
    pub project_id: u32,
    /// The Project Services a detached agent command is started in.
    pub project_services: std::sync::Arc<crate::project_services::ProjectServices>,
    /// The process registry a Project Service registers its process group with.
    pub processes: std::sync::Arc<oxide_provider::process::ProcessRegistry>,
}

pub struct UsageHub {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
    limits: Mutex<HashMap<String, UsageLimits>>,
    subscribers: Mutex<Vec<(String, crossbeam_channel::Sender<UsageLimits>)>>,
}

/// Antigravity is `agy` to its CLI and `antigravity` to Oxide's UI; both name one store entry.
fn canonical(provider: &str) -> &str {
    if provider == "agy" {
        "antigravity"
    } else {
        provider
    }
}

fn state_key(provider: &str) -> String {
    format!("usage_limits:{provider}")
}

impl UsageHub {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        let conn = Mutex::new(None);
        let limits = load_all(&db_path, &conn).unwrap_or_default();
        Self {
            db_path,
            conn,
            limits: Mutex::new(limits),
            subscribers: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn get(&self, provider: &str) -> Option<UsageLimits> {
        let provider = canonical(provider);
        self.limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(provider)
            .cloned()
    }

    /// The current snapshot and a channel of the snapshots that follow.
    pub(crate) fn subscribe(
        &self,
        provider: &str,
    ) -> (
        Option<UsageLimits>,
        crossbeam_channel::Receiver<UsageLimits>,
    ) {
        let provider = canonical(provider);
        let (tx, rx) = crossbeam_channel::unbounded();
        // Registering under the limits lock keeps a concurrent report from slipping between
        // the snapshot and the subscription.
        let limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((provider.to_string(), tx));
        (limits.get(provider).cloned(), rx)
    }

    /// Merges a Provider's report into its snapshot, persists it and tells subscribers.
    pub(crate) fn report(&self, provider: &str, windows: &[UsageWindow]) {
        if windows.is_empty() {
            return;
        }
        let provider = canonical(provider);
        let snapshot = {
            let mut limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
            let entry = limits.entry(provider.to_string()).or_default();
            entry.merge(windows, now_unix());
            entry.clone()
        };
        self.persist(provider, &snapshot);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(p, tx)| p != provider || tx.send(snapshot.clone()).is_ok());
    }

    fn persist(&self, provider: &str, snapshot: &UsageLimits) {
        let Ok(value) = serde_json::to_string(snapshot) else {
            return;
        };
        let _ = crate::db::with_conn(&self.db_path, &self.conn, |conn| {
            conn.execute(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [state_key(provider), value],
            )?;
            Ok(())
        });
    }
}

fn load_all(
    db_path: &std::path::Path,
    conn_slot: &Mutex<Option<Connection>>,
) -> crate::Result<HashMap<String, UsageLimits>> {
    crate::db::with_conn(db_path, conn_slot, |conn| {
        let mut stmt =
            conn.prepare("SELECT key, value FROM app_state WHERE key LIKE 'usage_limits:%'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(key, value)| {
                let provider = canonical(key.strip_prefix("usage_limits:")?).to_string();
                Some((provider, serde_json::from_str(&value).ok()?))
            })
            .collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxide_provider::UsageWindowKind;

    #[test]
    fn agy_reports_reach_antigravity_subscribers() {
        let dir = tempfile::tempdir().unwrap();
        let hub = UsageHub::new(dir.path().join("none.db"));
        let (_, rx) = hub.subscribe("antigravity");
        hub.report(
            "agy",
            &[UsageWindow {
                kind: UsageWindowKind::Weekly,
                percent_used: Some(20.0),
                resets_at: None,
                status: UsageStatus::Ok,
                pool: None,
            }],
        );
        assert!(rx.try_recv().is_ok());
        assert!(hub.get("antigravity").is_some());
    }

    #[test]
    fn usage_hub_reuses_busy_timeout_connection_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("oxide.db");
        drop(crate::db::open(&db_path, crate::MIGRATIONS).unwrap());

        let hub = UsageHub::new(db_path.clone());
        let timeout: i64 = crate::db::with_conn(&hub.db_path, &hub.conn, |conn| {
            Ok(conn.pragma_query_value(None, "busy_timeout", |r| r.get(0))?)
        })
        .unwrap();
        assert_eq!(timeout, 5000);

        hub.report(
            "claude",
            &[UsageWindow {
                kind: UsageWindowKind::FiveHour,
                percent_used: Some(33.0),
                resets_at: None,
                status: UsageStatus::Ok,
                pool: None,
            }],
        );
        drop(hub);

        let reopened = UsageHub::new(db_path);
        assert_eq!(
            reopened
                .get("claude")
                .and_then(|l| l.five_hour)
                .and_then(|w| w.percent_used),
            Some(33.0)
        );
    }
}
