import { commands } from "./bindings";

export interface LinkConfirmation {
  url: string;
  host: string;
}

let pending: LinkConfirmation | null = null;
let settle: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();

export function subscribeLinkConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function currentLinkConfirmation(): LinkConfirmation | null {
  return pending;
}
function setPending(next: LinkConfirmation | null) {
  pending = next;
  listeners.forEach((listener) => listener());
}

/** The user's answer to the open confirmation; no-op when none is showing. */
export function answerLinkConfirmation(confirmed: boolean) {
  const done = settle;
  settle = null;
  setPending(null);
  done?.(confirmed);
}

function confirmHost(link: LinkConfirmation): Promise<boolean> {
  settle?.(false);
  return new Promise((resolve) => {
    settle = resolve;
    setPending(link);
  });
}

/** Opens a link in the system browser. GitHub and the fixed documentation open directly; any
 *  other host is shown in full and opens only once the user confirms it. Resolves to an error
 *  message, or null when the link opened or the user declined. */
export async function openExternalLink(url: string): Promise<string | null> {
  const result = await commands.openLink(url);
  if (result.status === "error") return result.error.message;
  // `null`: opened. A string: the host (and port) of a link Core did not open until confirmed.
  const host = result.data;
  if (host === null) return null;
  if (!(await confirmHost({ url, host }))) return null;
  const confirmed = await commands.openConfirmedLink(url);
  return confirmed.status === "ok" ? null : confirmed.error.message;
}
