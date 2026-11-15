import type { ModelInfo } from "./bindings";

/**
 * The Effort names the Providers' catalogs have declared so far. Nothing here is a fixed list:
 * Oxide only recognises an Effort in a Model id or name (`…-xhigh`, `(High)`) once a catalog has
 * said that level exists, so a new level in a Provider's catalog is picked up as it appears.
 */
const STORAGE_KEY = "oxide:effort-vocabulary";
const known = new Set<string>();

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  if (Array.isArray(saved)) for (const level of saved) if (typeof level === "string") known.add(level);
} catch { /* A cold start just waits for the first catalog. */ }

/** Remembers every Effort the catalog declares. Idempotent and cheap, so it can run on each catalog. */
export function learnEfforts(models: readonly ModelInfo[]): void {
  let grew = false;
  for (const model of models) {
    for (const effort of model.supportedEfforts) {
      const level = normalise(effort);
      if (level && !known.has(level)) { known.add(level); grew = true; }
    }
  }
  if (!grew) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...known])); } catch { /* Memory only. */ }
}

/** The declared Effort `text` spells (ignoring case and separators: "X-High" is "xhigh"), if any. */
export function declaredEffort(text: string): string | null {
  const level = normalise(text);
  return known.has(level) ? level : null;
}

/** The Effort a Model id ends with (`gemini-4-hydrogen-xhigh`), as written in the id. */
export function effortOfId(id: string): string | null {
  const at = id.lastIndexOf("-");
  const tail = at < 0 ? "" : id.slice(at + 1);
  return declaredEffort(tail) ? tail : null;
}

/** `gemini-4-hydrogen-xhigh` → `gemini-4-hydrogen`: the id with any trailing declared Effort removed. */
export function stripEffortFromId(id: string): string {
  return effortOfId(id) === null ? id : id.slice(0, id.lastIndexOf("-"));
}

const NAME_QUALIFIER = /\s*(?:\(([^()]+)\)|[·-]\s*([^\s·()-]+)|\s([^\s()]+))\s*$/;

/** The Effort a catalog name ends with (`Gemini (High)`, `Gemini - High`, `Gemini High`), if any. */
export function effortOfName(name: string): string | null {
  const match = NAME_QUALIFIER.exec(name.trim());
  const text = match?.[1] ?? match?.[2] ?? match?.[3];
  return text !== undefined && declaredEffort(text) ? declaredEffort(text) : null;
}

/** A catalog name without the Effort it spells out. */
export function stripEffortFromName(name: string): string {
  const trimmed = name.trim();
  return effortOfName(trimmed) === null ? trimmed : trimmed.replace(NAME_QUALIFIER, "").trim();
}
