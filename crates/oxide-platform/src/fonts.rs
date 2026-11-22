//! Shared helpers for normalizing and bounding system font family enumeration.

use crate::bounded_lines::{BoundedLines, LOG_LINE_CAP};
use crate::diag;
use std::io::BufReader;
use std::process::{Command, Stdio};

/// Maximum number of lines read from a font enumeration helper process (ADR-0016).
#[allow(
    dead_code,
    reason = "used by macOS and Linux system_fonts implementations"
)]
const MAX_FONT_LINES: usize = 16_384;

/// Trims, filters empty and vertical (`@`-prefixed) font names, sorts case-insensitively, and
/// deduplicates.
pub fn normalize_font_families(raw: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut families: Vec<String> = raw
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && !name.starts_with('@'))
        .collect();
    families.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    families.dedup();
    families
}

/// Runs `command` with bounded stdout reading and parses font family names from its lines.
#[allow(
    dead_code,
    reason = "used by macOS and Linux system_fonts implementations"
)]
pub fn run_bounded_font_command(
    mut command: Command,
    mut parse_lines: impl FnMut(Box<dyn Iterator<Item = String> + '_>) -> Vec<String>,
) -> Vec<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            diag::best_effort("system_fonts spawn", Err::<(), _>(error));
            return Vec::new();
        }
    };
    let Some(stdout) = child.stdout.take() else {
        diag::best_effort("system_fonts wait", child.wait());
        return Vec::new();
    };
    let lines = BoundedLines::new(BufReader::new(stdout), LOG_LINE_CAP)
        .take(MAX_FONT_LINES)
        .map_while(|line| match line {
            Ok(line) => Some(line),
            Err(error) => {
                diag::best_effort("system_fonts read", Err::<(), _>(error));
                None
            }
        });
    let collected = parse_lines(Box::new(lines));
    diag::best_effort("system_fonts wait", child.wait());
    normalize_font_families(collected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_filters_sorts_and_dedups() {
        let input = vec![
            "  Inter ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "@MS Gothic".to_string(),
            "arial".to_string(),
            "Arial".to_string(),
            "Inter".to_string(),
            "JetBrains Mono".to_string(),
        ];
        assert_eq!(
            normalize_font_families(input),
            vec!["Arial", "arial", "Inter", "JetBrains Mono"]
        );
    }
}
