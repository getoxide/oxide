# Remove the Diff Surface and the Verification Dossier

Oxide no longer has a Diff Surface, a Verification Dossier or the attention bell. The right dock holds four Surfaces: Files, Terminal, Pull request and Issues.

## Background and problem

ADR-0010 bet that a computed Dossier and per-Turn diffs would shorten the path to a confident merge, and said to revisit the bet if the Dossier did not change what developers check. The Diff Surface was also the place where unrelated review actions piled up (commit, restore, revert, Blind review, Line comments, pull request file review), and the attention bell never worked reliably. Keeping all three cost code, tests and screen space for features the maintainer does not want.

## Decision

- **Remove the Diff Surface**, `/diff` and its shortcut, together with the Dossier, its publishing into pull request bodies, the Project verification-command and sensitive-path settings, and the attention bell and tray. The shortcut that jumps to the Thread waiting on the user stays.
- **Keep what the Diff Surface hosted that still earns its place, in new homes under the Thread header:** Commit and Commit & Push (a dialog), Restore and Undo restore (a dialog over the Thread's Checkpoints), Blind review (a dialog) and its findings, and the Line comment drafts that a kept finding creates.
- **Drop what only the Diff Surface could do:** writing Line comments by clicking a diff line, reverting a file or hunk, and reviewing a pull request's files with draft inline comments submitted as a GitHub review. The Pull request Surface still reads review threads, fixes failing checks and merges.
- **Drop the data only they used:** a migration removes the Project sensitive paths, the Turns' `head_before` and `head_after`, the pull request draft comments table and the stored Dossier disclosure choices.

## Consequences

- ADR-0010's ordering of features is unchanged, but its Dossier-specific parts are history. ADR-0009 still holds with four Surfaces instead of five.
- Checkpoints remain: they back Restore and Blind review of a Turn.
- Bringing a diff view back would be a new decision, not a revert of this one.
