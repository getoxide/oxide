#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
//! The feed and channel override must not exist in a release build (ADR-0016, ADR-0021). A release
//! build is not run by the tests, so they pin the shape that makes it impossible: the only code
//! that reads the override variables is compiled out unless `debug_assertions` is on, and the only
//! caller of the resolver tells it whether this is a debug build from `cfg!(debug_assertions)`.

use std::fs;
use std::path::Path;

const VARIABLES: [&str; 2] = ["OXIDE_UPDATE_FEED", "OXIDE_UPDATE_CHANNEL"];

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The text between `mod debug_override {` and its closing brace at column 0.
fn debug_module(text: &str) -> (usize, usize) {
    let start = text
        .find("mod debug_override {")
        .expect("the debug override module");
    let end = start + text[start..].find("\n}\n").expect("the end of the module");
    (start, end)
}

#[test]
fn only_a_module_compiled_out_of_release_builds_reads_the_override_variables() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let updates = fs::read_to_string(root.join("src/updates.rs")).unwrap();
    let (start, end) = debug_module(&updates);
    let before = updates[..start].trim_end();
    assert!(
        before.ends_with("#[cfg(debug_assertions)]"),
        "the module must be gated by #[cfg(debug_assertions)] alone"
    );
    for variable in VARIABLES {
        assert!(
            updates[start..end].contains(variable),
            "{variable} is read in the module"
        );
    }

    let mut files = Vec::new();
    sources(&root.join("src"), &mut files);
    sources(&root.join("../oxide-core/src"), &mut files);
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        let outside = if file.ends_with("src/updates.rs") && file.starts_with(root) {
            format!("{}{}", &text[..start], &text[end..])
        } else {
            text
        };
        for variable in VARIABLES {
            assert!(
                !outside.contains(variable),
                "{variable} appears outside the debug-only module, in {}",
                file.display()
            );
        }
    }
}

#[test]
fn the_resolver_is_told_a_build_is_debug_only_by_cfg() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let updates = fs::read_to_string(root.join("src/updates.rs")).unwrap();
    let call = updates
        .find("UpdatePlan::resolve(")
        .expect("the call to the resolver");
    let line_end = updates[call..].find(';').unwrap();
    assert!(
        updates[call..call + line_end].contains("cfg!(debug_assertions)"),
        "UpdatePlan::resolve must be given cfg!(debug_assertions)"
    );
    assert_eq!(
        updates.matches("UpdatePlan::resolve(").count(),
        1,
        "one call site"
    );
}
