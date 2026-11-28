## Agent skills

Workflow: see `/ask`. Before verifying or reviewing, read `docs/agents/engineering.md`.

### Issue tracker

Issues live in GitHub Issues for `getoxide/oxide` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow and PRs

- Claim assigned tickets via `gh issue edit <id> --add-assignee @me`.
- Branching model: trunk-based, `main` is the only long-lived branch. Never commit or push directly to it. Branch off `main` and open the Pull Request with `--base main`. Full rules in `docs/agents/git-workflow.md`.
- Put `Closes #<id>` in the PR body: `main` is the repo's default branch, so GitHub links the PR to the issue and closes it on merge. No manual `gh issue close` needed.

### Layout

Rust crates: `crates/oxide-platform` (OS-specific code and the process, lock and diagnostics primitives), `crates/oxide-core` (Projects, storage, terminals, files, Git, GitHub, language servers; no Tauri) and `crates/oxide-app` (the Tauri shell). The frontend is `web/src`, grouped by area: `projects/`, `terminal/`, `editor/`, `issues/`, `pull-requests/`, `settings/`, `updates/`, `shared/` and `styles/`; `App.tsx`, `main.tsx` and the generated `bindings.ts` sit at its root. `assets/` holds only the app icon masters and the palette. Oxide has Projects and plain Terminals only (ADR-0018): do not reintroduce the vocabulary of the removed features (Thread, Provider, agent sessions, approvals, worktrees, Project Services).

### OS-specific code

Code that needs an API existing on one OS only (`#[cfg(windows)]`, `unix`, `target_os`, `std::os::*`, `libc`, `windows-sys`, `objc2`), or that behaves differently per OS, goes in `crates/oxide-platform`, in three levels: declare and document the function once in its contract module at the crate root (`src/fs.rs`, `process.rs`, `system.rs`, `terminal.rs`, `env.rs`), implement it with the same signature in each of `src/imp/macos/`, `src/imp/linux/` and `src/imp/windows/` (or `src/imp/posix/` for the two Unix ones), and call the contract. Code that is the same on every OS sits beside the contract. A value that only differs per OS (a shell name, a flag, a suffix) uses `if cfg!(windows) { .. } else { .. }` anywhere. `node tools/checks/platform-layer.mjs` (part of `node tools/check.mjs fast`) enforces it against a baseline that only shrinks. After changing `crates/oxide-platform/src/imp/windows/` or a contract, run `node tools/check.mjs windows` on macOS or Linux. Details in [ADR-0019](docs/adr/0019-platform-layer.md) and [ADR-0022](docs/adr/0022-platform-contract-and-implementations.md).

### Checks

Verify your work the way CI does: `node tools/check.mjs` runs what the PR lanes run on this OS, and `node tools/check.mjs fast` runs rustfmt, ESLint and TypeScript. It needs `cargo-nextest` (`cargo install --locked cargo-nextest`). Pipeline decisions live in `tools/ci/policy.mjs`; change them test-first in `tools/ci/policy.test.mjs`. See CONTRIBUTING's "Local checks". Read [docs/devops.md](docs/devops.md) before changing a workflow, a CI check or the release process: it has every job, its reason and the release runbook. Security rules that review and CI check against are in [ADR-0016](docs/adr/0016-security-boundaries.md): read it before adding an IPC command, a process, a file access or an `unsafe` block.
