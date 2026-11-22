#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::disallowed_methods,
    reason = "integration tests: a failed unwrap or panic is a test failure; mock System uses a plain mutex"
)]

use oxide_core::{Core, System};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct RecordingSystem {
    revealed: Mutex<Vec<PathBuf>>,
}

impl RecordingSystem {
    fn new() -> Self {
        Self {
            revealed: Mutex::new(Vec::new()),
        }
    }
}

impl System for RecordingSystem {
    fn reveal_in_finder(&self, path: &Path) {
        self.revealed.lock().unwrap().push(path.to_path_buf());
    }
}

fn valid_custom_theme(name: &str) -> String {
    serde_json::json!({
        "name": name,
        "author": "Test",
        "themes": [{
            "name": name,
            "appearance": "dark",
            "style": {
                "background": "#101218",
                "text": "#EAECEF",
                "terminal.background": "#101218"
            }
        }]
    })
    .to_string()
}

#[test]
fn opening_core_seeds_builtin_themes_in_themes_dir() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    let core = Core::open(&home).unwrap();

    let dark_path = home.join("themes").join("oxide-dark.json");
    let light_path = home.join("themes").join("oxide-light.json");
    assert!(dark_path.is_file(), "oxide-dark.json should be seeded");
    assert!(light_path.is_file(), "oxide-light.json should be seeded");

    let themes = core.list_themes().unwrap();
    assert_eq!(themes.len(), 2);
    assert_eq!(themes[0].id, "oxide-dark");
    assert!(themes[0].builtin);
    assert!(themes[0].error.is_none());
    assert!(themes[0].json.is_some());

    assert_eq!(themes[1].id, "oxide-light");
    assert!(themes[1].builtin);
    assert!(themes[1].error.is_none());
    assert!(themes[1].json.is_some());

    let dark_json: serde_json::Value =
        serde_json::from_str(themes[0].json.as_deref().unwrap()).unwrap();
    let dark_style = &dark_json["themes"][0]["style"];
    for key in [
        "background",
        "title_bar.background",
        "sidebar.background",
        "surfaces.background",
        "tab_bar.background",
        "editor.background",
        "terminal.background",
        "terminal.block.border",
        "terminal.ansi.black",
        "terminal.ansi.bright_white",
        "syntax",
    ] {
        assert!(
            !dark_style[key].is_null(),
            "missing token `{key}` in oxide-dark"
        );
    }
}

#[test]
fn save_list_and_delete_custom_theme_round_trips() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    let core = Core::open(&home).unwrap();

    let json = valid_custom_theme("Ocean Breeze");
    let saved = core.save_theme("ocean-breeze", &json).unwrap();
    assert_eq!(saved.id, "ocean-breeze");
    assert_eq!(saved.name, "Ocean Breeze");
    assert!(!saved.builtin);
    assert!(saved.error.is_none());
    assert_eq!(saved.json.as_deref(), Some(json.as_str()));

    let themes = core.list_themes().unwrap();
    assert_eq!(themes.len(), 3);
    assert_eq!(themes[2].id, "ocean-breeze");
    assert_eq!(themes[2].name, "Ocean Breeze");

    core.delete_theme("ocean-breeze").unwrap();
    let themes_after = core.list_themes().unwrap();
    assert_eq!(themes_after.len(), 2);
}

#[test]
fn malformed_or_oversized_custom_theme_on_disk_reports_error_without_breaking_builtins() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    let core = Core::open(&home).unwrap();

    std::fs::write(home.join("themes").join("broken.json"), "{not json").unwrap();
    std::fs::write(home.join("themes").join("huge.json"), "a".repeat(1_048_577)).unwrap();

    let themes = core.list_themes().unwrap();
    let dark = themes.iter().find(|t| t.id == "oxide-dark").unwrap();
    assert!(dark.error.is_none());
    assert!(dark.json.is_some());

    let broken = themes.iter().find(|t| t.id == "broken").unwrap();
    assert!(broken.json.is_none());
    assert!(
        broken
            .error
            .as_deref()
            .is_some_and(|e| e.contains("Invalid theme JSON"))
    );

    let huge = themes.iter().find(|t| t.id == "huge").unwrap();
    assert!(huge.json.is_none());
    assert!(huge.error.as_deref().is_some_and(|e| e.contains("1 MiB")));
}

#[test]
fn open_themes_folder_reveals_themes_dir_via_system() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    let core = Core::open(&home).unwrap();
    let system = Arc::new(RecordingSystem::new());
    core.set_system(system.clone());

    core.open_themes_folder().unwrap();

    let revealed = system.revealed.lock().unwrap();
    assert_eq!(revealed.as_slice(), &[home.join("themes")]);
}

#[test]
fn rejects_path_traversal_invalid_ids_oversized_payloads_and_builtin_mutation() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("oxide");
    let core = Core::open(&home).unwrap();
    let valid = valid_custom_theme("Safe");
    let too_long_id = "x".repeat(65);

    for bad_id in [
        "",
        ".",
        "..",
        "../evil",
        "sub/theme",
        "sub\\theme",
        "-dash",
        "a.b",
        too_long_id.as_str(),
    ] {
        assert!(
            core.save_theme(bad_id, &valid).is_err(),
            "save_theme should reject `{bad_id}`"
        );
        assert!(
            core.delete_theme(bad_id).is_err(),
            "delete_theme should reject `{bad_id}`"
        );
    }

    for builtin in ["oxide-dark", "oxide-light"] {
        assert!(core.save_theme(builtin, &valid).is_err());
        assert!(core.delete_theme(builtin).is_err());
    }

    let oversized = format!(
        r#"{{"name":"Big","themes":[{{"name":"Big","appearance":"dark","style":{{"note":"{}"}}}}]}}"#,
        "a".repeat(1_048_576)
    );
    assert!(core.save_theme("oversized", &oversized).is_err());

    for bad_json in [
        "{",
        r#"{"name":"","themes":[]}"#,
        r#"{"name":"X","themes":[{"name":"X","appearance":"sepia","style":{}}]}"#,
    ] {
        assert!(core.save_theme("bad-json", bad_json).is_err());
    }
}
