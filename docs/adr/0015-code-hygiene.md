# Code Hygiene and Automated Guardrails

Oxide enforces Rust/Clippy lints, dependency scoping, TypeScript/ESLint checks across application and CI tooling code, and Tauri IPC command parity automatically in CI rather than relying on manual cleanup.

## Background and problem

Without automated guardrails, dead code, stale imports, unused locals, unlinted CI scripts, platform dependencies leaking across targets, unnecessary allocations across the IPC boundary, and orphaned Tauri commands accumulate quietly between refactors. When cleanup relies on periodic audits, removed features leave behind orphaned backend commands or drifted test harnesses that fail silently until touched months later.

## Decision

- **Workspace Rust and Clippy lints:** The root `Cargo.toml` defines `[workspace.lints.rust]` (`dead_code = "deny"`, `unused_imports = "deny"`, `unused_qualifications = "warn"`) and `[workspace.lints.clippy]` (`needless_pass_by_value = "warn"`, `cloned_instead_of_copied = "warn"`, `redundant_clone = "warn"`, `inefficient_to_string = "warn"`, `unnecessary_wraps = "warn"`). Every workspace crate (`crates/oxide-provider`, `crates/oxide-core`, `crates/oxide-app`) inherits them via `[lints] workspace = true`, and CI runs `cargo clippy --locked --workspace --all-targets -- -D warnings`. Boundary `#[tauri::command]` / `#[specta::specta]` entry points that must accept owned parameters (`State<'_, _>`, `AppHandle`, `String`, `Vec<String>`, `Option<String>`) or return `Result<_, AppError>` for IPC contract stability use explicit item-level `#[allow(...)]` attributes instead of weakening crate-wide rules.
- **Dependency scoping criteria:** Dependencies shared by multiple workspace crates are pinned once in `[workspace.dependencies]` in root `Cargo.toml` and inherited with `workspace = true`. Platform-specific crates (such as `libc` and `windows-sys`) must sit under `[target.'cfg(unix)'.dependencies]` or `[target.'cfg(windows)'.dependencies]` so OS-specific bindings never leak across targets. `deny.toml` (`cargo deny check`) enforces dependency hygiene, licenses, and advisories.
- **TypeScript and ESLint guardrails:** `web/tsconfig.json` enforces `"noUnusedLocals": true` and `"noUnusedParameters": true`, and includes `"tests"` alongside `"src"` so test harnesses stay aligned with production types such as `UserSettings`. `web/eslint.config.js` uses `defineConfig` from `"eslint/config"` (replacing deprecated `tseslint.config`) and lints both `web/` and repository CI tooling under `tools/**/*.mjs` when running `pnpm --dir web lint`.
- **IPC command lifecycle parity:** `web/src/bindingsParity.test.ts` checks that every command in `commands` of generated `web/src/bindings.ts` is referenced in production frontend files (`web/src/`, excluding `bindings.ts`, `*.test.*`, and `*.d.ts`). Adding a backend command without wiring its frontend caller, or removing a frontend feature while leaving its backend command behind, fails unit tests.
- **Zero-allocation conversions and lock discipline:** DTO translations across `oxide-core` and `oxide-app` prefer zero-allocation patterns (`From<Owned>` moves, borrowed slices, and copying `Copy` values rather than cloning or `.to_string()` formatting). Concurrent state guards (`MutexGuard`) must be dropped before performing filesystem I/O, network requests, or spawning subprocesses.

## Consequences

- `node tools/check.mjs fast` and `node tools/check.mjs` fail immediately on dead code, unused imports/locals, unreferenced IPC bindings, and lint violations in either `web/` or `tools/`.
- New `#[tauri::command]` functions that take owned strings or state handles document their ABI constraint with an explicit per-function `#[allow(...)]`, keeping internal Rust modules under strict checking.
