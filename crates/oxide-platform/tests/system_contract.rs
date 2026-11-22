//! Contract tests for `oxide_platform::system`: they run unchanged on macOS, Linux and Windows
//! (ADR-0019).

use std::collections::HashSet;

#[test]
fn system_fonts_returns_sorted_deduplicated_non_empty_names() {
    let fonts = oxide_platform::system::system_fonts();
    let mut seen = HashSet::new();
    for font in &fonts {
        assert!(!font.is_empty(), "font name must not be empty");
        assert_eq!(font, font.trim(), "font name `{font}` must be trimmed");
        assert!(
            !font.starts_with('@'),
            "vertical GDI font `{font}` must be filtered out"
        );
        assert!(seen.insert(font.clone()), "duplicate font `{font}`");
    }
    let mut expected = fonts.clone();
    expected.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    assert_eq!(fonts, expected, "fonts must be sorted case-insensitively");
}
