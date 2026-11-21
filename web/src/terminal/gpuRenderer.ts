import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

/** The webview keeps only a few WebGL contexts alive at once; the newest Command blocks keep theirs. */
export const GPU_RENDERER_LIMIT = 12;
const active: { addon: WebglAddon }[] = [];

/**
 * Draws `terminal` with WebGL. Box-drawing and block characters become glyphs that fill the
 * whole cell, so vertical bars and frames join up between rows where the DOM renderer, which
 * draws them with the font, leaves a gap on every line. Without WebGL (or once the context is
 * lost or handed to a newer block) the DOM renderer takes over. Returns the release function.
 */
export function attachGpuRenderer(terminal: Terminal): () => void {
  let addon: WebglAddon;
  try {
    addon = new WebglAddon();
    terminal.loadAddon(addon);
  } catch {
    return () => {};
  }
  const entry = { addon };
  const release = () => {
    const index = active.indexOf(entry);
    if (index < 0) return;
    active.splice(index, 1);
    addon.dispose();
  };
  addon.onContextLoss(release);
  active.push(entry);
  while (active.length > GPU_RENDERER_LIMIT) active.shift()!.addon.dispose();
  return release;
}
