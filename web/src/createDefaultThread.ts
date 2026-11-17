import { commands } from "./bindings";

/**
 * Read Settings at creation time so every entry point uses the current defaults.
 *
 * With `terminal` and the "Open new Threads as terminals" preview on, the Thread's centre is an
 * Agent terminal running Claude Code (ADR-0017). Flows that send a prompt (Fix, Issues) pass
 * nothing and keep the chat Thread until their own slice moves them.
 */
export async function createDefaultThread(projectId: number, options: { terminal?: boolean } = {}) {
  const { settings } = await commands.getSettings();
  if (options.terminal && settings.openThreadsAsTerminals) return commands.createTerminalThread(projectId);
  const provider = settings.defaultProvider || "claude";
  const defaults = settings.providers[provider];
  return commands.createThread(
    projectId,
    provider,
    defaults?.model ?? null,
    defaults?.effort ?? null,
    defaults?.permissionMode ?? null,
  );
}
