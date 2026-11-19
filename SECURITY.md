# Security policy

## Supported versions

Oxide is pre-1.0. Only the **latest release** gets security fixes. Fixes land on `main` and ship in the next release. Older versions are not patched.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/getoxide/oxide/security) and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can:

- the Oxide version or commit
- your macOS or Windows version
- steps to reproduce, the impact, and a proof of concept if you have one

## What to expect

Oxide is maintained by two people, [@cavallinilorenzo](https://github.com/cavallinilorenzo) and [@itsmrma](https://github.com/itsmrma), on a best-effort basis:

- an acknowledgement, usually within a week
- an assessment, and either a fix plan or a reasoned explanation if the report is out of scope
- coordinated disclosure: we publish a GitHub security advisory once a fix is released, crediting you unless you prefer otherwise

## Scope

Oxide is a desktop app that opens terminals in your Projects **with your own user privileges**: whatever you run in a terminal runs as you. Keep this in mind when judging impact.

**In scope**, for example:

- Oxide running a command you did not type, or writing to a file you did not ask it to write
- the webview gaining filesystem, shell or process access beyond the Tauri commands Oxide exposes
- untrusted content (a repository, an issue, a pull request or terminal output) causing code execution or data exposure through Oxide itself
- Oxide leaking credentials or tokens, such as GitHub CLI tokens

**How Oxide treats a repository's own Git configuration.** Adding a folder as a Project, browsing its files, and leaving it open run no program named by that folder's Git configuration: Oxide starts every Git command with `core.fsmonitor`, `core.untrackedCache` and the `ext` protocol off, with external diff drivers and textconv off, and with hooks disabled for read-only commands. Read-only commands also blank every `filter.<name>.clean`, `smudge` and `process` driver that the repository's own `.git/config` defines (files filtered through Git LFS configured only in that repository then show as modified until you act on them in a terminal; your global Git configuration is not touched). `core.untrackedCache` is forced off, which makes Git rewrite the untracked cache in a repository's index. It also does not fetch a Project's remote on its own until you have acted in it (run a terminal command, pressed Pull or Push). Commit, checkout, pull and push are different: they are commands you ask for, so the repository's hooks and configured helpers (such as a credential helper or `core.sshCommand`) run on them, exactly as they would in a terminal. Only run those in a repository you trust.

**Out of scope**, because these are by design:

- anything a program you run in a terminal does: Oxide does not interpret or restrict it, and it runs with your privileges as it would in any other terminal
- vulnerabilities in the programs you run in a terminal, in `git`, or in `gh`
- macOS Gatekeeper and Windows SmartScreen warnings on unsigned builds (see the [README](README.md#opening-an-unsigned-build))
