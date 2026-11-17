import type { ModelInfo, PermissionMode } from "./bindings";
import { resolveFavourite } from "./modelPicker";

/**
 * The Providers whose own CLI Oxide can start in an Agent terminal (ADR-0017). A Provider joins
 * the Model picker as a launch target by being added here once Core has its launch recipe.
 */
export const LAUNCH_RECIPES: readonly string[] = ["claude", "codex"];

/**
 * The Permission modes each Provider's CLI can honour at launch. Codex and Antigravity CLI have
 * no mode that asks before every edit, so Ask is not offered for them.
 */
const PERMISSION_MODES: Record<string, PermissionMode[]> = {
  claude: ["ask", "auto-edit", "full-access"],
  codex: ["auto-edit", "full-access"],
  antigravity: ["auto-edit", "full-access"],
};

/** The installed Providers that have a launch recipe, in recipe order. */
export function launchableProviders(installed: ReadonlyMap<string, boolean>): string[] {
  return LAUNCH_RECIPES.filter((provider) => installed.get(provider) === true);
}

/**
 * What a Permission mode means for a Provider when it is not what its name suggests. Codex's
 * Auto-edit is a workspace-write sandbox, so commands inside the workspace run without asking.
 */
export function permissionModeNote(provider: string, mode: PermissionMode): string | null {
  if (provider === "codex" && mode === "auto-edit") return "Commands inside the workspace run without asking. Edits outside it ask first.";
  return null;
}

export function permissionModesFor(provider: string): PermissionMode[] {
  return PERMISSION_MODES[provider] ?? ["auto-edit"];
}

/** The next (or previous) Permission mode `provider` can honour; a mode it can't honour moves to its first. */
export function nextPermissionMode(provider: string, current: PermissionMode | null, delta: 1 | -1): PermissionMode {
  const modes = permissionModesFor(provider);
  const at = current ? modes.indexOf(current) : -1;
  if (at === -1) return modes[0]!;
  return modes[(at + delta + modes.length) % modes.length]!;
}

export interface LaunchChoice {
  provider: string;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
}

/** What starting a Thread means: the wanted Permission mode when the Provider can honour it. */
export function launchChoice(
  provider: string,
  model: string | null,
  effort: string | null,
  wanted: PermissionMode | null,
): LaunchChoice {
  const modes = permissionModesFor(provider);
  const permissionMode = wanted && modes.includes(wanted) ? wanted : modes.includes("auto-edit") ? "auto-edit" : modes[0]!;
  return { provider, model, effort, permissionMode };
}

/** Favourite number `index` (1-based), among the Providers that can launch, as a launch choice. */
export function resolveLaunchFavourite(
  index: number,
  catalogs: Record<string, ModelInfo[]>,
  favourites: string[],
  launchable: string[],
  defaultMode: PermissionMode | null,
): LaunchChoice | null {
  const offered = Object.fromEntries(Object.entries(catalogs).filter(([provider]) => launchable.includes(provider)));
  const target = resolveFavourite(index, offered, favourites, null, launchable[0] ?? "claude");
  return target ? launchChoice(target.provider, target.model, target.effort, defaultMode) : null;
}
