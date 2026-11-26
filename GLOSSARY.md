# Oxide

A desktop terminal app that knows your GitHub Projects: you open a Project, open as many clean terminals as you like in its folder and run whatever you want in them, with the Project's GitHub Issues, pull requests and files at hand. Oxide does not know about agents; an agent CLI is just a command typed in a terminal. See ADR-0018.

## Language

## Projects

**Project**:
A folder on the user's machine holding a Git repository, usually linked to a GitHub repository. The unit everything else belongs to.
_Avoid_: Workspace, repo (when meaning the Oxide concept)

**Open Project**:
A Project the user opened (from the Project palette, by adding or cloning it, or by selecting it), and so listed in the sidebar with its terminals. Repositories found by the scan of the scan roots are known but not open: the Project palette finds them, the sidebar does not list them. Closing a Project (Close project on its row menu) ends its terminals, takes it out of the sidebar and keeps it known.
_Avoid_: Pinned, recent, favourite Project

**Project palette**:
The overlay opened from the sidebar's Open a Project button. It searches Projects (clicking a result or pressing Enter opens the pick) and registers new ones: an existing folder, a new folder with `git init`, a clone from a Git URL, or a clone of one of the user's GitHub repositories found through `gh`. Project discovery does not depend on Settings: scan roots are built-in folders.
_Avoid_: Project switcher, quick open

## Terminals

**Terminal**:
A shell session in a Project's folder, shown in the centre of the window and listed under its Project in the sidebar. A Project holds as many as the user opens; the + beside a Project's name opens one. Core owns each shell, never the webview, so switching to another Terminal and back shows the same scrollback and a still-running process keeps running. A Terminal can be renamed in place from the sidebar (double-click, Force Click or Rename on its menu, as a file in the Finder) and closed there. Until it is renamed, its sidebar row shows the program a long-running command runs (`dnf` for `sudo dnf update`) and its default name again once the shell is idle; the name is a label read from the command line, not a status. The shell is the user's own zsh (with their startup files, so aliases, `PATH` and plugins load as in any terminal) where zsh is their login shell, else bash; PowerShell on Windows. Ctrl+C reaches the running program as a key, so a program that asks for a second Ctrl+C before quitting gets it. It is a plain shell that Oxide does not interpret: whatever the user runs in it, an agent CLI included, runs with no Oxide launch flags, prompts, statuses or permissions. Terminals end when the user closes them, when their Project closes or when Oxide quits. With **Session restore** on, the next launch reopens them with their names, folder and recent Command blocks, in new shells. See ADR-0018.
_Avoid_: Thread, session, console, tab, Agent terminal

**Command block**:
One command entered in a Terminal, grouped with its output and exit status. It belongs to a persistent shell session, so its working directory and shell variables carry into the next Command block.
_Avoid_: Turn, Thread, agent message

## Layout

**Surface**:
One of the two tools in the right dock: Issues or Pull request. They are plain GitHub tools: they list, show and create issues, and list, show, create, review and merge pull requests, through `gh`, with no action that sends anything to an agent. Files is not a Surface: it is the **Files view** of the sidebar.
_Avoid_: Tab, pane, widget

**Terminals view**:
The sidebar's default state: the Open Projects with their Terminals nested under each. A click on a Project name selects it and unfolds its Terminals, and on the active Project's name folds or unfolds them; the active Project is marked with an accent. Its hover/focus Files and `+` buttons open its **Files view** or a new Terminal; Close project is on its row menu.
_Avoid_: Terminals tab, Projects view

**Files view**:
The sidebar's other state: the file tree of one Project. The Files button on a Project row (or Open Files on its menu) opens it; its header, "← Project name · Terminals", returns to the **Terminals view**. A click selects a file and a double click (or Enter/Space) opens it in the **Code workspace**.
_Avoid_: Files panel, Files Surface, explorer, navigator

**Code workspace**:
The Project's editor, shown in the **Code half** of the centre beside the **Terminal half** while a file is open. Either half can be maximized and restored; maximizing or a narrow centre hides the other half without closing it. It owns the file tabs, Monaco and the language servers; the **Files view** opens files into it. Each Project keeps its own Code workspace, so moving between Projects or Terminals keeps the open buffers and unsaved changes, and remembers the split, divider and maximized half. Opening the first file of a language offers to download its language support; downloads happen only after Install is pressed. The language button in its status bar opens a popover to switch the buffer's language mode and to see, install or restart that language's server.
_Avoid_: Editor pane, code tab, work mode

**Terminal half** and **Code half**:
The two halves of the centre, side by side, with a draggable divider. The Terminal half holds the selected Terminal; the Code half exists only while the Project has a file open, so there is never an empty half. Each Project remembers its divider and its maximized half.
_Avoid_: Pane, panel, split view

## Settings

**Settings**:
A sectioned preferences page with **Appearance** (the built-in Oxide Dark or Oxide Light theme and the font, weight and size of the interface, the Code editor and the Terminal, applied as soon as they are chosen), **Terminal** (the shell new Terminals start and whether it loads the user's configuration), **Code** (Code workspace editor options), **Session** (**Session restore**), **Updates** (the installed version, the last check and the update install or command), **Shortcuts** (customizable VS Code-inspired keyboard shortcuts with strict **Terminal priority**), and **GitHub** (whether Git and the GitHub CLI are installed). When a Terminal has focus, bare `Ctrl+<letter>` and terminal control keys pass straight through to the PTY unless explicitly rebound in Settings. There is no Themes section: Oxide reads no theme files from disk.

**Session restore**:
A Settings switch, on by default. Oxide then reopens what was open when it quit: each Project's Terminals (names, the folder their shell was in and their last ten Command blocks, shown above a "Restored session" line, in new shells: programs that were running are not restarted) and its Code workspace with its files. Turning it off forgets the saved session.
_Avoid_: Workspace restore, persistence

**In-app update**:
How Oxide updates on macOS, Windows and the Linux AppImage: the **Update** button (in the titlebar, left of the Tools panel toggle, only while a newer release exists) or the Updates section downloads, verifies, installs and restarts Oxide. See ADR-0021.
_Avoid_: Auto-update, self-update

**Package install**:
Oxide installed from its `.deb` or `.rpm`, through APT or DNF. It never updates itself: the Update button and the Updates section show the package-manager command instead.
_Avoid_: System install, distro install
