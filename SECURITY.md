# Security policy

## Supported versions

Oxide is pre-1.0. Only the **latest release** gets security fixes. Fixes land on `main` and ship in the next release. Older versions are not patched.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/getoxide/oxide/security) and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can:

- the Oxide version or commit
- your macOS or Windows version
- the Provider and Provider CLI version involved, if any
- steps to reproduce, the impact, and a proof of concept if you have one

## What to expect

Oxide is maintained by two people, [@cavallinilorenzo](https://github.com/cavallinilorenzo) and [@itsmrma](https://github.com/itsmrma), on a best-effort basis:

- an acknowledgement, usually within a week
- an assessment, and either a fix plan or a reasoned explanation if the report is out of scope
- coordinated disclosure: we publish a GitHub security advisory once a fix is released, crediting you unless you prefer otherwise

## Scope

Oxide is a desktop app that starts agent CLIs (Providers such as Claude Code, Codex and Antigravity CLI) **with your own user privileges**, on Projects you open. Keep this in mind when judging impact.

**In scope**, for example:

- Oxide performing an action the selected Permission mode should have prevented, such as a file edit or command running without the approval that Ask or Auto-edit requires
- the webview gaining filesystem, shell or process access beyond the Tauri commands Oxide exposes
- untrusted content (a repository, transcript, issue or Provider output) causing code execution or data exposure through Oxide itself
- Oxide leaking credentials or tokens, such as GitHub CLI tokens

**How Oxide treats a repository's own Git configuration.** Adding a folder as a Project, viewing its status, branches and Diff, and leaving it open run no program named by that folder's Git configuration: Oxide starts every Git command with `core.fsmonitor`, `core.untrackedCache` and the `ext` protocol off, with external diff drivers and textconv off, and with hooks disabled for read-only commands. It also does not fetch a Project's remote on its own until you have acted in it (sent a prompt, run a terminal command, pressed Pull or Push). Commit, checkout, pull and push are different: they are commands you ask for, so the repository's hooks and configured helpers (such as a credential helper or `core.sshCommand`) run on them, exactly as they would in a terminal. Only run those in a repository you trust.

**Credentials Oxide reads for Usage limits.** To show the Usage limit ring without a running Turn, Oxide reads the sign-in token that a Provider's own CLI already stored on your machine. It reads nothing else for this feature, and it does not store, copy or log these tokens: each one is held in a local variable for the duration of one request, then dropped.

| Provider | Where it is read from | Where it is sent |
| --- | --- | --- |
| Claude Code | `.credentials.json` in `CLAUDE_CONFIG_DIR` (default `~/.claude`), or on macOS the `Claude Code-credentials` keychain item, read through `/usr/bin/security` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `auth.json` in `CODEX_HOME` (default `~/.codex`), including the account id | `https://chatgpt.com/backend-api/wham/usage` |

Antigravity CLI needs no token: Oxide runs its own `/usage` command. The token goes only to the endpoint in the table, as a bearer token over HTTPS. The client refuses plain HTTP and never follows a redirect, so a token cannot be forwarded to another host. Errors and log lines for a failed request carry no URL, header or token. The keychain read may show a macOS prompt the first time.

**Out of scope**, because these are by design:

- anything a Provider does while running under **Full access**, or under any mode with approvals the user granted. Full access means nothing asks.
- actions a Provider takes with your privileges that its own CLI would also take outside Oxide. Report those to the Provider's vendor.
- vulnerabilities in the Provider CLIs themselves, in `git`, or in `gh`
- macOS Gatekeeper and Windows SmartScreen warnings on unsigned builds (see the [README](README.md#opening-an-unsigned-build))
