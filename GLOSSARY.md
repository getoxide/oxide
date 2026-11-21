# Oxide

A desktop terminal app that knows your GitHub Projects: you open a Project, open as many clean terminals as you like in its folder and run whatever you want in them, with the Project's GitHub Issues, pull requests and files at hand. Oxide does not know about agents; an agent CLI is just a command typed in a terminal. See ADR-0018.

## Language

## Projects

**Project**:
A folder on the user's machine holding a Git repository, usually linked to a GitHub repository. The unit everything else belongs to.
_Avoid_: Workspace, repo (when meaning the Oxide concept)

**Open Project**:
A Project the user opened (from the Project palette, by adding or cloning it, or by selecting it), and so listed in the sidebar with its terminals. Repositories found by the scan of the scan roots are known but not open: the Project palette finds them, the sidebar does not list them. Closing a Project ends its terminals, takes it out of the sidebar and keeps it known.
_Avoid_: Pinned, recent, favourite Project

**Project palette**:
The overlay opened from the sidebar's Open a Project button. It searches Projects (clicking a result or pressing Enter opens the pick) and registers new ones: an existing folder, a new folder with `git init`, a clone from a Git URL, or a clone of one of the user's GitHub repositories found through `gh`. Project discovery does not depend on Settings: scan roots are built-in folders.
_Avoid_: Project switcher, quick open

## Terminals

**Terminal**:
A shell session in a Project's folder, shown in the centre of the window and listed under its Project in the sidebar. A Project holds as many as the user opens. Core owns each shell, never the webview, so switching to another Terminal and back shows the same scrollback and a still-running process keeps running. A Terminal can be renamed in place from the sidebar (double-click, Force Click or Rename on its menu, as a file in the Finder) and closed there. The shell is the user's own zsh (with their startup files, so aliases, `PATH` and plugins load as in any terminal) where zsh is their login shell, else bash; PowerShell on Windows. Ctrl+C reaches the running program as a key, so a program that asks for a second Ctrl+C before quitting gets it. It is a plain shell that Oxide does not interpret: whatever the user runs in it, an agent CLI included, runs with no Oxide launch flags, prompts, statuses or permissions. Terminals end when the user closes them, when their Project closes or when Oxide quits; Oxide does not restore them after a restart. See ADR-0018.
_Avoid_: Thread, session, console, tab, Agent terminal

**Command block**:
One command entered in a Terminal, grouped with its output and exit status. It belongs to a persistent shell session, so its working directory and shell variables carry into the next Command block.
_Avoid_: Turn, Thread, agent message

## Layout

**Surface**:
One of the two tools in the right dock: Issues or Pull request. They are plain GitHub tools: they list, show and create issues, and list, show, create, review and merge pull requests, through `gh`, with no action that sends anything to an agent. Files is not a Surface: it is the **Files view** of the sidebar.
_Avoid_: Tab, pane, widget

**Terminals view**:
The sidebar's default state: the Open Projects with their Terminals. A Project name selects it; only its chevron collapses its Terminals.
_Avoid_: Terminals tab, Projects view

**Files view**:
The sidebar's other state: the file tree of the selected Project, under its name. The **Sidebar switch** opens it and returns to the Terminals view; so does Open Files on a Project row's menu. A click selects a file and a double click (or Enter/Space) opens it in the **Code workspace**.
_Avoid_: Files panel, Files Surface, explorer, navigator

**Sidebar switch**:
The two tabs at the top of the sidebar, Terminals and Files, that choose its view. Files shows the selected Project and is disabled while no Project is selected or its folder is missing.
_Avoid_: Files button, Back to Terminals

**Code workspace**:
The Project's editor, shown in the **Code half** of the centre beside the **Terminal half** while a file is open. Either half can be maximized and restored; maximizing or a narrow centre hides the other half without closing it. It owns the file tabs, Monaco and the language servers; the **Files view** opens files into it. Each Project keeps its own Code workspace, so moving between Projects or Terminals keeps the open buffers and unsaved changes, and remembers the split, divider and maximized half. Opening the first file of a language offers to download its language support; downloads happen only after Install is pressed.
_Avoid_: Editor pane, code tab, work mode

**Terminal half** and **Code half**:
The two halves of the centre, side by side, with a draggable divider. The Terminal half holds the selected Terminal; the Code half exists only while the Project has a file open, so there is never an empty half. Each Project remembers its divider and its maximized half.
_Avoid_: Pane, panel, split view

## Settings

**Settings**:
A page with Appearance (the theme and the font, weight and size of the interface, the Code editor and the Terminal, applied as soon as they are chosen) and GitHub (whether Git and the GitHub CLI are installed). New options are added deliberately. Oxide has no custom keyboard shortcuts; the operating system's own keys and the terminal's own keys keep working.
