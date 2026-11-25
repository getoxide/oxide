//! Installs the fake `gh` fixture into a directory. Shared by the crate's unit tests
//! (`src/lib.rs`) and its integration tests (`tests/*.rs`) through `#[path]`, so every test
//! puts the same files beside each other.

use std::path::Path;

/// Copies the fake `gh` (with its Windows launcher) into `dir` and writes its `state.json`.
pub fn install(dir: &Path, state: &serde_json::Value) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/gh");
    for name in ["gh", "gh.py", "gh.cmd"] {
        std::fs::copy(fixture.join(name), dir.join(name)).unwrap();
    }
    std::fs::write(dir.join("state.json"), state.to_string()).unwrap();
}
