# Oxide

Oxide is a desktop terminal app that knows your GitHub Projects. Developers open a
local Project, open as many clean terminals as they like in its folder, and run
whatever they want in them, an agent CLI included, with the Project's GitHub Issues,
pull requests and files at hand. Project and Terminal terminology is defined in
GLOSSARY.md.

## Who it is for

Oxide is for developers who live in the terminal and work on GitHub. It stays out of
the way: a Terminal is a plain shell that Oxide does not interpret, so any CLI works
as it does anywhere else. Oxide does not know about agents; if one is wanted, it is
a command typed in a Terminal. See ADR-0018.

## Platform

Desktop, built with Tauri. Windows is the user's current platform; existing native
functionality also targets macOS and Linux. Files and child processes belong to
Core, never to a webview filesystem or shell permission (ADR-0016).

## Workflows

The sidebar lists the open Projects and, under each, its Terminals; a New terminal
control on a Project opens a fresh shell in its folder. The centre of the window is
one large Terminal: the one selected in the sidebar. The right dock holds Issues
and Pull request. A Project's Files button in the sidebar opens its Files view;
opening a file shows the Project's Code workspace in a half beside the Terminal. Switching Terminals, tools or Projects
keeps scrollback, running processes, open files and unsaved changes. Settings opens
on an empty page, and Oxide has no custom keyboard shortcuts.

Python, C/C++, JavaScript/TypeScript and Rust are the first supported languages for
the editor. Opening the first file of a language offers to download its support, as
in Zed. Downloads happen only after Install is pressed.

## Stack

The established stack is Rust Core, a thin Tauri shell, and React/TypeScript.
The editor uses Monaco; terminal rendering uses the existing xterm integration.
Local language servers provide language intelligence without an extension system.

## Brand and interaction commitments

Oxide's identity is the Braces mark, always in Titanium, on warm Titanium neutral
surfaces. GitHub blue is for actions, focus and links and never appears in the
logo. The interface uses Inter; the editor and terminal use JetBrains Mono
with ligatures off. Keep the Octicons vocabulary. `assets/palette/` is the
source of truth for the colours.
Keep working controls compact and the primary content prominent. Use restrained
motion, honor reduced motion, and preserve keyboard access and visible focus.
