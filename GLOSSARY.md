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
A shell session in a Project's folder, shown in the centre of the window and listed under its Project in the sidebar. A Project holds as many as the user opens. Core owns each shell, never the webview, so switching to another Terminal and back shows the same scrollback and a still-running process keeps running. A Terminal can be renamed and closed from the sidebar. It is a plain shell that Oxide does not interpret: whatever the user runs in it, an agent CLI included, runs with no Oxide launch flags, prompts, statuses or permissions. Terminals end when the user closes them, when their Project closes or when Oxide quits; Oxide does not restore them after a restart. See ADR-0018.
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
The sidebar's other state: the file tree of one Project, with a Search files box and Collapse all folders, under the header "← Project name · Terminals" that returns to the Terminals view (Back to Terminals). It shows only the Project whose **Files button** opened it; a click selects a file and a double click (or Enter/Space) opens it in the **Code workspace**.
_Avoid_: Files panel, Files Surface, explorer, navigator

**Files button**:
The icon on a Project row in the Terminals view, next to + and ×, labelled "Open Files": it selects the Project and opens its Files view. Shown on hover and focus, and always on the selected Project.
_Avoid_: Files tab, Files switch

**Code workspace**:
The Project's editor, shown in the centre beside the Terminal while a file is open: Terminal on the left, Code workspace on the right, each half with a maximize/restore button. It owns the file tabs, Monaco and the language servers; the Files view opens files into it. Each Project keeps its own Code workspace, so moving between Projects or Terminals keeps the open buffers and unsaved changes, and remembers the split, divider and maximized half. Maximizing or a narrow centre hides the other half without closing it. Opening the first file of a language offers to download its language support; downloads happen only after Install is pressed.
_Avoid_: Editor pane, code tab, work mode

## Settings

**Settings**:
A tab that opens on an empty page. Every old option is gone and new ones are added deliberately, each with its own spec. Oxide has no custom keyboard shortcuts; the operating system's own keys and the terminal's own keys keep working.
