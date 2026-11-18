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

### OS-specific code

Code that needs an API existing on one OS only (`#[cfg(windows)]`, `unix`, `target_os`, `std::os::*`, `libc`, `windows-sys`, `objc2`) goes in `crates/oxide-platform`: add one function to each of `src/macos/`, `src/linux/` and `src/windows/` (or `src/posix/` for the two Unix ones) with the same signature, and call it. A value that only differs per OS (a shell name, a flag, a suffix) uses `if cfg!(windows) { .. } else { .. }` anywhere. `node tools/checks/platform-layer.mjs` (part of `node tools/check.mjs fast`) enforces it against a baseline that only shrinks. After changing `crates/oxide-platform/src/windows/`, run `node tools/check.mjs windows` on macOS or Linux. Details in [ADR-0018](docs/adr/0018-platform-layer.md).

### Checks

Verify your work the way CI does: `node tools/check.mjs` runs what the PR lanes run on this OS, and `node tools/check.mjs fast` runs rustfmt, ESLint and TypeScript. It needs `cargo-nextest` (`cargo install --locked cargo-nextest`). Pipeline decisions live in `tools/ci/policy.mjs`; change them test-first in `tools/ci/policy.test.mjs`. See CONTRIBUTING's "Local checks". Read [docs/devops.md](docs/devops.md) before changing a workflow, a CI check or the release process: it has every job, its reason and the release runbook. Security rules that review and CI check against are in [ADR-0016](docs/adr/0016-security-boundaries.md): read it before adding an IPC command, a process, a file access or an `unsafe` block.
