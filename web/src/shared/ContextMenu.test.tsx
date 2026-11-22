// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, showContextMenu } from "./ContextMenu";
import { revealInFileManagerLabel } from "./platform";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

afterEach(async () => {
  await act(async () => root.render(null));
});

function rightClick(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }));
  });
}

describe("platform labels", () => {
  it("adapts the Reveal in File Manager label to the OS", () => {
    expect(revealInFileManagerLabel("macos")).toBe("Reveal in Finder");
    expect(revealInFileManagerLabel("windows")).toBe("Reveal in File Explorer");
    expect(revealInFileManagerLabel("linux")).toBe("Open in File Manager");
  });
});

describe("ContextMenu", () => {
  it("shows Open a Project…, New terminal (when provided), and Settings on general areas", async () => {
    const openProject = vi.fn();
    const newTerminal = vi.fn();
    const openSettings = vi.fn();

    await act(async () => {
      root.render(
        <>
          <ContextMenu actions={{ openProject, newTerminal, openSettings }} />
          <div data-testid="blank">Blank</div>
        </>,
      );
    });

    rightClick(host.querySelector('[data-testid="blank"]')!);
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((b) => b.querySelector("span")?.textContent ?? b.textContent);
    expect(items).toEqual(["Open a Project…", "New terminal", "Settings"]);

    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click();
    });
    expect(newTerminal).toHaveBeenCalledOnce();
  });

  it("omits New terminal on general areas when no Project is selected", async () => {
    await act(async () => {
      root.render(
        <>
          <ContextMenu actions={{ openProject: vi.fn(), openSettings: vi.fn() }} />
          <div data-testid="blank">Blank</div>
        </>,
      );
    });

    rightClick(host.querySelector('[data-testid="blank"]')!);
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((b) => b.querySelector("span")?.textContent ?? b.textContent);
    expect(items).toEqual(["Open a Project…", "Settings"]);
  });

  it("supports replaceEdit and separatorBefore for custom editor/terminal menus", async () => {
    const customRun = vi.fn();
    await act(async () => {
      root.render(
        <>
          <ContextMenu actions={{ openProject: vi.fn(), openSettings: vi.fn() }} />
          <textarea
            data-testid="area"
            onContextMenu={(e) =>
              showContextMenu(
                e,
                [
                  { label: "Copy command", run: customRun },
                  { label: "Clear terminal", run: vi.fn(), separatorBefore: true },
                ],
                { replaceEdit: true },
              )
            }
          />
        </>,
      );
    });

    rightClick(host.querySelector('[data-testid="area"]')!);
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((b) => b.textContent);
    expect(items).toEqual(["Copy command", "Clear terminal"]);
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });
});
