use oxide_provider::{ProviderEvent, UsageStatus, UsageWindow, UsageWindowKind};
use serde_json::json;

fn windows(event: Option<ProviderEvent>) -> Vec<UsageWindow> {
    match event {
        Some(ProviderEvent::UsageLimits { windows }) => windows,
        other => panic!("expected UsageLimits, got {other:?}"),
    }
}

#[test]
fn claude_five_hour_event_with_utilization() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "resetsAt": 1_800_000_000,
            "rateLimitType": "five_hour",
            "utilization": 0.42
        }
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].kind, UsageWindowKind::FiveHour);
    assert!((w[0].percent_used.unwrap() - 42.0).abs() < 1e-9);
    assert_eq!(w[0].resets_at, Some(1_800_000_000));
    assert_eq!(w[0].status, UsageStatus::Ok);
}

#[test]
fn claude_missing_utilization_stays_unknown() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {"status": "allowed_warning", "resetsAt": 5, "rateLimitType": "seven_day"}
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w[0].kind, UsageWindowKind::Weekly);
    assert_eq!(w[0].percent_used, None);
    assert_eq!(w[0].status, UsageStatus::Warning);
}

#[test]
fn claude_rejected_status_is_limited() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour"}
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w[0].status, UsageStatus::Limited);
    assert_eq!(w[0].resets_at, None);
}

#[test]
fn claude_model_specific_windows_are_tagged_with_pool() {
    let sonnet = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "resetsAt": 1_800_000_000,
            "rateLimitType": "seven_day_sonnet",
            "utilization": 0.55
        }
    });
    let w_sonnet = windows(oxide_provider::claude::parse_rate_limit_event(&sonnet));
    assert_eq!(w_sonnet.len(), 1);
    assert_eq!(w_sonnet[0].kind, UsageWindowKind::Weekly);
    assert_eq!(w_sonnet[0].pool, Some("sonnet".to_string()));
    assert!((w_sonnet[0].percent_used.unwrap() - 55.0).abs() < 1e-9);

    let opus = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed_warning",
            "resetsAt": 1_800_000_000,
            "rateLimitType": "seven_day_opus",
            "utilization": 0.85
        }
    });
    let w_opus = windows(oxide_provider::claude::parse_rate_limit_event(&opus));
    assert_eq!(w_opus.len(), 1);
    assert_eq!(w_opus[0].kind, UsageWindowKind::Weekly);
    assert_eq!(w_opus[0].pool, Some("opus".to_string()));
    assert_eq!(w_opus[0].status, UsageStatus::Warning);
}

#[test]
fn claude_other_window_types_are_dropped() {
    for kind in ["seven_day_overage_included", "overage", "mystery"] {
        let line = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "allowed", "rateLimitType": kind, "utilization": 0.9}
        });
        assert_eq!(
            oxide_provider::claude::parse_rate_limit_event(&line),
            None,
            "{kind}"
        );
    }
}

#[test]
fn claude_malformed_event_yields_nothing() {
    assert_eq!(
        oxide_provider::claude::parse_rate_limit_event(&json!({"type": "rate_limit_event"})),
        None
    );
}

#[test]
fn codex_classifies_windows_by_duration_not_position() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 61, "windowDurationMins": 10080, "resetsAt": 200},
        "secondary": {"usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 100}
    }});
    let w = windows(oxide_provider::codex::parse_rate_limits(&params));
    let five = w
        .iter()
        .find(|w| w.kind == UsageWindowKind::FiveHour)
        .unwrap();
    let week = w
        .iter()
        .find(|w| w.kind == UsageWindowKind::Weekly)
        .unwrap();
    assert_eq!(five.percent_used, Some(12.5));
    assert_eq!(five.resets_at, Some(100));
    assert_eq!(week.percent_used, Some(61.0));
    assert_eq!(week.resets_at, Some(200));
    assert_eq!(five.status, UsageStatus::Ok);
}

#[test]
fn codex_status_follows_percent() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 85, "windowDurationMins": 300},
        "secondary": {"usedPercent": 100, "windowDurationMins": 10080}
    }});
    let w = windows(oxide_provider::codex::parse_rate_limits(&params));
    assert_eq!(w[0].status, UsageStatus::Warning);
    assert_eq!(w[1].status, UsageStatus::Limited);
}

#[test]
fn codex_unknown_durations_and_null_windows_are_dropped() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 10, "windowDurationMins": 60},
        "secondary": null
    }});
    assert_eq!(oxide_provider::codex::parse_rate_limits(&params), None);
    assert_eq!(oxide_provider::codex::parse_rate_limits(&json!({})), None);
}

fn agy_windows(payload: &serde_json::Value) -> Vec<UsageWindow> {
    windows(oxide_provider::agy::parse_statusline_quota(payload, 1_000))
}

#[test]
fn agy_gemini_model_reports_the_gemini_pool() {
    let payload = json!({
        "model": {"id": "Gemini 3.8 Flash (High)", "display_name": "Gemini 3.8 Flash (High)"},
        "quota": {
            "gemini-5h": {"remaining_fraction": 0.75, "reset_time": "2026-11-11T12:00:00Z"},
            "gemini-weekly": {"remaining_fraction": 0.55, "reset_in_seconds": 3600},
            "3p-5h": {"remaining_fraction": 0.1},
            "3p-weekly": {"remaining_fraction": 0.1}
        }
    });
    let w = agy_windows(&payload);
    let primary: Vec<_> = w.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(primary.len(), 2);
    assert_eq!(primary[0].kind, UsageWindowKind::FiveHour);
    assert!((primary[0].percent_used.unwrap() - 25.0).abs() < 1e-9);
    assert_eq!(primary[0].resets_at, Some(1_794_398_400));
    assert_eq!(primary[0].status, UsageStatus::Ok);
    assert_eq!(primary[1].kind, UsageWindowKind::Weekly);
    assert!((primary[1].percent_used.unwrap() - 45.0).abs() < 1e-9);
    assert_eq!(primary[1].resets_at, Some(4_600));

    // Both Gemini and ThirdParty pools are preserved for the detailed breakdown
    let gemini_pool: Vec<_> = w
        .iter()
        .filter(|win| win.pool.as_deref() == Some("gemini"))
        .collect();
    assert_eq!(gemini_pool.len(), 2);
    let tp_pool: Vec<_> = w
        .iter()
        .filter(|win| win.pool.as_deref() == Some("third-party"))
        .collect();
    assert_eq!(tp_pool.len(), 2);
}

#[test]
fn agy_third_party_model_reports_the_third_party_pool() {
    let payload = json!({
        "model": {"id": "Claude Sonnet 4.6", "display_name": "Claude Sonnet 4.6"},
        "quota": {
            "gemini-5h": {"remaining_fraction": 0.0, "reset_in_seconds": 100},
            "gemini-weekly": {"remaining_fraction": 0.0, "reset_in_seconds": 100},
            "3p-5h": {"remaining_fraction": 0.8, "reset_in_seconds": 5000},
            "3p-weekly": {"remaining_fraction": 0.6, "reset_in_seconds": 90000}
        }
    });
    let w = agy_windows(&payload);
    let primary: Vec<_> = w.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(primary.len(), 2);
    assert!((primary[0].percent_used.unwrap() - 20.0).abs() < 1e-9);
    assert_eq!(primary[0].resets_at, Some(6_000));
    assert!((primary[1].percent_used.unwrap() - 40.0).abs() < 1e-9);
    assert_eq!(primary[1].resets_at, Some(91_000));
}

#[test]
fn agy_argon_model_prefers_its_own_weekly_bucket() {
    let payload = json!({
        "model": {"id": "Gemini 4 Argon (High)"},
        "quota": {
            "gemini-5h": {"remaining_fraction": 1.0},
            "gemini-weekly": {"remaining_fraction": 0.9},
            "gemini-argon-wtu-weekly": {"remaining_fraction": 0.5, "reset_in_seconds": 60},
            "3p-5h": {"remaining_fraction": 0.0},
            "3p-weekly": {"remaining_fraction": 0.0}
        }
    });
    let w = agy_windows(&payload);
    let primary: Vec<_> = w.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(primary.len(), 2);
    assert_eq!(primary[0].percent_used, Some(0.0));
    assert!((primary[1].percent_used.unwrap() - 50.0).abs() < 1e-9);
    assert_eq!(primary[1].resets_at, Some(1_060));

    let argon_pool: Vec<_> = w
        .iter()
        .filter(|win| win.pool.as_deref() == Some("gemini-argon"))
        .collect();
    assert_eq!(argon_pool.len(), 2);
}

#[test]
fn agy_accepts_remaining_percent_and_skips_disabled_buckets() {
    let percent = agy_windows(&json!({
        "model": {"id": "Gemini 3.8 Flash"},
        "quota": {"gemini-5h": {"remaining_percent": 40.0}}
    }));
    let primary: Vec<_> = percent.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(primary.len(), 1);
    assert!((primary[0].percent_used.unwrap() - 60.0).abs() < 1e-9);

    let disabled = agy_windows(&json!({
        "model": {"id": "Gemini 3.8 Flash"},
        "quota": {
            "gemini-5h": {"remaining_fraction": 0.1, "disabled": true},
            "gemini-weekly": {"remaining_fraction": 0.9}
        }
    }));
    let disabled_primary: Vec<_> = disabled.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(disabled_primary.len(), 1);
    assert_eq!(disabled_primary[0].kind, UsageWindowKind::Weekly);
}

#[test]
fn agy_exhausted_bucket_is_limited() {
    let w = agy_windows(&json!({
        "model": {"id": "Gemini 3.8 Flash"},
        "quota": {"gemini-5h": {"remaining_fraction": 0.0}}
    }));
    let primary: Vec<_> = w.iter().filter(|win| win.pool.is_none()).collect();
    assert_eq!(primary[0].percent_used, Some(100.0));
    assert_eq!(primary[0].status, UsageStatus::Limited);
}

#[test]
fn agy_unknown_model_does_not_mix_pools() {
    let ambiguous = json!({
        "model": {"id": "Future Model XYZ"},
        "quota": {
            "gemini-5h": {"remaining_fraction": 0.9},
            "3p-5h": {"remaining_fraction": 0.3}
        }
    });
    assert_eq!(
        oxide_provider::agy::parse_statusline_quota(&ambiguous, 0),
        None
    );

    let unambiguous = agy_windows(&json!({
        "quota": {"3p-5h": {"remaining_fraction": 0.3}}
    }));
    let primary: Vec<_> = unambiguous
        .iter()
        .filter(|win| win.pool.is_none())
        .collect();
    assert_eq!(primary.len(), 1);
    assert_eq!(primary[0].kind, UsageWindowKind::FiveHour);
}

#[test]
fn agy_payload_without_quota_or_windows_yields_nothing() {
    assert_eq!(
        oxide_provider::agy::parse_statusline_quota(&json!({"model": {"id": "Gemini"}}), 0),
        None
    );
    assert_eq!(
        oxide_provider::agy::parse_statusline_quota(
            &json!({"quota": {"gemini-5h": {"remaining_fraction": "half"}}}),
            0
        ),
        None
    );
}
