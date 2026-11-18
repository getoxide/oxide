# Oxide is Projects and plain terminals

Oxide is stripped down to its base: Projects and plain terminals. The sidebar lists the Open Projects and, under each, its Terminals; the centre of the window is one large Terminal; the right dock keeps Files, Issues and Pull request. Oxide no longer knows about agents. If the user wants one, they type `claude`, `codex` or anything else in a Terminal like any other command. This reverses most of ADR-0017 and supersedes or amends ADR-0004, ADR-0005, ADR-0009, ADR-0010, ADR-0011 and ADR-0012.

## Background

Oxide had grown into an agent workbench: Threads, Agent terminals, Providers, the Model picker, Effort, Permission modes, Custom agents, Usage limits, the Attention Center, Checkpoints and Restore, worktrees, Blind review, Line comments sent to agents, the Review ledger, Rule suggestions, Issue dispatch, Fix, a dozen keyboard shortcuts and six pages of Settings. Since Threads moved to the Provider's own CLI (ADR-0017), most of that machinery no longer earned its place, and the app had become hard to use, hard to reason about and hard to change. What the user actually wants is a Warp-like terminal app that knows their GitHub Projects.

## Decision

- **Terminals.** A Terminal is a shell in a Project's folder, with Command blocks. Core owns one PTY process per Terminal, never the webview (ADR-0016). A Project holds many; the selected one fills the centre; the others stay mounted and keep their scrollback and running processes. A Terminal is renamed and closed from the sidebar. Closing a Project ends all its Terminals and keeps the Project known. Terminals do not survive a restart.
- **Plain shell.** Oxide does not interpret what runs in a Terminal: no launch flags, prompts, statuses or permissions. No Provider, Model, Effort, Permission mode, Custom agent, Usage limit, Turn, Checkpoint, Restore or worktree exists, and Oxide creates no worktree or `oxide/*` branch. Oxide launches no agent CLI and no headless Provider run, and never polls Provider usage.
- **Right dock.** Files, Issues and Pull request. The Terminal Surface goes, because Terminals live in the centre. Issues and Pull request are plain GitHub tools through `gh`: no dispatch to an agent, no Fix, no Blind review, no sending comments to an agent, no checkout of a pull request into a Thread. A pull request is opened from the branch checked out in the Project's folder.
- **Editor.** The Code workspace stays, as the place where Files opens a file, with its language servers and their install prompts. It replaces the centre while a file is open, with a button back to the Terminals. Their custom paths in Settings go.
- **Project Services go.** A server simply runs in its Terminal.
- **No shortcuts, empty Settings.** Every custom keyboard shortcut goes; the operating system's own keys and the terminal's own keys keep working. The Settings tab stays and opens on an empty page. Emptying Settings removes in-app updates: the Updates page was the only place that checked for and installed updates, so until Settings are rebuilt users update by downloading the installer. Where Issues or Pull request need `gh`, they keep their own set-up and sign-in prompt.
- **Backend.** Every command, background task, stored table, setting and process that only served a removed feature is deleted. `oxide-provider` keeps its name but only holds the process, locking and diagnostics primitives of ADR-0016.

## Upgrade

A migration, run after the usual backup `oxide.db.bak-<version>`, drops every table that only served Threads, Providers, Checkpoints, worktrees, the Review ledger or Blind review, drops the Project columns of the removed features and drops every stored setting except the last selected Project. Projects stay open and listed. Existing worktree folders and branches stay on disk untouched: nothing outside Oxide's own storage is deleted. Old settings files are no longer read, so they load without errors.

## Consequences

- The Transcript, Items, Activity, Slash commands, Attachments, the Agent terminal and its OSC 7501 status protocol, the session reporter, Checkpoints, Restore, Blind review, Line comments, the Review ledger, Rule suggestions and Usage limits are deleted with their tests.
- Pasting an image into a Terminal no longer saves a file: only native file drops, which type the dropped paths, remain.
- ADR-0001, ADR-0002, ADR-0006 and ADR-0007 were already superseded by ADR-0017; ADR-0017 is itself superseded here, and ADR-0004, ADR-0005, ADR-0009, ADR-0010, ADR-0011 and ADR-0012 no longer describe the product. ADR-0014 (no Diff Surface) stays true, now with three Surfaces.
- If an agent integration ever comes back, it gets its own spec.

## Considered options

- **Keep the editor out too.** Rejected for now: Files still needs a place to open a file. If the centre must be the Terminal only, the editor, language servers and language installs go and Files becomes browse-only.
- **Hide the old features behind removed buttons.** Rejected: a hidden feature still has to be maintained and reviewed.
