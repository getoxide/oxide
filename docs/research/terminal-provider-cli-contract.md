# Interactive Provider CLIs in a Thread terminal: launch, resume and status signals

**Research date:** 2026-11-17  
**Scope:** What Oxide can rely on when a Thread's centre is a PTY running the Provider's own interactive CLI (`claude`, `codex`, `agy`) in the Thread's checkout, as specified in [#496](https://github.com/getoxide/oxide/issues/496). Covers launch flags (Model, Effort, permission behaviour), initial prompt and paste, session identity and resume, status and Turn signals available without editing the user's Provider configuration files, and install/version detection. Statements are marked **Verified** (official docs, local `--help`/`--version`, or source at the tag matching the installed version) or **Inference / unknown**.

**Versions checked (macOS, `~/.local/bin`):** `claude --version` → `2.1.326 (Claude Code)`; `codex --version` → `codex-cli 0.167.0`; `agy --version` → `1.5.10`. Codex source read at tag [`rust-v0.167.0`](https://github.com/openai/codex/tree/rust-v0.167.0). The `agy` changelog was read from the local binary (`agy changelog`). No session was started and no model was called.

## Recommendation

**Inference:** Treat **OSC 7501 (Program Status Protocol)** as the common status channel and per-Provider hooks as the richer, optional channel:

1. **OSC 7501 in Oxide's terminal.** All three CLIs emit OSC 7501 `state=working|blocked|done|error|idle` (with `kind=permission|question|auth` for `blocked`) when the terminal supports it. Oxide owns the terminal emulator, so it can parse these sequences out of the PTY stream and answer the `OSC 7501 ; ? ST` feature query. This needs no flag, no file and no config change. It gives working / needs input / completed, but **not** a session id or a Turn id.
2. **Claude Code:** assign the id with `--session-id <uuid>`, and add hooks through `--settings <json>` (`UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionStart`, `SessionEnd`). These merge with the user's hooks, so this is the strongest contract of the three. Pass `--settings` again on every resume.
3. **Codex:** the id can't be assigned. Discover it from `-c notify=[...]` (fires on `agent-turn-complete`, carries `thread-id` and `turn-id`) or from the `Session ID:` line printed on exit. Codex hooks can be injected with `-c hooks...`, but non-managed hooks only run after trust review. The only per-invocation bypass, `--dangerously-bypass-hook-trust`, also runs the repository's own untrusted hooks, so don't use it by default.
4. **Antigravity (`agy`):** the id can't be assigned, and hooks can't be supplied per invocation. `--settings` takes a per-session `statusLine` command. That command gets `conversation_id` and `agent_state` on stdin, which is the only per-invocation source of the conversation id before exit. Approval-pending comes only from OSC 7501 `blocked`.
5. Where none of these fire (an old CLI version, hooks disabled by the user or by policy, a terminal query that times out), the Thread status is **unknown**.

## Claude Code (`claude` 2.1.326)

### 1. Launch: Model, Effort, permission modes

- **Verified:** `--model <alias|full name>`, `--effort low|medium|high|xhigh|max|ultracode`. Available levels depend on the model, and the flag doesn't persist. `--permission-mode` accepts `default` (labelled **Manual**; `manual` is an alias from v2.1.200, and `--help` lists `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `--dangerously-skip-permissions` is equivalent to `bypassPermissions`. [CLI reference](https://code.claude.com/docs/en/cli-reference), `claude --help`.
- **Verified:** The built-in default for terminal sessions is `auto` from v2.1.283, so Oxide must always pass a mode explicitly. [Permission modes](https://code.claude.com/docs/en/permission-modes)

| Oxide mode | Flags | Verified behaviour and gaps |
|---|---|---|
| Ask | `--permission-mode default` | Asks before most edits, shell commands and network. The user's `permissions.allow` rules still apply, so some actions can go through without asking. |
| Auto-edit | `--permission-mode acceptEdits` | Edits, plus `mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed`, go through inside the working directories. Other Bash commands, protected paths and paths outside still ask. |
| Full access | `--permission-mode bypassPermissions` | No prompts, but explicit `ask` rules, `AskUserQuestion`, critical-path `rm` and the `block*OutsideWorkingDirectories` settings still prompt or deny. Deny rules still block. The first interactive use shows a confirmation dialog that writes `skipDangerousModePermissionPrompt` to `~/.claude/settings.json`. Refused under root/sudo outside a recognised sandbox, under `--restricted`, and when managed `disableBypassPermissionsMode` is set. |

- **Inference:** Passing `skipDangerousModePermissionPrompt` through `--settings` could avoid that file write: `--settings` "can set any key your user settings file can set" ([settings](https://code.claude.com/docs/en/settings)). The settings index lists the key's scope as "User, local, or managed", so test this before relying on it.

### 2. Initial prompt and paste

- **Verified:** `claude "query"` starts an interactive session with an initial prompt. `claude -r "<session>" "query"` resumes and sends a prompt. [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Verified:** A paste of more than 800 characters or more than three lines collapses to `[Pasted text #N]`, and the full text is sent on submit. Enter submits; Ctrl+J or `\`+Enter inserts a newline. Messages typed while Claude works are queued. [Terminal config](https://code.claude.com/docs/en/terminal-config), [interactive mode](https://code.claude.com/docs/en/interactive-mode)
- **Unknown:** No documented length limit for the positional prompt. **Inference:** the OS argv limit (`ARG_MAX`) applies, and argv is visible to other local processes. For long or sensitive text, paste it into the running TUI and submit with Enter. The docs describe paste handling but don't name bracketed paste explicitly.

### 3. Session identity and resume

- **Verified:** `--session-id <uuid>` assigns the id ("must be a valid UUID"). The transcript lives at `~/.claude/projects/<project>/<session-id>.jsonl` (or under `CLAUDE_CONFIG_DIR`). The default retention is 30 days (`cleanupPeriodDays`). [CLI reference](https://code.claude.com/docs/en/cli-reference), [sessions](https://code.claude.com/docs/en/sessions)
- **Verified:** `claude --resume <session-id>` resumes interactively. It searches the current project and its worktrees, then every other project. If no stored session matches, Claude Code reports `No conversation found with session ID: <session-id>`. A failed load from the picker prints `Failed to resume the conversation` and exits 1. A terminal resume restores the permission mode, except `bypassPermissions`, which falls back to the new-session mode unless it's passed again. `--mcp-config`, `--plugin-dir`, `--add-dir`, `--settings` and `--fallback-model` must be passed again. [Sessions](https://code.claude.com/docs/en/sessions)
- **Unknown:** The exit code for `No conversation found…`, and what happens when `--session-id` names an id that already exists.
- **Verified:** Two processes resuming one session both write to one transcript, and messages can go missing. [Sessions](https://code.claude.com/docs/en/sessions)

### 4. Status signals without touching user config

- **Verified:** `--settings <file-or-json>` applies "above your user, project, and local files and below managed settings" for that session only, and doesn't write any file. The file must be a regular file no larger than 2 MiB. [Settings](https://code.claude.com/docs/en/settings), [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Verified:** "Hook entries merge across settings levels rather than replacing each other", and "Lists merge instead of overriding". An identical handler defined twice runs once. [Hooks](https://code.claude.com/docs/en/hooks), [settings](https://code.claude.com/docs/en/settings). **Inference (strong):** `--settings` is one of those levels, so its hooks add to the user's. The docs show `--settings '{"disableAllHooks": true}'` taking effect per run, which confirms `--settings` takes part in hook resolution. Confirm with a local `SessionStart` probe, which needs no model call, before shipping.
- **Verified:** If the user sets `disableAllHooks`, or managed settings set `allowManagedHooksOnly`, Oxide's hooks don't run. Overriding `disableAllHooks` from `--settings` would also re-enable the project's hooks, so Oxide must not do it. In that case, report unknown or fall back to OSC 7501. [Hooks](https://code.claude.com/docs/en/hooks)
- **Verified:** Hooks run in interactive sessions (the trust table and the `Notification` matchers below describe interactive behaviour). Every hook receives `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name` on stdin. The `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT` and `CLAUDECODE=1` environment variables are set. There is **no** session-id environment variable; the id is only in the JSON. [Hooks](https://code.claude.com/docs/en/hooks), [env vars](https://code.claude.com/docs/en/env-vars)

| Signal | Event (from `--settings`) | Verified detail |
|---|---|---|
| Turn started | `UserPromptSubmit` | "When a prompt is submitted… Also fires on turns Claude Code starts on its own." Includes `prompt`. |
| Approval pending | `PermissionRequest` | Runs "when Claude Code is about to ask you for permission". To leave the decision to the user, the hook must not return one. |
| Approval pending (late) | `Notification` matcher `permission_prompt` | Fires only after the prompt "has waited about six seconds". `idle_prompt` fires about 60 seconds after a response ends. Fields: `message`, `title`, `notification_type`. |
| Turn completed | `Stop` | "Does not run if the stoppage occurred due to a user interrupt." API errors fire `StopFailure` instead. Includes `last_assistant_message`. |
| Session id | `SessionStart` (`startup`/`resume`/`clear`/`compact`/`fork`) | Also `SessionEnd` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`; 1.5 s budget). `/clear` starts a new session id. |
| Status, no config | OSC 7501 | Interactive sessions report working / waiting on you / done to terminals that implement the protocol, from v2.1.295. Claude Code "checks for support" first. Off when `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, inside tmux, or in background sessions. [Terminal config](https://code.claude.com/docs/en/terminal-config) |

- **Inference:** After a user interrupt (Esc or Ctrl+C), no hook marks the end of the Turn. Use OSC 7501 for that, or show unknown.
- **Verified:** Workspace trust is keyed on the git repository root, and a worktree uses the main checkout's root. The trust dialog appears only in interactive terminal sessions. Hooks from settings files are not trust-gated. [Permissions](https://code.claude.com/docs/en/permissions)

### 5. Install, version, PTY and environment

- **Verified:** `claude --version` / `-v` prints `2.1.326 (Claude Code)`. Without a TTY it errors with `stdin is not a terminal`, and when stdout isn't a TTY it behaves as non-interactive. [Errors](https://code.claude.com/docs/en/errors), `claude --help`.
- **Verified:** A `claude` launched with an inherited `CLAUDE_CODE_CHILD_SESSION=1` is treated as nested. It is excluded from `--resume`, `--continue` and history unless `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is set. [Env vars](https://code.claude.com/docs/en/env-vars). **Inference:** Oxide should strip `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION` from the PTY environment. Otherwise resume can break when Oxide itself was started from a Claude Code shell.

## Codex CLI (`codex-cli` 0.167.0)

### 1. Launch: Model, Effort, permission modes

- **Verified:** `-m, --model <MODEL>`; `-s, --sandbox read-only|workspace-write|danger-full-access`; `-a, --ask-for-approval on-request|never` (the only two CLI values); `--dangerously-bypass-approvals-and-sandbox`; `-c key=value` (TOML) for anything else, e.g. `-c model_reasoning_effort="high"`. `codex --help`; [`approval_mode_cli_arg.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/utils/cli/src/approval_mode_cli_arg.rs). `model_reasoning_effort` takes values the model advertises (`low` … `max`, `ultra`). [Config reference](https://developers.openai.com/codex/config-reference)
- **Verified:** `approval_policy = "untrusted"` is no longer supported, and `on-failure` is deprecated. [Approvals and security](https://developers.openai.com/codex/agent-approvals-security), [config reference](https://developers.openai.com/codex/config-reference)

| Oxide mode | Flags | Verified behaviour and gaps |
|---|---|---|
| Ask | `-s read-only -a on-request` | Docs: reads files and runs commands inside the read-only sandbox, and asks for actions outside it. **Not exact:** sandboxed read-only commands run without asking, and the model decides when to ask. No policy asks before every command. **Unknown:** the docs don't state outright that every edit asks in read-only mode. |
| Auto-edit | `-s workspace-write -a on-request` (the documented "Auto" preset) | Edits **and commands** in the workspace run without asking. Approval is needed outside the workspace or for network. So "other actions ask" holds only for actions outside the sandbox. |
| Full access | `--dangerously-bypass-approvals-and-sandbox` (or `-s danger-full-access -a never`) | No sandbox, no approvals. |

### 2. Initial prompt and paste

- **Verified:** `codex [OPTIONS] [PROMPT]` and `codex resume [SESSION_ID] [PROMPT]`. CR/LF in the CLI prompt is normalised to LF. `-i/--image` attaches images to the initial prompt. `codex --help`; [`cli/src/main.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/cli/src/main.rs).
- **Verified:** The TUI enables bracketed paste (`EnableBracketedPaste` in [`tui.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/tui.rs)) and handles `Paste` events.
- **Unknown:** No documented prompt length limit. **Inference:** `ARG_MAX` applies, as for Claude Code.

### 3. Session identity and resume

- **Verified:** No flag assigns a session id; `codex --help` and `codex resume --help` have none.
- **Verified discovery paths:**
  - `notify` payload: `thread-id`, `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`, on `agent-turn-complete` only. [`legacy_notify.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/legacy_notify.rs)
  - Hook stdin: `session_id`, `turn_id`, `transcript_path`, `cwd`, `model`, `permission_mode`. [Hooks](https://developers.openai.com/codex/hooks)
  - The exit summary printed to stdout: `To continue this session, run:` … and/or `Session ID: <uuid>`. [`exit_summary.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/app/exit_summary.rs)
- **Inference (from source):** `SessionStart` hooks are queued and run with the first Turn's context ([`hook_runtime.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/hook_runtime.rs)), so the id isn't known before the first prompt is submitted.
- **Verified:** `codex resume <uuid|name> [PROMPT]` takes the usual model, sandbox, approval and `-c` flags. For an unknown id it prints `ERROR: No saved session found with ID <id>. Run \`codex resume\` without an ID to choose from existing sessions.` and exits **1**. [`tui/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/lib.rs), [`cli/src/main.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/cli/src/main.rs)

### 4. Status signals without touching user config

- **Verified:** `-c notify='["/path/oxide-hook","--thread","<id>"]'` replaces the user's `notify` for that run. Scalar and array values from the session-flags layer overwrite lower layers, and only tables merge ([`config/src/merge.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/merge.rs)). The payload is appended as the final argv argument. It isn't trust-gated, and it is marked legacy ("TODO: Remove this hook… when legacy `notify` support is removed").
- **Verified:** Hooks are enabled by default (feature `hooks`, stable). Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest` (runs "before guardian or user approval UI is shown"), `PostToolUse`, `Stop`, `Interrupt`, `SessionEnd`, and others. Sources combine ("Codex combines matching hooks across sources"). [Hooks](https://developers.openai.com/codex/hooks), [`permission_request.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/events/permission_request.rs)
- **Verified (source):** `-c hooks.<Event>=[...]` is read as its own `SessionFlags` layer next to the user and project layers ([`engine/discovery.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/discovery.rs)). These hooks are non-managed, so they need a trusted hash ("Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition"). `--dangerously-bypass-hook-trust` lifts trust for **every** config-layer hook in that run, including the repository's `.codex/` hooks. **Inference:** the session-flags layer is also read for `hooks.state.<key>.trusted_hash` ([`config_rules.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/config_rules.rs)), so Oxide could pre-trust its own hook per invocation. The key and hash format are internal and undocumented, so this would be fragile.
- **Verified:** TUI notifications: `tui.notifications` (bool or a list of `agent-turn-complete`, `approval-requested`, `plan-mode-prompt`, `async-question`), `tui.notification_method` (`auto|osc9|bel`), `tui.notification_condition` (`unfocused|always`, default `unfocused`). The OSC 9 text is free-form ("Approval requested: …", "Codex wants to edit …", or the reply preview), so the event type isn't encoded. [Config reference](https://developers.openai.com/codex/config-reference), [`chatwidget/notifications.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/chatwidget/notifications.rs). **Inference:** `-c tui.notifications='["approval-requested"]' -c tui.notification_method="osc9" -c tui.notification_condition="always"` would make every OSC 9 mean "approval pending".
- **Verified (source):** The TUI emits `ESC]7501;state=<idle|working|blocked|done|error>:app=codex[:kind=permission|question|auth]ESC\` whenever stdout is a TTY (VTE terminals only from version 0.54). Unlike Claude Code, it doesn't query first. [`terminal_program_status.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/terminal_program_status.rs), [`status_surfaces.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/chatwidget/status_surfaces.rs)

| Signal | Source without user-config edits |
|---|---|
| Turn started | OSC 7501 `working`; `UserPromptSubmit` hook (trust-gated) |
| Approval pending | OSC 7501 `blocked:kind=permission`; OSC 9 restricted to `approval-requested`; `PermissionRequest` hook (trust-gated) |
| Turn completed | `notify` `agent-turn-complete` (has `turn-id`); OSC 7501 `done`; `Stop` hook (trust-gated); `Interrupt` hook for user interrupts |
| Session id | `notify` `thread-id` (after the first Turn); hook `session_id`; exit summary |

### 5. Install, version, PTY and environment

- **Verified:** `codex --version` prints `codex-cli 0.167.0`. With `TERM=dumb` and no TTY it refuses to start; with a TTY it warns and asks for confirmation. Set `TERM` (for example `xterm-256color`). [`cli/src/main.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/cli/src/main.rs)
- **Verified:** `--no-daemon` runs "without the shared background server". The `daemon_auto_start` feature is on. `--no-alt-screen` keeps scrollback. `codex --help`, `codex features list`. **Inference:** with the shared background server, Turns (and therefore `notify` and hooks) may run in a daemon process, not the PTY child. Pass `--no-daemon` so the PTY process owns the session and its environment.
- **Verified:** Codex may start in `read-only` until the working directory is trusted. Trust is a `projects."<path>".trust_level` entry that marks "a project or worktree" ([approvals](https://developers.openai.com/codex/agent-approvals-security), [config reference](https://developers.openai.com/codex/config-reference)). **Inference:** each new Oxide worktree path may trigger the onboarding trust prompt, which writes to the user's `config.toml`. Passing `-c 'projects."<path>".trust_level="trusted"'` would avoid it, but it also enables project-local config and hooks. That is a security decision for [ADR-0016](../adr/0016-security-boundaries.md), not a default.

## Antigravity CLI (`agy` 1.5.10)

### 1. Launch: Model, Effort, permission modes

- **Verified:** `--model`, `--effort low|medium|high|xhigh|max`, `--mode accept-edits|auto|plan`, `--dangerously-skip-permissions`, `--sandbox`, `--settings <json|file>` ("Settings for this session only, never saved"). `agy --help`; [CLI reference](https://antigravity.google/docs/cli/reference).
- **Verified:** From 1.5.7, sessions with no saved mode start in **Auto** where it's available. To keep Default, the user saves `"agentMode": ""`. `strict` `toolPermission` takes precedence over Auto and accept-edits. (`agy changelog`, 1.5.7.) `toolPermission`: `request-review` (default; asks before write, bash, web and MCP tools unless an allow rule matches), `strict` (asks before every tool action, including reads), `always-proceed`, `proceed-in-sandbox`. [Settings](https://antigravity.google/docs/settings?tab=cli)

| Oxide mode | Flags | Gaps |
|---|---|---|
| Ask | **Inference:** `--settings '{"agentMode":"","toolPermission":"request-review"}'` | `--mode` has no documented `default` value, and the default is now Auto, so plain flags can't force Default. The `--settings` form follows from the documented keys but is **untested**. The user's allow rules still apply. |
| Auto-edit | `--mode accept-edits` | Edits go through. Commands follow `toolPermission`. |
| Full access | `--dangerously-skip-permissions` | "Auto-approve all tool permission requests". Gemini Enterprise admin review rules can still ask (changelog 1.5.x). |

### 2. Initial prompt and paste

- **Verified:** `-i, --prompt-interactive "<prompt>"` "Run an initial prompt interactively and continue the session". It conflicts with `--print` (exit 2). No positional prompt is documented. [CLI reference](https://antigravity.google/docs/cli/reference), `agy --help`, changelog 1.4.x.
- **Verified:** Bracketed paste is honoured: a fix exists for terminals "that do not honour bracketed paste". Large pastes collapse to `[Pasted text #N]`. (`agy changelog`.)

### 3. Session identity and resume

- **Verified:** No flag assigns a conversation id. `--conversation <id>` resumes and `-c/--continue` takes the latest. [CLI reference](https://antigravity.google/docs/cli/reference)
- **Verified:** A `statusLine` command gets JSON on stdin "whenever the agent state changes" (at most every 300 ms, killed after 5 s). The JSON includes `conversation_id` ("empty before the first one starts"), `agent_state` (`idle`, `working`, `tool_use`, `reviewing`, `authenticating`, `initializing`, `error`), `cwd` and `cycle_mode`. [Status line](https://www.antigravity.google/docs/cli/statusline). **Inference:** `--settings '{"statusLine":{"type":"command","command":"<oxide-probe>","stack_with_default":true}}'` gives Oxide the id per invocation without a file. It replaces any custom status line the user configured, for that session only.
- **Verified:** Hook stdin includes `conversationId`, `transcriptPath`, `workspacePaths`, `hookEventName` and `cwd`. [Hooks](https://antigravity.google/docs/hooks?tab=cli), changelog 1.5.4.
- **Unknown:** What `--conversation <unknown-id>` does in the TUI. The changelog (1.1.12) calls it the "`--conversation` not-found warning", which suggests a warning rather than an exit. In-session `/resume <id>` reports `conversation <id> not found` (1.5.9). Verify before relying on it.

### 4. Status signals without touching user config

- **Verified:** Hooks load only from `~/.gemini/config/hooks.json`, `<workspace>/.agents/hooks.json` and plugins. "Hooks don't go in `settings.json`: the CLI keeps a `hooks` key there but never loads it", so **`--settings` can't add hooks**. Events: `SessionStart` ("before the first model invocation"), `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` (`terminationReason`, `fullyIdle`). There is no `UserPromptSubmit`, `Notification` or approval-pending event. [Settings](https://antigravity.google/docs/settings?tab=cli), [hooks](https://antigravity.google/docs/hooks?tab=cli). **Inference:** writing `.agents/hooks.json` into the Thread's checkout would change the user's working tree (and may collide with a tracked file), so it's out of scope for "without editing user config".
- **Verified:** The `notifications` setting (off by default) "rings the terminal bell and shows a desktop notification" when the agent needs approval or an answer, or finishes its Turn. It can be passed with `--settings`. The escape sequence used isn't documented. [Settings](https://antigravity.google/docs/settings?tab=cli)
- **Verified:** OSC 7501 status (working, waiting for input, done, failed) from 1.4.0. The CLI checks for support first. `AGY_CLI_OSC7501=on` forces it, `off` disables it, and `AGY_CLI_OSC7501_MESSAGES=brief` drops details. Since 1.5.9 it stays `working` while background subagents run. (`agy changelog`.)

| Signal | Source without user-config edits |
|---|---|
| Turn started | OSC 7501 `working`; `statusLine` `agent_state=working` |
| Approval pending | OSC 7501 `blocked` only. **Unknown:** whether `agent_state=reviewing` means waiting for the user. |
| Turn completed | OSC 7501 `done`; `statusLine` back to `idle` (**Inference**) |
| Session id | `statusLine` `conversation_id` (via `--settings`) |

### 5. Install, version, PTY and environment

- **Verified:** `agy --version` prints a bare `1.5.10`. The install path is `~/.local/bin/agy` on macOS and Linux. [Install](https://antigravity.google/docs/cli/install/)
- **Unknown:** Any `TERM` requirement or refusal to run under a foreign PTY. None is documented.

## OSC 7501 (shared)

- **Verified:** Program Status Protocol, revision 0.4 (2026-10-10), by Mitchell Hashimoto. It's a proposal implemented by Rex and libghostty-vt. The report is `OSC 7501 ; key=value(:key=value)* ST`, with keys `state` (required), `id`, `kind`, `progress`, `app`, `title` and `msg` (base64). States are `idle`, `working`, `done`, `blocked` and `error`, plus `clear`. Kinds are `permission`, `question` and `auth`. The query is `OSC 7501 ; ? ST`, and the reply is `OSC 7501 ; ? : states=… : kinds=… ST`. Without a reply in time, the program treats the protocol as unsupported. `working` and `blocked` records end when the process exits; `done` and `error` persist. [Rex spec](https://www.superlogical.com/rex/docs/build/program-status), [control-codes summary](https://control-codes.page/proposals/osc-7501/)
- **Inference:** xterm.js can register custom OSC handlers, so Oxide can consume code 7501 and reply to `?` through the PTY input. Rate-limit any notification triggered by status changes, as the spec advises. The protocol is young, and "done" means "result not yet seen", not "Turn boundary with id". Use it for status, not for Turn identity.

## Evidence limits

- No interactive session was launched (instruction: no model calls, no login). All runtime behaviour comes from docs, `--help`, the `agy` changelog and Codex source. In particular, the merge of `--settings` hooks with user hooks (Claude Code), the `agentMode` override (agy), the `statusLine` override (agy) and the Codex trust pre-seeding are **untested**. Each can be checked locally with a no-model probe (Claude Code `SessionStart`, agy `statusLine` at startup) before implementation.
- Claude Code and Antigravity are closed binaries. Their behaviour follows the official docs, which change often (several facts here are version-gated). Re-check against the pinned version range.
- Codex facts are pinned to `rust-v0.167.0`. `notify` is explicitly legacy and may be removed. The hook trust key and hash format are internal.
- The OSC 7501 spec is a 0.x proposal. Claude Code and agy only emit after a successful feature query, so Oxide's terminal must answer it.
- The exit codes for Claude Code's `No conversation found…` and agy's unknown `--conversation`, and Claude Code's behaviour on a reused `--session-id`, remain unknown.
- Security review of any hook command, `notify` program or `statusLine` probe that reports back to Oxide belongs to [ADR-0016](../adr/0016-security-boundaries.md) (a new process and an IPC path).
