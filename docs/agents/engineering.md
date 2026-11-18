# Engineering config

Read by `/verify`, `/judge`, `/build`, `/ship`, `/ui` and `/release`.

## Risk

- floor: medium
- sensitive: no
- high-risk paths:
  - `.github/workflows/**`, `tools/ci/**`, `deny.toml`: CI gate, supply chain and release pipeline (read `docs/devops.md` first)
  - `crates/oxide-app/capabilities/**`, `crates/oxide-app/tauri.conf.json`: Tauri permissions and the app's security surface
  - `crates/oxide-platform/**`: the only place with OS-specific code, `unsafe` and signals to processes; the Windows implementation can't be compiled by a Mac compiler, so run `node tools/check.mjs windows` (ADR-0016, ADR-0018)
  - `crates/oxide-provider/**`: the process, locking and diagnostics primitives every child process goes through (ADR 0016)
  - `crates/oxide-core/**`: Projects, the shells Core owns, files, Git and GitHub, and the database migrations (ADR 0016, ADR 0018)
  - `Cargo.lock`, `web/pnpm-lock.yaml`: dependency changes

## Recipe

- setup: `pnpm --dir web install --frozen-lockfile` (install `cargo-nextest` with `cargo install --locked cargo-nextest`; an `oxide-core` test (`language_server_transports_unsaved_diagnostics_and_completion`) runs a fixture language server with the command `python`, so a modern `python` must be on the PATH, not only `python3` (macOS ships only `python3`: symlink it into a directory on the PATH). Without it `rust-test` fails with "Pyright is not installed", which is misleading)
- checks:
  - `node tools/check.mjs fast` (rustfmt, ESLint, TypeScript)
  - `node tools/check.mjs` (everything the PR lanes run on this OS: Vitest, web build, Clippy, Rust tests, bindings check, app bundle)
- run: `web/node_modules/.bin/tauri dev`, a native desktop window (no URL)
- exercise: Core through the Rust tests (real shells on PTYs, a fake `gh`, temporary repositories); the UI by running the app, and Vitest for web-only behaviour
- screenshots: none automated; capture the app window by hand (see `/ship` for upload)
- test data: fixtures in the test suites; use synthetic Projects and temporary folders, never real ones

## Review

- second_opinion: none

## Release

- release: agents and Release Managers may tag releases and open draft releases; the `release` environment still requires Release Manager approval; the runbook is in `docs/devops.md` (ADR 0008)
