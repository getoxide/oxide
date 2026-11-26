# Disk image window

`background.tiff` is the window background of `Oxide.dmg` (`bundle.macOS.dmg` in `tauri.conf.json`): 660 × 400 pt, with a 2x image for Retina screens. The app icon sits at (180, 165) and Applications at (480, 165), both at Finder's 128 pt icon size, and the arrow between them is drawn at those positions. It is light because Finder draws the icon labels in black over a background picture, in Dark Mode too, and its text stays above y = 340, where Finder's path bar starts when shown.

`background.svg` is its source. After changing it, render both sizes (any browser at 1x and 2x, 660 × 400) and join them:

```sh
tiffutil -cathidpicheck background.png background@2x.png -out background.tiff
```

Finder applies the layout only when the bundler runs its AppleScript step, which Tauri skips when `CI=true`; `build.yml` sets `TAURI_BUNDLER_DMG_IGNORE_CI` for it. Locally, the terminal needs permission to control Finder (System Settings > Privacy & Security > Automation).
