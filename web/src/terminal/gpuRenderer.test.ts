import { expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const addons: { disposed: boolean; lose?: () => void }[] = [];
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    state = { disposed: false as boolean, lose: undefined as (() => void) | undefined };
    constructor() { addons.push(this.state); }
    onContextLoss(callback: () => void) { this.state.lose = callback; }
    dispose() { this.state.disposed = true; }
  },
}));
const { attachGpuRenderer, GPU_RENDERER_LIMIT } = await import("./gpuRenderer");
const terminal = (fails = false) => ({ loadAddon: () => { if (fails) throw new Error("WebGL2 not supported"); } }) as unknown as Terminal;

it("keeps WebGL on the newest blocks only, and lets a lost context fall back", () => {
  const releases = Array.from({ length: GPU_RENDERER_LIMIT + 2 }, () => attachGpuRenderer(terminal()));
  expect(addons.map((addon) => addon.disposed)).toEqual([true, true, ...Array(GPU_RENDERER_LIMIT).fill(false)]);
  addons.at(-1)!.lose!();
  expect(addons.at(-1)!.disposed).toBe(true);
  releases[2]();
  expect(addons[2].disposed).toBe(true);
  // Releasing twice, or after eviction, is harmless.
  releases[0]();
  releases[2]();
  expect(attachGpuRenderer(terminal(true))).toBeTypeOf("function");
});
