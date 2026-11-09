# Managed Project Services for local servers and background processes

Run local web servers, watchers and daemon processes as background Project Services, detached from the interactive terminal, with status in the sidebar and log streaming in the Terminal Surface.

## Background and problem

When a user or an agent starts a long-running process (such as `npm run dev`, `cargo run`, or `python -m http.server`), running it in an interactive Project terminal tab blocks the tab indefinitely. Running it from an agent Turn blocks the agent until timeout or interruption. Users need the terminal prompt free to continue running commands while keeping visibility into background server logs, port status, and process lifecycle.

## Decision

1. **Auto-detachment and interception**:
   - Commands recognized as dev servers/watchers or binding localhost ports, as well as explicit background commands (`&`), are detached into a **Project Service**.
   - In terminal tabs, a 1-2 second grace check ensures the process has not crashed immediately on startup; if healthy, the terminal prints a brief attachment confirmation with PID/URL and restores the prompt `$`. If it crashes immediately, output stays in the terminal.
   - For agent Turns, starting a Project Service detaches immediately, returning a success message to the agent (`[Oxide] Started Project Service '<command>' on http://localhost:<port> (PID <pid>)`), allowing the Turn to complete without hanging.

2. **Project scope and process hygiene**:
   - A Project Service belongs to the Project and records its originating checkout/worktree or Thread.
   - All Project Services are registered in Oxide's `ProcessRegistry` and terminated gracefully when stopped by the user or when the Project/Oxide window closes, preventing orphaned processes on local ports.
   - Port conflicts are detected before spawn, alerting the user and offering to focus or restart the existing service instead of failing with a collision.

3. **Presentation in Sidebar and Dock**:
   - The left sidebar hosts a compact, pinned **Services** section above Settings, displaying active Project Services with a status dot, detected localhost port, and quick stop button.
   - Clicking a service or selecting "View logs" focuses the Terminal Surface in the right dock (preserving ADR-0009's single Surfaces dock architecture), opening a dedicated, read-only tab with circular buffer log streaming, autoscroll, and controls for Restart, Stop, and Open URL in browser.

## Consequences

- Terminal tabs remain free for immediate commands without manually juggling extra tabs or background terminal jobs.
- Preserves ADR-0009: no new floating drawers or multiple docks are introduced; log inspection stays within the Terminal Surface in the right dock.
- Preserves ADR-0002 and ADR-0001: agent transcripts remain Oxide-owned, and agent providers are not modified or hung on long-running processes.
- The glossary defines **Project Service** under Layout.
