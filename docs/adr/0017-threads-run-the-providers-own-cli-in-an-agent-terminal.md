# Threads run the Provider's own CLI in an Agent terminal

A Thread's centre is a terminal running its Provider's own interactive CLI (`claude`, `codex`, `agy`, or a Custom agent's command) in the Thread's checkout. Oxide no longer renders the conversation. Rebuilding each Provider's conversation, Approvals, Slash commands and Attachments over three headless protocols kept Oxide behind every CLI release, made each new Provider a large adapter and pinned narrow CLI versions, while Oxide's distinctive value (ADR-0010) lives in the workspace around the agent. This reverses the decision in #274 (no terminal-agent integration), supersedes ADR-0001, ADR-0002, ADR-0006 and ADR-0007, and amends ADR-0004, ADR-0009, ADR-0011, ADR-0012 and ADR-0016.

## Decision

- **Agent terminal.** Core owns one PTY process per running Thread, independent of the webview, with a bounded replay buffer. It survives navigation, and ends when the user stops it, deletes the Thread or quits Oxide.
- **Launch.** Built-in Providers start from argument arrays. Model, Effort and Permission mode are launch flags only; changing them in a running session happens in the Provider's own UI. Claude Code: Ask `--permission-mode default`, Auto-edit `acceptEdits`, Full access `bypassPermissions`, always passed. Codex: Auto-edit `workspace-write` sandbox with on-request approvals (commands inside the workspace also run without asking, and the mode says so), Full access bypasses approvals and sandbox; Ask is not offered because sandboxed commands never ask. Antigravity CLI: Auto-edit `--mode accept-edits`, Full access `--dangerously-skip-permissions`; Ask is not offered until it is proven. A Custom agent runs the command the user typed in Settings through the shell, and has no Permission mode.
- **Status.** Core parses OSC 7501 (Program Status Protocol) from the PTY output and answers its feature query. `working` is working, `blocked` is needs input, `done` and `idle` are completed, `error` is error. A live agent that has reported nothing is running (status unknown); an agent that is not running is stopped, or error if it exited with a failure. Nothing is inferred from screen text. No Provider hooks are used for status.
- **Turns.** A Turn runs from a working report to the next done, idle or error report. Oxide records only its start and end, and takes a Checkpoint at each boundary, plus one when the Thread starts.
- **Session identity.** Claude Code gets its session id from Oxide at launch and resumes with it. Codex and Antigravity CLI report theirs to Oxide's reporter, Oxide's own executable run by a per-launch `notify` (Codex) or status line command (Antigravity CLI), which also runs the user's own configured command, so nothing the user set up stops working. Oxide never writes a Provider's configuration files. When resuming fails because the session is gone, the Thread says so and offers a fresh session in the same checkout and branch; that user action is the only way a Thread's session changes.
- **Prompt delivery.** A new Thread can launch with an initial prompt as a launch argument. Into a running agent, Oxide delivers a prompt only after the user confirms its exact text, pastes it as a bracketed paste and never presses Enter; it refuses while the Thread needs input, so a paste can never answer an Approval. Issue bodies, Reviewer comments and CI logs stay quoted and marked as external content.
- **Headless runs.** Blind review stays a one-shot headless run, which is not a Thread.

## Considered options

- **Keep the chat.** Rejected for the maintenance and feature lag above.
- **ACP.** Rejected for the reasons in ADR-0001; it would still be an Oxide-rendered conversation.
- **Provider hooks for status.** Claude Code's `--settings` hooks merging with the user's is not documented; Codex hooks only run once trusted; Antigravity CLI takes no hooks per invocation. OSC 7501 works for all three with no configuration.
- **Reading Provider session files.** Rejected: private, changing formats.

## Consequences

- The Transcript, Items, Activity, Phases, Command records, the Slash command catalog, Attachments and Continue in new Thread go away; pre-upgrade Threads resume their Provider session and their stored Transcript is dropped by a migration after the usual backup. ADR-0005 stays: deleting a Thread stops its agent and removes its Checkpoints and worktree, keeping the branch.
- Restore lists Turns by time, without their prompt.
- Oxide no longer sees the commands an agent runs, so ADR-0012's detaching of Provider commands into Project Services, and its Approval amendment, no longer apply. Services started from Project terminal tabs are unchanged.
- OSC 7501 is a 0.x proposal. If a Provider stops emitting it, its Threads show unknown status, never a wrong one (ADR-0001's rule).
- Any installed version of a Provider CLI is accepted; there are no pinned ranges.

## Rollout

The first slice (#497) puts Claude Code's Agent terminal behind the Settings preview "Open new Threads as terminals" (off by default), reached from the sidebar and ⌘N only. Until status signals land, a terminal Thread shows only running, stopped or error. Chat Threads, and the flows that send a prompt (Issues, Fix, Blind review), are unchanged until their own slices.

In that slice a terminal Thread's `terminal` column is set at creation and its status (`running`, `stopped`, `error`) is written by Core when the agent starts, ends or is stopped; at launch every `running` terminal Thread becomes `stopped`. Restart resumes the stored Provider session with `--resume`. The agent's environment drops `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION`, which make Claude Code treat it as a nested session that is excluded from `--resume`.
