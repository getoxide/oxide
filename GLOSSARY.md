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
One of the two tools in the right dock: Issues or Pull request. They are plain GitHub tools: they list, show and create issues, and list, show, create, review and merge pull requests, through `gh`, with no action that sends anything to an agent.
_Avoid_: Tab, pane, widget

**Code workspace**:
The Project's editor, shown in the **Code half** of the centre beside the **Terminal half** while a file is open. Either half can be maximized and restored. It owns the file tabs, Monaco and the language servers; the **Files view** opens files into it. Each Project keeps its own Code workspace, so moving between Projects keeps the open buffers and unsaved changes. Opening the first file of a language offers to download its language support; downloads happen only after Install is pressed.
_Avoid_: Editor pane, code tab, work mode

**Terminal half** and **Code half**:
The two halves of the centre, side by side, with a draggable divider. The Terminal half holds the selected Terminal; the Code half exists only while the Project has a file open, so there is never an empty half. Each Project remembers its divider and its maximized half.
_Avoid_: Pane, panel, split view

**Files view**:
The sidebar view that replaces the Projects list for one Project: it browses the Project's folder and opens files in the Code half. A button at its top goes back to the Terminals. It is a navigator, not an editor.
_Avoid_: Files Surface, file explorer

## Settings

**Settings**:
A tab that opens on an empty page. Every old option is gone and new ones are added deliberately, each with its own spec. Oxide has no custom keyboard shortcuts; the operating system's own keys and the terminal's own keys keep working.
