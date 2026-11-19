# Copilot instructions for Oxide

## Repository shape and architecture

Oxide is a Rust/Tauri desktop application with a React/Vite webview. The Rust workspace contains:

- `crates/oxide-platform`: the platform layer (ADR-0019). The only crate with OS-specific code (`macos/`, `linux/`, `windows/`, shared POSIX code in `posix/`), plus the primitives every child process goes through: process groups and Job Objects, the live-process registry, command lookup, bounded line reading, lock recovery and diagnostics (ADR-0016). It depends on no other Oxide crate.
- `crates/oxide-core`: headless application and domain logic. It owns Projects, persistence (SQLite), Terminals and their shells, files, Git/GitHub integration, language servers and background work. Keep this crate independent of Tauri so its behavior can be tested headlessly.
- `crates/oxide-app`: the thin Tauri shell. Tauri commands adapt `oxide_core::Core` types to the webview, and `tauri-specta` generates the typed TypeScript command API.
- `web`: the React frontend, grouped by area in `web/src` (`projects/`, `terminal/`, `editor/`, `issues/`, `pull-requests/`, `settings/`, `shared/`, `styles/`). It calls Rust only through `web/src/bindings.ts` and renders the Projects sidebar, the Terminals, the Code workspace and the Files, Issues and Pull request Surfaces.

The normal flow is `web` UI -> generated Tauri bindings -> `oxide-app` command -> `oxide-core` -> Git/GitHub/filesystem/process services. Long-running or blocking work is moved off the Tauri/UI thread, and external processes are tracked by the process registry in `oxide-platform`. Core persists application state in SQLite under the Oxide home directory.

Use the vocabulary in `GLOSSARY.md` (especially Project, Terminal, Command block, and Surface) and check relevant decisions in `docs/adr/` before changing cross-cutting behavior.

## Commands

Prerequisites are the pinned Rust toolchain from `rust-toolchain.toml`, Node.js 22, and pnpm from `web/package.json` (enable Corepack). Install frontend dependencies with:

```sh
pnpm --dir web install
```

Preferred CI-equivalent checks:

```sh
node tools/check.mjs       # all PR-lane checks available on this OS
node tools/check.mjs fast  # rustfmt, ESLint, and TypeScript
```

The full runner uses `cargo-nextest`; install it once if needed:

```sh
cargo install --locked cargo-nextest
```

Individual checks:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --workspace
cargo nextest run --locked --workspace --profile ci
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web build
node --test "tools/**/*.test.mjs"
```

Run a single Rust test by package/test target and name:

```sh
cargo test -p oxide-core test_name
cargo nextest run -p oxide-core -E 'test(test_name)'
```

Run a single frontend test file or test name:

```sh
pnpm --dir web exec vitest run src/path/to/file.test.tsx
pnpm --dir web exec vitest run -t "test name"
```

When a Tauri command or exposed type changes, regenerate the committed bindings and verify them:

```sh
cargo test -p oxide-app --test bindings_and_capabilities
```

Run the app from the repository root so Tauri finds `crates/oxide-app/tauri.conf.json`:

```sh
pnpm --dir web build:app
web/node_modules/.bin/tauri dev
```

On Windows, use `.\web\node_modules\.bin\tauri.cmd` for the Tauri CLI.

## Codebase conventions

- Treat `oxide-core` as the source of application behavior. Add Tauri-specific serialization or `specta::Type` derives in `oxide-app` rather than coupling Core to Tauri.
- Tauri commands are collected in `crates/oxide-app/src/lib.rs`; update the command registration and regenerate `web/src/bindings.ts` in the same change. The bindings diff is checked in CI.
- Use Core’s headless tests for deterministic behavior (real shells on PTYs, a fake `gh`, temporary repositories). Do not make ordinary tests depend on installed tools, logins, network access, or secrets.
- Keep blocking filesystem, Git, process, and native-worker work off the Tauri/UI thread. Follow the existing process-registry patterns for work that needs cancellation.
- Keep frontend state and surface behavior in `web/src`; call backend operations through the generated `commands` API and handle its typed `{ status: "ok" | "error" }` results consistently.
- `tools/ci/policy.mjs` is the source of truth for CI lane selection, gate evaluation, PR-title validation, release version alignment, and related pipeline policy. Change its pure functions and tests together rather than encoding policy only in workflow YAML.
- `web/pnpm-workspace.yaml` enforces a seven-day package release age and currently allows no install scripts. Review dependency changes against that policy; keep Tauri Rust and JavaScript major/minor versions aligned.
- Use the repository branch model: branch from `main` with a type such as `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, or `research`; open PRs against `main`; use Conventional Commit PR titles; include `Closes #<id>` when a change addresses an issue. Do not push directly to `main` or create release tags.

For CI, workflow changes, release work, or changes to checks, read `docs/devops.md` and the relevant files under `docs/agents/` before editing.
