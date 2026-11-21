# Files in the sidebar and a split Terminal | Code centre

Files leaves the right dock and becomes a view of the left sidebar. Opening a file splits the centre into the Terminal (left) and the Code workspace (right), instead of replacing the Terminals. This amends ADR-0018 (the dock no longer holds Files; the Code workspace no longer replaces the centre) and the Files parts of ADR-0009.

## Background

ADR-0018 left Oxide with a Terminal in the centre and a dock of Files, Issues and Pull request. Files was a navigator in the dock; a double click opened the Code workspace in place of the Terminals, with a Back to terminals button. The user could not read a file and watch a running command together, and the dock was sized for a file tree that Issues and Pull request do not need.

## Decision

- **Files view.** Files is no longer a Surface. The sidebar has two states: the **Terminals view** (Open Projects and their Terminals, as today) and the **Files view** of one Project. A **Files button** on each Project row (next to + and ×, shown on hover and focus, always on the selected row) opens the Files view; its header "← Project name · Terminals" returns. There is no Terminals/Files switch. The Files view shows only the Project whose button was pressed; reaching another Project's Terminal means going back first.
- **Project row.** A click on a Project name selects it; only the chevron collapses its Terminals.
- **Split centre.** A double click on a file opens it in the Code workspace on the right, 50/50 with a draggable divider; the Terminal stays on the left. A further file is a tab in the Code half. Closing the last file closes the Code half. With no Terminals the file fills the centre; there is never an empty half.
- **Maximize.** Each half has a maximize/restore button. Maximizing hides the other half without closing it: shell, scrollback, tabs and unsaved changes stay alive. Explicitly choosing the hidden half restores the split. No keyboard shortcuts.
- **Per Project.** The Code workspace belongs to the Project, not to a Terminal. Each Project remembers its split, divider and maximized half in the webview's UI state.
- **Fitting.** ADR-0009's rule stands: at compact width the dock and the sidebar suspend each other. A centre narrower than 720 px (two halves of 360 px) shows only the half chosen last, reusing the maximize mechanism. The dock gets no new behaviour.
- **Right dock.** Issues and Pull request only.

## Amendment: a Sidebar switch replaces the Files button

The Files button on the selected Project row read as a stray control beside the row, and the row's own fill stacked on the selected Terminal's. The sidebar now opens with a **Sidebar switch**, two tabs (Terminals and Files), and the Files view shows the selected Project. Project rows carry no fill and no buttons, so the selected Terminal is the only highlighted row. Open Files stays on a Project row's menu. This reverses the first rejected option below.

## Consequences

- **Surface** now means Issues or Pull request; **Code workspace** opens beside the Terminal. `GLOSSARY.md` gains **Terminals view**, **Files view** and **Files button**.
- At the minimum window width (`minWidth` 1064) with the dock open, Terminal and file are never visible together. Accepted.
- ADR-0009's "Files is a navigator" amendment is superseded for placement: the navigator is the Files view, not a dock Surface.
- The centre is at most Terminal | Code: no further splits, no top/bottom, no several editor groups.

## Considered options

- **A Terminals/Files switch at the top of the sidebar.** Rejected: drill-in from the Project row keeps today's sidebar as the default and needs no new control.
- **Files with every Open Project as a root.** Rejected: with two or three Projects the list is unmanageable.
- **A Project selector or a Terminals-like row at the top of the file tree.** Rejected: a Terminals-like row for a single-select changes the mechanism.
- **Auto-maximizing the half just opened at small widths as a new mechanism.** Rejected: the same maximize mechanism covers it.

The decisions are recorded in [the layout map (#523)](https://github.com/getoxide/oxide/issues/523) and its [spec (#530)](https://github.com/getoxide/oxide/issues/530).
