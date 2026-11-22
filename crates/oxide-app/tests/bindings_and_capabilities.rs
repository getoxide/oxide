#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration tests: a failed unwrap or panic is a test failure"
)]
#[test]
fn bindings_are_up_to_date() {
    // Regenerates the file; CI fails on `git diff --exit-code` if it was stale.
    oxide_app_lib::export_bindings().unwrap();
    let ts = std::fs::read_to_string(oxide_app_lib::BINDINGS_PATH).unwrap();
    assert!(
        ts.contains("listProjects")
            && ts.contains("startBlockTerminal")
            && ts.contains("systemFonts")
    );
    // Oxide is Projects and plain Terminals (ADR-0018): none of it may be exported.
    for gone in [
        "createThread",
        "subscribeThread",
        "sendPrompt",
        "listTurns",
        "saveSettings",
        "getSettings",
        "startProjectService",
        "startBlindReview",
        "restoreTurn",
        "checkForAppUpdate",
    ] {
        assert!(!ts.contains(gone), "`{gone}` is still exported");
    }
    assert!(
        !ts.contains("start_terminal") && !ts.contains("startTerminal"),
        "legacy non-block start_terminal command must not be exported"
    );
}

#[test]
fn webview_capabilities_grant_no_filesystem_or_shell_access() {
    let raw = std::fs::read_to_string("capabilities/default.json").unwrap();
    let cap: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for p in cap["permissions"].as_array().unwrap() {
        let p = p.as_str().unwrap();
        for denied in ["fs", "shell", "opener", "process", "http"] {
            assert!(
                !p.contains(denied),
                "capability `{p}` grants `{denied}` access"
            );
        }
        if p.starts_with("dialog:") {
            assert_eq!(p, "dialog:allow-open", "unexpected dialog capability `{p}`");
        }
    }
    assert!(
        cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "dialog:allow-open")
    );
    assert!(
        cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "core:window:allow-is-maximized"),
        "default capability must grant core:window:allow-is-maximized for Windows titlebar sync"
    );
}
