export type PanelBounds = { value: number; min: number; max: number };

/** Narrowest the tools panel can get before the merge footer (three buttons + gear) no longer fits. */
const TOOLS_MIN = 496;

function panelBounds(preferred: number | null, fallback: number, min: number, max: number): PanelBounds {
  const upper = Math.max(min, Math.floor(max));
  return { value: Math.round(Math.min(upper, Math.max(min, preferred ?? fallback))), min, max: Math.floor(upper) };
}

/** Fit visible panels without overwriting the user's preferred wide-window sizes. */
export function workspaceLayout(
  width: number,
  preferred: { sidebar: number | null; tools: number | null },
  toolsRequested: boolean,
  options: { sidebarVisible?: boolean; priority?: "sidebar" | "tools"; maximized?: boolean } = {},
) {
  const centreMin = 360;
  const sidebarMin = 160;
  const compact = width < sidebarMin + TOOLS_MIN + centreMin;
  const maximized = toolsRequested && options.maximized === true;
  const sidebarRequested = options.sidebarVisible !== false;
  const toolsVisible = toolsRequested && !(compact && sidebarRequested && options.priority === "sidebar") || maximized;
  const sidebarVisible = sidebarRequested && !maximized && !(compact && toolsVisible);
  const toolsMin = toolsVisible && !maximized ? TOOLS_MIN : 0;
  const sidebar = panelBounds(preferred.sidebar, width <= 1100 ? 208 : 240, sidebarMin,
    Math.min(400, width - toolsMin - centreMin));
  const tools = panelBounds(preferred.tools, Math.min(600, Math.max(TOOLS_MIN, width * 0.32)), TOOLS_MIN,
    Math.min(800, width - (sidebarVisible ? sidebar.value : 0) - (maximized ? 32 : centreMin)));
  // During drag each panel must also respect the other panel's current size.
  sidebar.max = Math.floor(Math.max(sidebarMin, Math.min(400, width - (toolsVisible ? tools.value : 0) - centreMin)));
  if (maximized) tools.value = tools.max = Math.max(TOOLS_MIN, width - 32);
  return { sidebar, tools, sidebarVisible, toolsVisible };
}
