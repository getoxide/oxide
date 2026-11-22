//! Disk-backed Zed-style JSON themes stored under `~/.oxide/themes/`.
//!
//! All theme files live directly inside `<home>/themes/` with `0700`/`0600` permissions on Unix
//! (via `oxide_platform::fs`). Reads and writes validate theme IDs (filename stems), reject
//! symlinks and path traversal, canonicalize inside `<home>/themes/`, and enforce a 1 MiB cap.

use crate::{Error, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Subdirectory under Oxide's home where JSON theme files live.
pub const THEMES_DIR: &str = "themes";

/// Maximum size of a theme JSON file in bytes (1 MiB).
pub const MAX_THEME_BYTES: usize = 1_048_576;

/// Built-in theme file stems seeded into `<home>/themes/`.
pub const BUILTIN_THEME_IDS: [&str; 2] = ["oxide-dark", "oxide-light"];

const MAX_THEME_ID_LEN: usize = 64;

/// Summary of one theme file discovered in `<home>/themes/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    /// Filename stem (without `.json`).
    pub id: String,
    /// Pack name from the JSON file, or `id` when the file is invalid.
    pub name: String,
    /// Whether this is one of Oxide's seeded built-in themes.
    pub builtin: bool,
    /// Raw JSON contents when valid.
    pub json: Option<String>,
    /// Validation or I/O error message when the file could not be loaded.
    pub error: Option<String>,
}

const OXIDE_DARK_THEME_JSON: &str = r##"{
  "name": "Oxide Dark",
  "author": "Oxide",
  "themes": [
    {
      "name": "Oxide Dark",
      "appearance": "dark",
      "fonts": {
        "ui": "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
        "code": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, \"Cascadia Code\", Consolas, Menlo, monospace",
        "terminal": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, \"Cascadia Code\", Consolas, Menlo, monospace",
        "surfaces": "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
      },
      "style": {
        "background": "#1C1C1E",
        "surface.background": "#242426",
        "elevated_surface.background": "#2C2C2E",
        "element.background": "#3A3A3C",
        "text": "#E8E6E1",
        "text.bright": "#FFFFFF",
        "text.muted": "#B3B1AB",
        "text.disabled": "#9A9892",
        "text.accent": "#58A6FF",
        "border": "#333335",
        "border.focused": "#48484A",
        "element.border": "#48484A",
        "element.hover": "#343436",
        "element.active": "#3A3A3C",
        "accent": "#1F6AD5",
        "accent.hover": "#2472DF",
        "accent.foreground": "#FFFFFF",
        "error": "#F27A72",
        "success": "#5FCB8F",
        "warning": "#E8B84F",
        "hint": "#B79CF0",
        "title_bar.background": "#242426",
        "title_bar.border": "#333335",
        "title_bar.foreground": "#E8E6E1",
        "sidebar.background": "#242426",
        "sidebar.border": "#333335",
        "sidebar.foreground": "#E8E6E1",
        "sidebar.item.hover": "#2C2C2E",
        "sidebar.item.active": "#3A3A3C",
        "sidebar.switch.background": "#2C2C2E",
        "sidebar.switch.active": "#3A3A3C",
        "surfaces.background": "#1C1C1E",
        "surfaces.header.background": "#242426",
        "surfaces.card.background": "#242426",
        "surfaces.border": "#333335",
        "surfaces.foreground": "#E8E6E1",
        "tab_bar.background": "#242426",
        "tab.active_background": "#1C1C1E",
        "tab.inactive_background": "#242426",
        "tab.border": "#333335",
        "breadcrumbs.background": "#1C1C1E",
        "breadcrumbs.foreground": "#B3B1AB",
        "status_bar.background": "#242426",
        "status_bar.foreground": "#B3B1AB",
        "editor.background": "#1C1C1E",
        "editor.foreground": "#E8E6E1",
        "editor.gutter.background": "#1C1C1E",
        "editor.line_number": "#7A7974",
        "editor.active_line_number": "#B3B1AB",
        "editor.active_line.background": "#242426",
        "editor.selection.background": "#2A4A78",
        "editor.cursor": "#E8E6E1",
        "editor.indent_guide": "#333335",
        "editor.widget.background": "#2C2C2E",
        "editor.widget.border": "#48484A",
        "terminal.background": "#1C1C1E",
        "terminal.foreground": "#E8E6E1",
        "terminal.cursor": "#58A6FF",
        "terminal.selection.background": "#2A4A78",
        "terminal.header.background": "#242426",
        "terminal.composer.background": "#242426",
        "terminal.block.border": "#333335",
        "terminal.block.running_rail": "#58A6FF",
        "terminal.block.running_tint": "#1F6AD514",
        "terminal.block.failed_rail": "#F27A72",
        "terminal.block.failed_tint": "#F27A7214",
        "terminal.ansi.black": "#2C2C2E",
        "terminal.ansi.red": "#F27A72",
        "terminal.ansi.green": "#5FCB8F",
        "terminal.ansi.yellow": "#E8B84F",
        "terminal.ansi.blue": "#78A9F0",
        "terminal.ansi.magenta": "#C9A8F0",
        "terminal.ansi.cyan": "#7DD3D8",
        "terminal.ansi.white": "#E8E6E1",
        "terminal.ansi.bright_black": "#8A8883",
        "terminal.ansi.bright_red": "#FF9A92",
        "terminal.ansi.bright_green": "#86E0AE",
        "terminal.ansi.bright_yellow": "#F5CF7E",
        "terminal.ansi.bright_blue": "#9DC2F7",
        "terminal.ansi.bright_magenta": "#DBC2F9",
        "terminal.ansi.bright_cyan": "#A1E6EA",
        "terminal.ansi.bright_white": "#FFFFFF",
        "syntax": {
          "comment": {
            "color": "#9A9892",
            "font_style": "italic"
          },
          "keyword": {
            "color": "#C9A8F0"
          },
          "string": {
            "color": "#A8D5A2"
          },
          "number": {
            "color": "#E6B673"
          },
          "type": {
            "color": "#8FC1E8"
          },
          "identifier": {
            "color": "#E8E6E1"
          },
          "operator": {
            "color": "#B3B1AB"
          }
        }
      }
    }
  ]
}
"##;

const OXIDE_LIGHT_THEME_JSON: &str = r##"{
  "name": "Oxide Light",
  "author": "Oxide",
  "themes": [
    {
      "name": "Oxide Light",
      "appearance": "light",
      "fonts": {
        "ui": "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
        "code": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, \"Cascadia Code\", Consolas, Menlo, monospace",
        "terminal": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, \"Cascadia Code\", Consolas, Menlo, monospace",
        "surfaces": "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
      },
      "style": {
        "background": "#FBFBFA",
        "surface.background": "#F2F1EE",
        "elevated_surface.background": "#E9E8E4",
        "element.background": "#DEDDD8",
        "text": "#2C2C2E",
        "text.bright": "#1C1C1E",
        "text.muted": "#5F5E5A",
        "text.disabled": "#62615C",
        "text.accent": "#0860C7",
        "border": "#DEDDD8",
        "border.focused": "#BDBCB7",
        "element.border": "#C7C6C1",
        "element.hover": "#E9E8E4",
        "element.active": "#DEDDD8",
        "accent": "#0969DA",
        "accent.hover": "#0860C7",
        "accent.foreground": "#FFFFFF",
        "error": "#C4281F",
        "success": "#15703C",
        "warning": "#8A5A00",
        "hint": "#7148C0",
        "title_bar.background": "#F2F1EE",
        "title_bar.border": "#DEDDD8",
        "title_bar.foreground": "#2C2C2E",
        "sidebar.background": "#F2F1EE",
        "sidebar.border": "#DEDDD8",
        "sidebar.foreground": "#2C2C2E",
        "sidebar.item.hover": "#E9E8E4",
        "sidebar.item.active": "#DEDDD8",
        "sidebar.switch.background": "#E9E8E4",
        "sidebar.switch.active": "#DEDDD8",
        "surfaces.background": "#FBFBFA",
        "surfaces.header.background": "#F2F1EE",
        "surfaces.card.background": "#F2F1EE",
        "surfaces.border": "#DEDDD8",
        "surfaces.foreground": "#2C2C2E",
        "tab_bar.background": "#F2F1EE",
        "tab.active_background": "#FBFBFA",
        "tab.inactive_background": "#F2F1EE",
        "tab.border": "#DEDDD8",
        "breadcrumbs.background": "#FBFBFA",
        "breadcrumbs.foreground": "#5F5E5A",
        "status_bar.background": "#F2F1EE",
        "status_bar.foreground": "#5F5E5A",
        "editor.background": "#FBFBFA",
        "editor.foreground": "#2C2C2E",
        "editor.gutter.background": "#FBFBFA",
        "editor.line_number": "#8A8883",
        "editor.active_line_number": "#5F5E5A",
        "editor.active_line.background": "#F2F1EE",
        "editor.selection.background": "#BCD6F5",
        "editor.cursor": "#1C1C1E",
        "editor.indent_guide": "#DEDDD8",
        "editor.widget.background": "#F2F1EE",
        "editor.widget.border": "#C7C6C1",
        "terminal.background": "#FBFBFA",
        "terminal.foreground": "#2C2C2E",
        "terminal.cursor": "#0969DA",
        "terminal.selection.background": "#BCD6F5",
        "terminal.header.background": "#F2F1EE",
        "terminal.composer.background": "#F2F1EE",
        "terminal.block.border": "#DEDDD8",
        "terminal.block.running_rail": "#0969DA",
        "terminal.block.running_tint": "#0969DA14",
        "terminal.block.failed_rail": "#C4281F",
        "terminal.block.failed_tint": "#C4281F14",
        "terminal.ansi.black": "#2C2C2E",
        "terminal.ansi.red": "#C4281F",
        "terminal.ansi.green": "#15703C",
        "terminal.ansi.yellow": "#8A5A00",
        "terminal.ansi.blue": "#0969DA",
        "terminal.ansi.magenta": "#7148C0",
        "terminal.ansi.cyan": "#0B7285",
        "terminal.ansi.white": "#62615C",
        "terminal.ansi.bright_black": "#62615C",
        "terminal.ansi.bright_red": "#A5201A",
        "terminal.ansi.bright_green": "#0F5A30",
        "terminal.ansi.bright_yellow": "#6E4700",
        "terminal.ansi.bright_blue": "#0757B5",
        "terminal.ansi.bright_magenta": "#5B38A0",
        "terminal.ansi.bright_cyan": "#095C6B",
        "terminal.ansi.bright_white": "#1C1C1E",
        "syntax": {
          "comment": {
            "color": "#62615C",
            "font_style": "italic"
          },
          "keyword": {
            "color": "#7148C0"
          },
          "string": {
            "color": "#15703C"
          },
          "number": {
            "color": "#8A5A00"
          },
          "type": {
            "color": "#1F5FA8"
          },
          "identifier": {
            "color": "#2C2C2E"
          },
          "operator": {
            "color": "#5F5E5A"
          }
        }
      }
    }
  ]
}
"##;

fn io_err(path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

pub(crate) fn themes_dir(home: &Path) -> PathBuf {
    home.join(THEMES_DIR)
}

fn is_builtin_id(id: &str) -> bool {
    BUILTIN_THEME_IDS.contains(&id)
}

/// Validates a theme filename stem: 1..=64 ASCII `[A-Za-z0-9_-]`, cannot start with `-` or `.`.
pub(crate) fn validate_theme_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_THEME_ID_LEN {
        return Err(Error::Theme(
            "Theme id must be between 1 and 64 characters.".into(),
        ));
    }
    if id.starts_with('-') || id.starts_with('.') {
        return Err(Error::Theme(
            "Theme id cannot start with '-' or '.'.".into(),
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::Theme(
            "Theme id may only contain ASCII letters, digits, '-' and '_'.".into(),
        ));
    }
    Ok(())
}

/// Validates that `raw` is a valid Zed-style theme pack JSON within [`MAX_THEME_BYTES`].
/// Returns the pack's `name`.
pub(crate) fn validate_theme_json(raw: &str) -> Result<String> {
    if raw.len() > MAX_THEME_BYTES {
        return Err(Error::Theme(
            "Theme JSON must be smaller than 1 MiB.".into(),
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| Error::Theme(format!("Invalid theme JSON: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| Error::Theme("Theme JSON root must be an object.".into()))?;
    let pack_name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Theme("Theme JSON must provide a non-empty \"name\".".into()))?
        .to_string();
    let themes = obj
        .get("themes")
        .and_then(|v| v.as_array())
        .filter(|arr| !arr.is_empty() && arr.len() <= 64)
        .ok_or_else(|| {
            Error::Theme("Theme JSON must provide a non-empty \"themes\" array (max 64).".into())
        })?;
    let mut seen_names = HashSet::new();
    for item in themes {
        let theme = item
            .as_object()
            .ok_or_else(|| Error::Theme("Each entry in \"themes\" must be an object.".into()))?;
        let name = theme
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Theme("Each theme must have a non-empty \"name\".".into()))?;
        if !seen_names.insert(name.to_string()) {
            return Err(Error::Theme(format!(
                "Duplicate theme name \"{name}\" in theme pack."
            )));
        }
        let appearance = theme
            .get("appearance")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                Error::Theme(format!("{name}: appearance must be \"dark\" or \"light\"."))
            })?;
        if appearance != "dark" && appearance != "light" {
            return Err(Error::Theme(format!(
                "{name}: appearance must be \"dark\" or \"light\"."
            )));
        }
        if !theme.get("style").is_some_and(|s| s.is_object()) {
            return Err(Error::Theme(format!("{name}: style must be an object.")));
        }
    }
    Ok(pack_name)
}

/// Ensures `<home>/themes/` exists (`0700`) and seeds `oxide-dark.json` and `oxide-light.json`
/// (`0600`) when missing.
pub(crate) fn seed_builtin_themes(home: &Path) -> Result<PathBuf> {
    let dir = themes_dir(home);
    oxide_platform::fs::create_private_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    let builtins = [
        ("oxide-dark.json", OXIDE_DARK_THEME_JSON),
        ("oxide-light.json", OXIDE_LIGHT_THEME_JSON),
    ];
    for (filename, content) in builtins {
        let path = dir.join(filename);
        if std::fs::symlink_metadata(&path).is_err() {
            let mut file =
                oxide_platform::fs::create_private_file(&path).map_err(|e| io_err(&path, e))?;
            file.write_all(content.as_bytes())
                .map_err(|e| io_err(&path, e))?;
            file.sync_all().map_err(|e| io_err(&path, e))?;
        }
    }
    Ok(dir)
}

fn canonical_themes_dir(home: &Path) -> Result<PathBuf> {
    let dir = seed_builtin_themes(home)?;
    dir.canonicalize().map_err(|e| io_err(&dir, e))
}

fn resolve_theme_path(home: &Path, id: &str) -> Result<(PathBuf, PathBuf)> {
    validate_theme_id(id)?;
    let root = canonical_themes_dir(home)?;
    let candidate = root.join(format!("{id}.json"));
    if let Ok(meta) = std::fs::symlink_metadata(&candidate) {
        if meta.file_type().is_symlink() || !meta.file_type().is_file() {
            return Err(Error::Theme(
                "Theme files must be regular files (symlinks are not allowed).".into(),
            ));
        }
        let canonical = candidate
            .canonicalize()
            .map_err(|e| io_err(&candidate, e))?;
        if !canonical.starts_with(&root) || canonical.parent() != Some(root.as_path()) {
            return Err(Error::InvalidPath(id.to_string()));
        }
        return Ok((root, canonical));
    }
    Ok((root, candidate))
}

fn read_theme_entry(root: &Path, path: &Path, id: &str) -> ThemeSummary {
    let builtin = is_builtin_id(id);
    let err_summary = |msg: String| ThemeSummary {
        id: id.to_string(),
        name: id.to_string(),
        builtin,
        json: None,
        error: Some(msg),
    };

    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => return err_summary(format!("Could not inspect theme file: {e}")),
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return err_summary("Theme files must be regular files (symlinks are not allowed).".into());
    }
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(e) => return err_summary(format!("Could not resolve theme path: {e}")),
    };
    if !canonical.starts_with(root) || canonical.parent() != Some(root) {
        return err_summary("Theme path resolves outside the themes folder.".into());
    }
    if meta.len() > MAX_THEME_BYTES as u64 {
        return err_summary("Theme JSON must be smaller than 1 MiB.".into());
    }
    let file = match oxide_platform::fs::open_nonblocking(&canonical) {
        Ok(f) => f,
        Err(e) => return err_summary(format!("Could not open theme file: {e}")),
    };
    let mut buf = Vec::new();
    let mut limited = file.take((MAX_THEME_BYTES + 1) as u64);
    if let Err(e) = limited.read_to_end(&mut buf) {
        return err_summary(format!("Could not read theme file: {e}"));
    }
    if buf.len() > MAX_THEME_BYTES {
        return err_summary("Theme JSON must be smaller than 1 MiB.".into());
    }
    let raw = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(_) => return err_summary("Theme file must be valid UTF-8.".into()),
    };
    match validate_theme_json(&raw) {
        Ok(name) => ThemeSummary {
            id: id.to_string(),
            name,
            builtin,
            json: Some(raw),
            error: None,
        },
        Err(e) => err_summary(e.to_string()),
    }
}

/// Lists all `*.json` themes in `<home>/themes/`, seeding built-ins first.
pub(crate) fn list_themes(home: &Path) -> Result<Vec<ThemeSummary>> {
    let root = canonical_themes_dir(home)?;
    let entries = std::fs::read_dir(&root).map_err(|e| io_err(&root, e))?;
    let mut themes = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stem) = file_name.strip_suffix(".json") else {
            continue;
        };
        // Skip directories even if named *.json
        if std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        if validate_theme_id(stem).is_err() {
            themes.push(ThemeSummary {
                id: stem.to_string(),
                name: stem.to_string(),
                builtin: false,
                json: None,
                error: Some(
                    "Theme filename stem may only contain ASCII letters, digits, '-' and '_'."
                        .into(),
                ),
            });
            continue;
        }
        themes.push(read_theme_entry(&root, &path, stem));
    }
    themes.sort_by(|a, b| b.builtin.cmp(&a.builtin).then_with(|| a.id.cmp(&b.id)));
    Ok(themes)
}

/// Saves a custom theme JSON file to `<home>/themes/<id>.json` with `0600` permissions.
/// Rejects built-in theme IDs, invalid IDs, symlinks, path traversal, and invalid/oversized JSON.
pub(crate) fn save_theme(home: &Path, id: &str, json: &str) -> Result<ThemeSummary> {
    validate_theme_id(id)?;
    if is_builtin_id(id) {
        return Err(Error::Theme(
            "Built-in themes are read-only; duplicate one to customize it.".into(),
        ));
    }
    let name = validate_theme_json(json)?;
    let (_root, target) = resolve_theme_path(home, id)?;
    let mut file =
        oxide_platform::fs::create_private_file(&target).map_err(|e| io_err(&target, e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| io_err(&target, e))?;
    file.sync_all().map_err(|e| io_err(&target, e))?;
    Ok(ThemeSummary {
        id: id.to_string(),
        name,
        builtin: false,
        json: Some(json.to_string()),
        error: None,
    })
}

/// Deletes a custom theme file `<home>/themes/<id>.json`.
/// Rejects built-in theme IDs, invalid IDs, symlinks, and path traversal.
pub(crate) fn delete_theme(home: &Path, id: &str) -> Result<()> {
    validate_theme_id(id)?;
    if is_builtin_id(id) {
        return Err(Error::Theme("Built-in themes cannot be deleted.".into()));
    }
    let (_root, target) = resolve_theme_path(home, id)?;
    if std::fs::symlink_metadata(&target).is_err() {
        return Err(Error::Theme(format!("Theme '{id}' not found.")));
    }
    std::fs::remove_file(&target).map_err(|e| io_err(&target, e))?;
    Ok(())
}
