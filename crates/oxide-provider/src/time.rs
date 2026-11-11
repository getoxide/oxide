//! Time helpers shared by the Provider adapters and Core's usage poller.

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
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

#[cfg(test)]
mod tests {
    use super::parse_rfc3339;

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
}
