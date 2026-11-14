//! Time helpers shared by the Provider adapters and Core's usage poller.

use std::time::{SystemTime, UNIX_EPOCH};

/// Current UTC Unix timestamp in seconds.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Days since 1970-01-01 from a proleptic Gregorian civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days since 1970-01-01 to a civil `(year, month, day)` date (Howard Hinnant's algorithm).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (year + i64::from(month <= 2), month, day)
}

/// Formats a UTC Unix timestamp (`secs`, `millis`) as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn format_rfc3339_millis(secs: u64, millis: u32) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60,
        millis
    )
}

/// Current UTC timestamp formatted as RFC 3339 with millisecond precision.
pub fn now_rfc3339() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_rfc3339_millis(elapsed.as_secs(), elapsed.subsec_millis())
}

/// RFC 3339 UTC timestamp (`2026-01-02T03:04:05[.fff]Z` or `+00:00`) to Unix seconds.
///
/// Provider payloads report quota resets in this shape; a malformed or absent timestamp yields
/// `None` so callers can leave the reset unknown instead of inventing one.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    let mut t = time.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (t.next()??, t.next()??, t.next().flatten().unwrap_or(0));
    let tail = &rest[time.len()..];
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match tail.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let (oh, om) = tail[1..].split_once(':').unwrap_or((&tail[1..], "0"));
            let secs = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
            if sign == '+' { secs } else { -secs }
        }
        _ => 0,
    };
    let days = days_from_civil(y, m, day);
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, format_rfc3339_millis, now_rfc3339, now_unix, parse_rfc3339};

    #[test]
    fn reads_utc_and_offset_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-02T00:00:00Z"), Some(86_400));
        assert_eq!(parse_rfc3339("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00.123Z"), Some(0));
    }

    #[test]
    fn rejects_a_malformed_timestamp() {
        assert_eq!(parse_rfc3339("tomorrow"), None);
    }

    #[test]
    fn converts_days_and_formats_rfc3339_utc() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
        // 2024-02-29 is a leap day (19,782 days since 1970-01-01).
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(
            format_rfc3339_millis(86_400 + 3 * 3_600 + 4 * 60 + 5, 42),
            "1970-01-02T03:04:05.042Z"
        );
        let now_str = now_rfc3339();
        assert!(parse_rfc3339(&now_str).is_some(), "{now_str}");
        assert!(now_unix() > 0);
    }
}
