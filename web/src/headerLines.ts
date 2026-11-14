import type { ModelInfo } from "./bindings";
import { modelFamilyId } from "./modelPicker";

/** Remove Windows extended-length syntax for presentation and shell prompts. */
export function readablePath(path: string): string {
  const slash = String.fromCharCode(92);
  const prefix = slash + slash + "?" + slash;
  if (path.startsWith(prefix + "UNC" + slash)) return slash + slash + path.slice(8);
  if (path.startsWith(prefix) && /^[A-Za-z]:/.test(path.slice(4))) return path.slice(4);
  return path;
}

/** The home directory shortened to `~`. */
export const displayPath = (path: string) => readablePath(path).replace(/^\/(Users|home)\/[^/]+/, "~");

/** Cuts a long path in the middle so the start and, above all, the folder name survive. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor((max - 1) / 3);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
  antigravity: "Antigravity",
};

export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

/** A catalog name can spell out the Effort, "Gemini 3.8 Flash (High)" or "Gemini 3.8 Flash - High". */
const EFFORT_SUFFIX = /\s*(?:[(·-]\s*|\s+)(low|medium|high|xhigh|max)\)?\s*$/i;

/** The Effort level a Model id or name ends with, lowercased, if any. */
export function effortSuffix(name: string): string | null {
  const match = EFFORT_SUFFIX.exec(name.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Drops an Effort the Model's name already carries, since the header shows the Effort on its own. */
export function stripEffortSuffix(name: string): string {
  return name.replace(EFFORT_SUFFIX, "").trim();
}

const ACRONYMS = new Set(["ai", "api", "cli", "gpt", "llm", "ui"]);

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `gemini-3.8-flash-low` → `Gemini 3.8 Flash`: the last resort when the catalog has no name. */
export function humanizeModelId(model: string): string {
  const words = stripEffortSuffix(model).split(/[-_\s]+/).filter(Boolean);
  const parts: string[] = [];
  for (const word of words) {
    const previous = parts[parts.length - 1];
    if (/^\d+$/.test(word) && previous !== undefined && /^\d+$/.test(previous)) {
      parts[parts.length - 1] = `${previous}.${word}`;
    } else {
      parts.push(capitalizeWord(word));
    }
  }
  return parts.join(" ");
}

/** How an Effort reads in a header: "Low", "Medium", "High", "Max". */
export function effortLabel(effort: string): string {
  const level = effort.trim().toLowerCase();
  if (!level) return "";
  if (level === "xhigh") return "Extra High";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function readableModel(model: string, catalog: ModelInfo[] | null): string {
  const exact = catalog?.find((m) => m.id === model);
  const family = modelFamilyId(model);
  const name = exact?.name ?? catalog?.find((m) => modelFamilyId(m.id) === family)?.name;
  return stripEffortSuffix(name ?? humanizeModelId(model));
}

/** The Effort a Model id or catalog name carries, for a Thread that has no separate value. */
export function effortFromModel(model: string, catalog: ModelInfo[] | null): string | null {
  const exact = catalog?.find((m) => m.id === model);
  const family = modelFamilyId(model);
  const familyName = catalog?.find((m) => modelFamilyId(m.id) === family)?.name;
  return (
    effortSuffix(model) ??
    (exact ? effortSuffix(exact.name) : null) ??
    (familyName ? effortSuffix(familyName) : null)
  );
}
