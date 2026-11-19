# Assets

What the app and its tests read. The full brand kit (marks, logos, favicon, avatar, social preview) lives outside this repository.

## Icons

`icons/oxide-app-icon.svg` is the master of the app icon: a full-bleed square with no rounded corners and no margin, with `plate` and `glyph` layers. The OS applies its own mask on macOS and shows it as is on Windows and Linux, so never round it here.

`icons/oxide-app-icon-dev.svg` is the same icon with an amber hazard band along the bottom edge, for development builds (`Oxide Dev`). It never ships in a release.

The bundled icons are generated from the masters. From the repository root:

```sh
web/node_modules/.bin/tauri icon assets/icons/oxide-app-icon.svg -o crates/oxide-app/icons
web/node_modules/.bin/tauri icon assets/icons/oxide-app-icon-dev.svg -o crates/oxide-app/icons-dev
```

Keep only the files `tauri.conf.json` and `tauri.dev.conf.json` list (the generator also writes mobile and Store icons).

## Palette

The Titanium palette, dark and light. The app's colours in `web/src/appearance.ts` and the editor and terminal themes must match these files; their tests read them.

| File | Contents |
| --- | --- |
| `palette/oxide-tokens.json` | Source of truth: every colour and the typography. |
| `palette/oxide-titanium-theme.json` | The palette as a Zed-style JSON theme pack: the editor, terminal and syntax colours. |
