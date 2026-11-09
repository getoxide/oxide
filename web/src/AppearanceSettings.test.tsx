// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { AppearanceSettings } from "./AppearanceSettings";
import { DEFAULT_APPEARANCE, getAppearance, saveAppearance } from "./appearance";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); saveAppearance(structuredClone(DEFAULT_APPEARANCE)); });

it("lists the bundled families in every font picker and restores them", async () => {
  mockIPC((command) => {
    if (command === "system_fonts") return ["Arial"];
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<AppearanceSettings />));
  const picker = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label} font"]`)!;
  for (const label of ["Interface", "Chat", "Code editor", "Terminal"])
    expect(Array.from(picker(label).options).map((o) => o.textContent)).toEqual(expect.arrayContaining(["Inter (bundled)", "JetBrains Mono (bundled)", "Arial"]));
  expect(picker("Interface").selectedOptions[0].textContent).toBe("Inter (bundled)");
  expect(picker("Terminal").selectedOptions[0].textContent).toBe("JetBrains Mono (bundled)");
  await act(async () => { const select = picker("Terminal"); select.value = "Arial"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Apply appearance")!.click());
  expect(getAppearance().fonts.terminal).toBe("Arial");
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Restore defaults")!.click());
  expect(getAppearance().fonts).toEqual(DEFAULT_APPEARANCE.fonts);
  expect(picker("Terminal").selectedOptions[0].textContent).toBe("JetBrains Mono (bundled)");
});

it("offers installed fonts and saves family, size and weight without typing CSS", async () => {
  mockIPC((command) => {
    if (command === "system_fonts") return ["Arial", "Consolas", "Segoe UI"];
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<AppearanceSettings />));
  const family = container.querySelector<HTMLSelectElement>('select[aria-label="Terminal font"]');
  expect(family, "Font picker must be a working dropdown of installed fonts").not.toBeNull();
  expect(Array.from(family!.options).map((o) => o.textContent)).toContain("Consolas");
  for (const [label, value] of [["Terminal font", "Consolas"], ["Terminal size", "18"], ["Terminal weight", "700"]]) {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Apply appearance")!.click());
  expect(getAppearance().fonts.terminal).toBe("Consolas");
  expect(getAppearance()).toMatchObject({ typography: { terminal: { size: 18, weight: 700 } } });
});
