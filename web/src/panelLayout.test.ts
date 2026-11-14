import { expect, it } from "vitest";
import { workspaceLayout } from "./panelLayout";

it("reserves a readable Thread with both panels visible at every supported width", () => {
  for (const width of [1064, 1280, 1920]) {
    for (const sidebar of [null, 160, 208, 400, 9000]) {
      for (const tools of [null, 496, 800, 9000]) {
        const layout = workspaceLayout(width, { sidebar, tools }, true);
        expect(width - layout.sidebar.value - layout.tools.value).toBeGreaterThanOrEqual(360);
        for (const panel of [layout.sidebar, layout.tools]) {
          expect(panel.value).toBeGreaterThanOrEqual(panel.min);
          expect(panel.value).toBeLessThanOrEqual(panel.max);
        }
        expect("terminal" in layout).toBe(false);
      }
    }
  }
});

it("restores preferred wide-window dimensions after a temporary narrow fit", () => {
  const preferred = { sidebar: 400, tools: 800 };
  const narrow = workspaceLayout(1064, preferred, true);
  expect(narrow.sidebar.value).toBe(208);
  expect(narrow.tools.value).toBe(496);
  const wide = workspaceLayout(1920, preferred, true);
  expect(wide.sidebar.value).toBe(400);
  expect(wide.tools.value).toBe(800);
  expect(preferred).toEqual({ sidebar: 400, tools: 800 });
});

it("does not reserve hidden Tools space in Settings or a focused workspace", () => {
  const preferred = { sidebar: 400, tools: 800 };
  const layout = workspaceLayout(1064, preferred, false);
  expect(layout.sidebar.value).toBe(400);
  expect(layout.sidebar.max).toBe(400);
  expect(workspaceLayout(1064, preferred, true).sidebar.value).toBe(208);
});

it("collapses the sidebar before the Thread shrinks below 360px at the minimum window", () => {
  const fit = workspaceLayout(900, { sidebar: 300, tools: 700 }, true);
  expect(fit.sidebarVisible).toBe(false);
  expect(fit.toolsVisible).toBe(true);
  expect(900 - fit.tools.value).toBeGreaterThanOrEqual(360);
});

it("clamps the sidebar to its 160px minimum", () => {
  for (const width of [1064, 1280, 1920]) {
    const tight = workspaceLayout(width, { sidebar: 100, tools: null }, false);
    expect(tight.sidebar.min).toBe(160);
    expect(tight.sidebar.value).toBe(160);
    const atMinimum = workspaceLayout(width, { sidebar: 160, tools: null }, false);
    expect(atMinimum.sidebar.value).toBe(160);
  }
});

it("honours the 160px minimum beside both panels at the compact boundary", () => {
  const fit = workspaceLayout(1016, { sidebar: 100, tools: 700 }, true);
  expect(fit.sidebarVisible).toBe(true);
  expect(fit.toolsVisible).toBe(true);
  expect(fit.sidebar.value).toBe(160);
  expect(1016 - fit.sidebar.value - fit.tools.value).toBeGreaterThanOrEqual(360);
});

it("collapses the sidebar at tiny widths instead of overflowing below its 160px minimum", () => {
  const fit = workspaceLayout(880, { sidebar: 100, tools: 700 }, true);
  expect(fit.sidebar.min).toBe(160);
  expect(fit.sidebarVisible).toBe(false);
  expect(fit.toolsVisible).toBe(true);
  expect(880 - fit.tools.value).toBeGreaterThanOrEqual(360);
});

it("gives an explicitly opened sidebar priority at compact widths without losing requested tools", () => {
  const preferred = { sidebar: 300, tools: 700 };
  const fit = workspaceLayout(900, preferred, true, { priority: "sidebar" });
  expect(fit.sidebarVisible).toBe(true);
  expect(fit.toolsVisible).toBe(false);
  const wide = workspaceLayout(1440, preferred, true, { priority: "sidebar" });
  expect(wide.sidebarVisible).toBe(true);
  expect(wide.toolsVisible).toBe(true);
  expect(preferred).toEqual({ sidebar: 300, tools: 700 });
});
