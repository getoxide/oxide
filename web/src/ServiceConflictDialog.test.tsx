// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceConflictDialog } from "./ServiceConflictDialog";
import type { ProjectServiceConflict } from "./bindings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

const incumbent = {
  id: 9,
  projectId: 1,
  threadId: null,
  command: "npm run dev",
  checkout: "/alpha",
  status: "running" as const,
  pid: 900,
  port: 5173,
  url: "http://localhost:5173",
  startedAt: "2026-01-01T00:00:00Z",
  exitCode: null,
};

const owned: ProjectServiceConflict = {
  port: 5173,
  existing: incumbent,
  message: "Port 5173 is already used by Project Service 'npm run dev' (PID 900)",
};

const external: ProjectServiceConflict = {
  port: 5173,
  existing: null,
  message: "Port 5173 is already in use by another process",
};

afterEach(async () => {
  await act(async () => root.render(null));
});

const button = (text: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
    element.textContent?.includes(text),
  );

const render = async (
  conflict: ProjectServiceConflict,
  handlers: {
    onDismiss?: () => void;
    onSwitch?: (id: number) => void;
    onRestart?: (id: number) => void | Promise<void>;
  } = {},
) =>
  act(async () =>
    root.render(
      <ServiceConflictDialog
        conflict={conflict}
        onDismiss={handlers.onDismiss ?? (() => {})}
        onSwitch={handlers.onSwitch ?? (() => {})}
        onRestart={handlers.onRestart ?? (() => {})}
      />,
    ),
  );

it("names the incumbent command and PID, and switches to it", async () => {
  const onSwitch = vi.fn();
  await render(owned, { onSwitch });

  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(dialog?.textContent).toContain(
    "Port 5173 is already used by npm run dev (PID 900)",
  );

  const switchButton = button("Switch to active service");
  expect(switchButton).not.toBeUndefined();
  expect(document.activeElement).toBe(switchButton);
  await act(async () => switchButton!.click());
  expect(onSwitch).toHaveBeenCalledWith(9);
});

it("restarts the incumbent through the app callback", async () => {
  const onRestart = vi.fn(async () => {});
  await render(owned, { onRestart });

  await act(async () => button("Restart service")!.click());

  expect(onRestart).toHaveBeenCalledWith(9);
});

it("dismisses the dialog", async () => {
  const onDismiss = vi.fn();
  await render(owned, { onDismiss });

  await act(async () => button("Dismiss")!.click());

  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("closes on Escape", async () => {
  const onDismiss = vi.fn();
  await render(owned, { onDismiss });

  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );

  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("offers only dismissal when another process holds the port", async () => {
  const onDismiss = vi.fn();
  await render(external, { onDismiss });

  expect(container.textContent).toContain(
    "Port 5173 is already in use by another process",
  );
  expect(button("Switch to active service")).toBeUndefined();
  expect(button("Restart service")).toBeUndefined();
  const dismiss = button("Dismiss");
  expect(document.activeElement).toBe(dismiss);
  await act(async () => dismiss!.click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
