import { commands } from "./bindings";

/** Core refuses a link outside GitHub and the fixed documentation with this message prefix. */
const UNLISTED_PREFIX = "Unlisted link host: ";

/** The host Core wants confirmed, if this error is its "unlisted host" refusal. */
export function unlistedHost(message: string): string | null {
  return message.startsWith(UNLISTED_PREFIX) ? message.slice(UNLISTED_PREFIX.length) : null;
}

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
  if (result.status === "ok") return null;
  const host = unlistedHost(result.error.message);
  if (host === null) return result.error.message;
  if (!(await confirmHost({ url, host }))) return null;
  const confirmed = await commands.openConfirmedLink(url);
  return confirmed.status === "ok" ? null : confirmed.error.message;
}
