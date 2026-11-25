# Terminal and Code

The centre shows the selected Terminal: a shell in the selected Project's folder
(ADR-0018). Opening a file from the **Files view** shows that Project's Code
workspace in a half beside the Terminal, with a divider and maximize/restore
buttons; switching keeps open buffers and terminal processes alive. The Files view
in the sidebar (opened from a Project's Files button) is the navigator for the
Project's folder, not an editor: a single click selects a file, and a double click
(or Enter/Space on a focused row) opens it in the Code half.

## Terminal

Commands entered in the bottom composer run in one persistent PowerShell session
on Windows and a POSIX shell on macOS/Linux. Each block keeps command output and
exit status together. `cd` and shell variables carry over between commands.

- Enter runs a command; Shift+Enter adds another line.
- Right accepts the inline suggestion from your latest matching command.
- Tab requests shell completion, independently of history. Windows uses
  PowerShell's `TabExpansion2` in the live session, including its current directory,
  aliases and registered completers. POSIX completion covers files and PATH commands.
- Up opens the history picker; Up/Down navigate it, Enter inserts a command, and
  Escape dismisses it. Ctrl+R focuses its search field.
- Interact with a running program directly in its output terminal; Ctrl+C
  interrupts it. A shell that exits offers "Start a new shell".
- Cursor-addressed and alternate-screen applications use the central viewport.
  Output redraws do not resize the PTY. On every shell a Command block marks its
  own end as soon as its command finishes; the shell prompt marks the end only of
  a block stopped by Ctrl+C, so Ctrl+C leaves the shell usable. Tab completes in
  the folder the shell last reported: at the end of the running block, or at a
  prompt outside any block. A long command is typed in short lines, so one sent
  while startup files run is not cut at the terminal's line limit.
- The Terminal header shows the shell and its current directory, which follows
  every `cd`. A Command block shows only its command and one status: a spinner
  while it runs, then its duration, or `exit N` beside the duration when it
  fails. Output is always shown; select it to copy. `clear` or Ctrl+L clears
  the blocks.

History retains up to 300 commands per Terminal in local application storage.
Output is session-only: the latest 24 blocks retain up to 256 KiB each, with an
explicit truncation notice. This is a local terminal workflow, not a Warp account
integration or Warp's AI service.

## Code

The Code workspace opens files in tabs. The Files view navigates the checkout:
a click selects a file and a double click (or Enter/Space on a focused row) opens
it here, in the Code half. Monaco provides syntax highlighting, automatic
indentation, bracket pairing, folding, multiple cursors, undo/redo, Find/Replace
and its command palette. Local LSP servers add completion, hover information,
definitions, references, rename and formatting where the server supports them.
Problems shows errors and warnings in open files and jumps to their locations.

- The **Find file** button finds a file by name in the Project.
- Ctrl+S / ⌘S: save; Ctrl+Shift+S / ⌘Shift+S: save all.
- Ctrl+F / ⌘F and Ctrl+H / ⌘H: Monaco's Find and Replace.
- F12: definition; Shift+F12: references; F2: rename, when supported by LSP.

The editor handles complete UTF-8 text files up to 1 MiB. Larger and binary files
are not opened for editing; they remain listed in Files. Saves replace files
atomically and refuse to overwrite a buffer whose original content has changed on
disk. Quitting asks about unsaved buffers and offers Save all, Discard, or Cancel.

## First-use language support

Opening a supported file offers **Install support** when its server is missing.
Choosing Later dismisses that language's offer. The download does not start
merely by opening a file.

| Files | Server |
| --- | --- |
| Python | Pyright |
| C / C++ | clangd |
| JavaScript / TypeScript, JSX / TSX | typescript-language-server |
| Rust | rust-analyzer |

Tools install under Oxide's `tools/` directory in its application home.
clangd and rust-analyzer come from their official GitHub releases. Python and
TypeScript use npm packages in a private prefix, with a private Node.js LTS runtime
downloaded from nodejs.org if npm is unavailable. Node downloads verify SHA-256
checksums; GitHub asset digests are verified when supplied. No elevated installer
is used by the default Install action.

TypeScript uses a Project's JavaScript SDK when available, otherwise its compatible
managed TypeScript 6 SDK. TypeScript 7's native package does not ship tsserver.js.
Python/TypeScript package versions are pinned to the tested versions. Updates are
explicit installs, not background activity.

A server can also be named by hand in `language-servers.json` in the application
home: an executable, a JSON array of arguments and an optional Python interpreter.
Rust project diagnostics need a Rust toolchain; Python imports depend on the
selected environment. For C/C++ project flags, provide `compile_commands.json` or
clangd arguments such as `--compile-commands-dir`.

Official clangd Linux binaries target x86_64. Other architectures can name a
server installed through their own package manager in `language-servers.json`.

## Dropping files

Dropping files onto a terminal types their paths, quoted literally and without
submitting them. Pasting images no longer saves a file: Oxide has no attachments
(ADR-0018).

## Validation

Offline workbench integration tests use a local LSP fixture and real shell PTYs:

```sh
cargo test -p oxide-core --test workbench
```

Opt-in tests download and launch the real four language servers inside disposable
application homes; ordinary CI skips these network-dependent tests:

```sh
cargo test -p oxide-core --test language_install_live -- --ignored --nocapture
```

The browser regression uses the real Core PTY through a test-only JSON-lines
bridge. With Node.js, Python, Playwright/Chromium and the web dev server available:

```sh
cargo build -p oxide-core --example terminal_harness
node web/scripts/terminal-regression.cjs
```

Set `OXIDE_PLAYWRIGHT_PATH` to an existing Playwright module installation when it
is not on Node's module path. `OXIDE_TEST_URL` overrides the default dev server
(`http://127.0.0.1:1420`). The test checks stable full-screen geometry, real shell
completion, Right-arrow history completion and the Up history picker, and writes a screenshot to `web/test-results/terminal-regression/` (ignored by Git; `OXIDE_TEST_OUTPUT` changes the folder).
