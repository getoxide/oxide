// @vitest-environment jsdom
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

interface MockModel {
  uri: { path: string; toString: () => string };
  getValue: ReturnType<typeof vi.fn<() => string>>;
  setValue: ReturnType<typeof vi.fn<(next: string) => void>>;
  getAlternativeVersionId: () => number;
  getLanguageId: () => string;
  /** Set by the harness's monaco.editor.setModelLanguage. */
  __language: string;
  onDidChangeContent: (cb: () => void) => { dispose: () => void };
  dispose: () => void;
  /** Test helpers to simulate typing and undo at the Monaco boundary. */
  __edit: (next: string) => void;
  __undoTo: (versionId: number, content: string) => void;
}

const monacoHarness = vi.hoisted(() => {
  const models: MockModel[] = [];
  const createCalls: Record<string, unknown>[] = [];
  const updateOptionsCalls: Array<Array<Record<string, unknown>>> = [];
  let currentModel: MockModel | null = null;
  let position = { lineNumber: 1, column: 1 };
  let createOptions: Record<string, unknown> | null = null;
  let selectionEmpty = false;
  const cursorListeners = new Set<(e: { position: { lineNumber: number; column: number } }) => void>();
  const contextMenuListeners = new Set<(e: { event: { browserEvent: MouseEvent } }) => void>();
  const actions: Record<string, { isSupported?: () => boolean; run: ReturnType<typeof vi.fn> }> = {};
  const triggerSpy = vi.fn();

  const makeModel = (initial: string, lang: string, uri: { path: string; toString: () => string }): MockModel => {
    let text = initial;
    let altVersion = 1;
    let nextVersion = 2;
    const listeners = new Set<() => void>();
    const model: MockModel = {
      uri,
      getValue: vi.fn(() => text),
      setValue: vi.fn((next: string) => {
        text = next;
        altVersion = nextVersion++;
        for (const cb of listeners) cb();
      }),
      getAlternativeVersionId: () => altVersion,
      __language: lang,
      getLanguageId: () => model.__language,
      onDidChangeContent: (cb) => {
        listeners.add(cb);
        return { dispose: () => listeners.delete(cb) };
      },
      dispose: () => listeners.clear(),
      __edit: (next: string) => {
        text = next;
        altVersion = nextVersion++;
        for (const cb of listeners) cb();
      },
      __undoTo: (versionId: number, content: string) => {
        text = content;
        altVersion = versionId;
        for (const cb of listeners) cb();
      },
    };
    models.push(model);
    return model;
  };

  return {
    models,
    get createOptions() { return createOptions; },
    setSelectionEmpty(empty: boolean) { selectionEmpty = empty; },
    actions,
    triggerSpy,
    emitContextMenu(browserEvent: MouseEvent) {
      for (const cb of contextMenuListeners) cb({ event: { browserEvent } });
    },
    createCalls,
    updateOptionsCalls,
    reset() {
      models.length = 0;
      createCalls.length = 0;
      updateOptionsCalls.length = 0;
      currentModel = null;
      position = { lineNumber: 1, column: 1 };
      createOptions = null;
      selectionEmpty = false;
      cursorListeners.clear();
      contextMenuListeners.clear();
      for (const key of Object.keys(actions)) delete actions[key];
      triggerSpy.mockReset();
    },
    emitCursor(lineNumber: number, column: number) {
      position = { lineNumber, column };
      for (const cb of cursorListeners) cb({ position });
    },
    monaco: {
      MarkerSeverity: { Error: 8, Warning: 4 },
      languages: {
        getLanguages: () => [
          { id: "plaintext", aliases: ["Plain Text", "text"] },
          { id: "typescript", aliases: ["TypeScript", "ts"] },
          { id: "json", aliases: ["JSON", "json"] },
          { id: "python", aliases: ["Python", "py"] },
        ],
      },
      Uri: {
        file: (path: string) => ({ path, toString: () => `file://${path}` }),
      },
      editor: {
        create: (_el: HTMLElement, options: Record<string, unknown>) => {
          createOptions = options;
          const instanceIndex = createCalls.length;
          createCalls.push(options);
          const updates: Record<string, unknown>[] = [];
          updateOptionsCalls.push(updates);
          return {
            setModel: (m: MockModel | null) => { currentModel = m; },
            getModel: () => currentModel,
            saveViewState: () => null,
            restoreViewState: () => {},
            setSelection: () => {},
            getSelection: () => ({ isEmpty: () => selectionEmpty }),
            revealRangeInCenter: () => {},
            focus: () => {},
            layout: () => {},
            hasTextFocus: () => false,
            getPosition: () => position,
            onDidChangeCursorPosition: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => {
              cursorListeners.add(cb);
              return { dispose: () => cursorListeners.delete(cb) };
            },
            onContextMenu: (cb: (e: { event: { browserEvent: MouseEvent } }) => void) => {
              contextMenuListeners.add(cb);
              return { dispose: () => contextMenuListeners.delete(cb) };
            },
            updateOptions: (next: Record<string, unknown>) => {
              updateOptionsCalls[instanceIndex].push(next);
            },
            trigger: triggerSpy,
            getAction: (id: string) => actions[id] ?? null,
            dispose: () => { cursorListeners.clear(); contextMenuListeners.clear(); },
          };
        },
        createModel: makeModel,
        setModelLanguage: (m: MockModel, language: string) => { m.__language = language; },
        setModelMarkers: () => {},
        onDidChangeMarkers: () => ({ dispose: () => {} }),
        getModelMarkers: () => [],
        registerEditorOpener: () => ({ dispose: () => {} }),
      },
    },
  };
});

vi.mock("./editorRuntime", () => ({
  monaco: monacoHarness.monaco,
  editorLanguage: () => "typescript",
  serverLanguage: (language: string) =>
    ({ typescript: "typescript", javascript: "typescript", python: "python", rust: "rust", c: "cpp", cpp: "cpp" })[language] ?? null,
}));

/** What the workbench asked of its language sessions, and a way to report a server's state back. */
const lsp = vi.hoisted(() => ({
  events: [] as string[],
  /** Each reconnect's language; "all" for every server. */
  reconnects: [] as string[],
  report: (() => {}) as (language: string, state: string) => void,
  reset() {
    this.events.length = 0;
    this.reconnects.length = 0;
  },
}));
vi.mock("./editorLanguages", () => ({
  EditorLanguages: class {
    constructor(_projectId: number, onState: (language: string, state: string) => void) {
      lsp.report = onState;
    }
    add(model: MockModel) { lsp.events.push(`add ${model.getLanguageId()}`); }
    changed() {}
    saved() {}
    remove(model: MockModel) { lsp.events.push(`remove ${model.getLanguageId()}`); }
    reconnect(language?: string) { lsp.reconnects.push(language ?? "all"); }
    dispose() {}
  },
}));

const treeRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./EditorFileTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./EditorFileTree")>();
  const raw = actual.EditorFileTree as unknown as { $$typeof?: symbol; type?: React.ComponentType<React.ComponentProps<typeof actual.EditorFileTree>> };
  const isMemoized = raw.$$typeof === Symbol.for("react.memo") && typeof raw.type === "function";
  if (isMemoized && raw.type) {
    const Inner = raw.type;
    return {
      ...actual,
      EditorFileTree: memo((props: React.ComponentProps<typeof actual.EditorFileTree>) => {
        treeRenders.count += 1;
        return <Inner {...props} />;
      }),
    };
  }
  const Unmemoized = actual.EditorFileTree;
  return {
    ...actual,
    EditorFileTree: (props: React.ComponentProps<typeof actual.EditorFileTree>) => {
      treeRenders.count += 1;
      return <Unmemoized {...props} />;
    },
  };
});

import { CodeWorkbench } from "./CodeWorkbench";
import { ContextMenu } from "../shared/ContextMenu";
import { DEFAULT_CODE_EDITOR_SETTINGS, resetCodeEditorSettings, saveCodeEditorSettings } from "./codeEditorSettings";
import { isMacPlatform } from "../shared/shortcuts";

/** Presses Mod+<key> (Cmd on macOS, Ctrl elsewhere) the way a user would. */
function pressMod(key: string, shiftKey = false) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: isMacPlatform,
      ctrlKey: !isMacPlatform,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
  matchMedia: () => ({ matches: false }),
});

describe("CodeWorkbench performance", () => {
  let host: HTMLDivElement;
  let root: Root;
  let dirtyCalls: boolean[];

  beforeEach(() => {
    monacoHarness.reset();
    lsp.reset();
    treeRenders.count = 0;
    dirtyCalls = [];
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mockIPC((command, payload) => {
      switch (command) {
        case "list_dir":
          return [{ path: "src/app.ts", name: "app.ts", isDir: false }];
        case "read_file":
          return { content: "const x = 1;\n", binary: false, truncated: false };
        case "write_file":
          return null;
        case "set_editor_dirty":
          dirtyCalls.push((payload as { dirty: boolean }).dirty);
          return null;
        case "language_tools":
          return [];
        default:
          return null;
      }
    });
  });

  afterEach(async () => {
    await act(async () => root.render(null));
    host.remove();
    clearMocks();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it("tracks dirty state via version IDs without calling getValue() or localStorage.setItem on keystrokes", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
        />,
      ),
    );
    await settle();

    const model = monacoHarness.models[0];
    expect(model).toBeTruthy();
    const initialVersion = model.getAlternativeVersionId();

    // Opening the file wrote the open tab list once; getValue was not needed.
    expect(setItemSpy).toHaveBeenCalledWith("oxide:code-tabs:p1", JSON.stringify(["src/app.ts"]));
    setItemSpy.mockClear();
    model.getValue.mockClear();

    // First edit transitions clean -> dirty without calling getValue() or localStorage.setItem.
    await act(async () => model.__edit("const x = 12;\n"));
    expect(host.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    expect(dirtyCalls.at(-1)).toBe(true);
    expect(model.getValue).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();

    // Subsequent edits while already dirty do not call getValue(), setEditorDirty, or localStorage.setItem.
    const dirtyCountBefore = dirtyCalls.length;
    await act(async () => {
      model.__edit("const x = 123;\n");
      model.__edit("const x = 1234;\n");
      model.__edit("const x = 12345;\n");
    });
    expect(model.getValue).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(dirtyCalls.length).toBe(dirtyCountBefore);

    // Undoing back to the saved version ID clears dirty without calling getValue() or localStorage.setItem.
    await act(async () => model.__undoTo(initialVersion, "const x = 1;\n"));
    expect(host.querySelector('[aria-label="Unsaved changes"]')).toBeNull();
    expect(dirtyCalls.at(-1)).toBe(false);
    expect(model.getValue).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("updates cursor position readout without re-rendering EditorFileTree", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          rootPath="/repo"
          contextKey="p1"
          visible
          showExplorer
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
        />,
      ),
    );
    await settle();

    expect(host.querySelector(".editor-status")?.textContent).toContain("Ln 1, Col 1");
    const rendersBefore = treeRenders.count;

    await act(async () => monacoHarness.emitCursor(12, 5));
    expect(host.querySelector(".editor-status")?.textContent).toContain("Ln 12, Col 5");
    expect(treeRenders.count).toBe(rendersBefore);

    await act(async () => monacoHarness.emitCursor(42, 18));
    expect(host.querySelector(".editor-status")?.textContent).toContain("Ln 42, Col 18");
    expect(treeRenders.count).toBe(rendersBefore);

    // Even when CodeWorkbench itself re-renders (e.g. toggling Problems), EditorFileTree stays memoized.
    const problemsBtn = host.querySelector<HTMLButtonElement>(".editor-status button")!;
    await act(async () => problemsBtn.click());
    expect(host.querySelector(".editor-problems")).not.toBeNull();
    expect(treeRenders.count).toBe(rendersBefore);
  });

  it("shows the open file only on its tab, without a duplicate path row or Format and Save buttons", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
        />,
      ),
    );
    await settle();

    const tab = host.querySelector<HTMLElement>('.editor-tabs [title="src/app.ts"]');
    expect(tab?.textContent).toContain("app.ts");
    const buttonLabels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttonLabels).not.toContain("Format");
    expect(buttonLabels).not.toContain("Save");
    const pathTexts = [...host.querySelectorAll("span")].filter((s) => s.textContent === "src/app.ts");
    expect(pathTexts).toHaveLength(0);
  });

  it("opens the language popover from the status bar and closes it with Escape, returning focus", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench projectId={1} rootPath="/repo" contextKey="p1" visible openRequest={{ id: 1, path: "src/app.ts" }} onChanged={vi.fn()} />,
      ),
    );
    await settle();

    const indicator = host.querySelector<HTMLButtonElement>('.editor-status button[aria-haspopup="dialog"]')!;
    expect(indicator.getAttribute("aria-expanded")).toBe("false");
    await act(async () => indicator.click());
    await settle();
    expect(indicator.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).not.toBeNull();

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).toBeNull();
    expect(document.activeElement).toBe(indicator);
    expect(indicator.getAttribute("aria-expanded")).toBe("false");

    // A click outside closes it too.
    await act(async () => indicator.click());
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(indicator);
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).toBeNull();
    // Focus had nowhere else to go, so it is back on the button.
    expect(document.activeElement).toBe(indicator);
  });

  it("switches the buffer's language mode from the popover and moves its LSP tracking", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench projectId={1} rootPath="/repo" contextKey="p1" visible openRequest={{ id: 1, path: "src/app.ts" }} onChanged={vi.fn()} />,
      ),
    );
    await settle();
    const indicator = host.querySelector<HTMLButtonElement>('.editor-status button[aria-haspopup="dialog"]')!;
    expect(indicator.textContent).toContain("TypeScript");
    await act(async () => indicator.click());
    await settle();

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Language"]');
    const option = (name: string) =>
      [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(name));
    expect(option("TypeScript")?.getAttribute("aria-selected")).toBe("true");
    expect(option("Plain Text")?.getAttribute("aria-selected")).toBe("false");

    // The filter narrows the list.
    const filter = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Filter languages"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "jso");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...dialog()!.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["JSON"]);

    lsp.events.length = 0;
    await act(async () => option("JSON")!.click());
    expect(monacoHarness.models[0].getLanguageId()).toBe("json");
    expect(lsp.events).toEqual(["remove typescript", "add json"]);
    expect(dialog()).toBeNull();
    expect(indicator.textContent).toContain("JSON");
    expect(indicator.textContent).not.toContain("TypeScript");
  });

  it("shows the language server's live state in the popover, installs support and restarts the server", async () => {
    let installed = false;
    const installs: string[] = [];
    mockIPC((command, payload) => {
      switch (command) {
        case "read_file":
          return { content: "const x = 1;\n", binary: false, truncated: false };
        case "language_tools":
          return [{ language: "typescript", name: "TypeScript · typescript-language-server", installed }];
        case "install_language_support":
          installs.push((payload as { language: string }).language);
          installed = true;
          return { language: "typescript", name: "TypeScript · typescript-language-server", installed: true };
        default:
          return null;
      }
    });
    await act(async () =>
      root.render(
        <CodeWorkbench projectId={1} rootPath="/repo" contextKey="p1" visible openRequest={{ id: 1, path: "src/app.ts" }} onChanged={vi.fn()} />,
      ),
    );
    await settle();
    await act(async () => lsp.report("typescript", "Not installed · install it from the language button in the status bar"));
    const indicator = host.querySelector<HTMLButtonElement>('.editor-status button[aria-haspopup="dialog"]')!;
    expect(indicator.textContent).toContain("LSP not installed");
    await act(async () => indicator.click());
    await settle();

    const server = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Language"] [aria-label="Language server"]')!;
    const button = (name: string) => [...server().querySelectorAll("button")].find((b) => b.textContent?.includes(name));
    expect(server().textContent).toContain("TypeScript · typescript-language-server");
    expect(server().textContent).toContain("Not installed");
    expect(button("Restart server")).toBeUndefined();

    await act(async () => button("Install support")!.click());
    await settle();
    expect(installs).toEqual(["typescript"]);
    // A finished install reconnects the language servers of the open files.
    expect(lsp.reconnects).toEqual(["all"]);

    await act(async () => lsp.report("typescript", "Connecting…"));
    expect(server().textContent).toContain("Connecting");
    await act(async () => lsp.report("typescript", "Ready"));
    expect(server().textContent).toContain("Ready");
    expect(indicator.textContent).toContain("LSP ready");
    expect(button("Reinstall support")).toBeDefined();

    // Restart restarts only the buffer's language server.
    await act(async () => button("Restart server")!.click());
    expect(lsp.reconnects).toEqual(["all", "typescript"]);

    await act(async () => lsp.report("typescript", "Server stopped. Reconnect from the language button in the status bar."));
    expect(server().textContent).toContain("Stopped");
    expect(server().textContent).toContain("Server stopped.");
  });

  it("does not reopen the language popover on the next file after the last tab closes", async () => {
    const render = (id: number) =>
      act(async () =>
        root.render(
          <CodeWorkbench projectId={1} rootPath="/repo" contextKey="p1" visible openRequest={{ id, path: "src/app.ts" }} onChanged={vi.fn()} />,
        ),
      );
    await render(1);
    await settle();
    const indicator = host.querySelector<HTMLButtonElement>('.editor-status button[aria-haspopup="dialog"]')!;
    await act(async () => indicator.click());
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).not.toBeNull();

    // A shortcut-like close that never touches the popover.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close src/app.ts"]')!.click());
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).toBeNull();

    await render(2);
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).toBeNull();
    expect(indicator.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows no language server section for a language without one", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench projectId={1} rootPath="/repo" contextKey="p1" visible openRequest={{ id: 1, path: "src/app.ts" }} onChanged={vi.fn()} />,
      ),
    );
    await settle();
    const indicator = host.querySelector<HTMLButtonElement>('.editor-status button[aria-haspopup="dialog"]')!;
    await act(async () => indicator.click());
    const json = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "JSON")!;
    await act(async () => json.click());
    expect(indicator.textContent).not.toContain("LSP");
    await act(async () => indicator.click());
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Language"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Language server"]')).toBeNull();
  });

  it("persists open tabs on open/close and updates savedVersionId on save", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
        />,
      ),
    );
    await settle();

    expect(localStorage.getItem("oxide:code-tabs:p1")).toBe(JSON.stringify(["src/app.ts"]));
    setItemSpy.mockClear();

    const model = monacoHarness.models[0];
    await act(async () => model.__edit("const x = 2;\n"));
    expect(host.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();

    model.getValue.mockClear();
    await act(async () => pressMod("s"));
    await settle();

    // Save read getValue() once to write the file, cleared dirty, and did not rewrite localStorage.
    expect(model.getValue).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="Unsaved changes"]')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();

    // Closing the clean tab updates localStorage with the empty list.
    const closeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Close src/app.ts"]')!;
    await act(async () => closeBtn.click());
    expect(localStorage.getItem("oxide:code-tabs:p1")).toBe(JSON.stringify([]));
  });

  it("saves every dirty file with Mod+Shift+S and asks before closing a dirty tab", async () => {
    const writes: string[] = [];
    const ipc = (command: string, payload: unknown) => {
      if (command === "write_file") writes.push((payload as { path: string }).path);
      if (command === "list_dir") return [{ path: "src/app.ts", name: "app.ts", isDir: false }];
      if (command === "read_file") return { content: "const x = 1;\n", binary: false, truncated: false };
      if (command === "language_tools") return [];
      return null;
    };
    mockIPC(ipc);
    const render = (id: number, path: string) =>
      act(async () =>
        root.render(
          <CodeWorkbench
            projectId={1}
            rootPath="/repo"
            contextKey="p1"
            visible
            openRequest={{ id, path }}
            onChanged={vi.fn()}
          />,
        ),
      );

    await render(1, "src/app.ts");
    await settle();
    await act(async () => monacoHarness.models[0].__edit("const x = 2;\n"));
    await render(2, "src/util.ts");
    await settle();
    await act(async () => monacoHarness.models[1].__edit("const y = 2;\n"));
    expect(host.querySelectorAll('[aria-label="Unsaved changes"]')).toHaveLength(2);

    await act(async () => pressMod("s", true));
    await settle();
    expect(writes).toHaveLength(2);
    expect(host.querySelector('[aria-label="Unsaved changes"]')).toBeNull();

    await act(async () => monacoHarness.models[1].__edit("const y = 3;\n"));
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close src/util.ts"]')!;
    await act(async () => close.click());
    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("src/util.ts has unsaved changes.");
    const saveChanges = [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Save changes")!;
    await act(async () => saveChanges.click());
    await settle();
    expect(writes).toHaveLength(3);
    expect(host.querySelector('.editor-tab[data-path="src/util.ts"]')).toBeNull();
  });

  it("initializes Monaco with saved CodeEditorSettings and broadcasts live updates across all mounted workbenches", async () => {
    saveCodeEditorSettings({
      ...DEFAULT_CODE_EDITOR_SETTINGS,
      tabSize: 2,
      insertSpaces: false,
      wordWrap: "on",
      lineNumbers: "relative",
      minimap: true,
      stickyScroll: false,
      renderWhitespace: "all",
      bracketPairColorization: false,
      fontLigatures: true,
      autoIndent: "brackets",
      formatOnPaste: false,
      smoothScrolling: false,
      scrollBeyondLastLine: true,
      cursorStyle: "block",
      cursorBlinking: "phase",
      lineHeight: 1.6,
    });

    await act(async () =>
      root.render(
        <>
          <CodeWorkbench
            projectId={1}
            rootPath="/repo-one"
            contextKey="p1"
            visible
            onChanged={vi.fn()}
          />
          <CodeWorkbench
            projectId={2}
            rootPath="/repo-two"
            contextKey="p2"
            visible={false}
            onChanged={vi.fn()}
          />
        </>,
      ),
    );
    await settle();

    expect(monacoHarness.createCalls).toHaveLength(2);
    for (const initialOptions of monacoHarness.createCalls) {
      expect(initialOptions).toMatchObject({
        tabSize: 2,
        insertSpaces: false,
        wordWrap: "on",
        lineNumbers: "relative",
        minimap: { enabled: true },
        stickyScroll: { enabled: false },
        renderWhitespace: "all",
        bracketPairColorization: { enabled: false },
        fontLigatures: true,
        autoIndent: "brackets",
        formatOnPaste: false,
        smoothScrolling: false,
        scrollBeyondLastLine: true,
        cursorStyle: "block",
        cursorBlinking: "phase",
        lineHeight: 1.6,
      });
    }

    await act(async () => {
      saveCodeEditorSettings({
        ...DEFAULT_CODE_EDITOR_SETTINGS,
        tabSize: 8,
        wordWrap: "bounded",
        cursorStyle: "underline",
      });
    });

    expect(monacoHarness.updateOptionsCalls[0]).toHaveLength(1);
    expect(monacoHarness.updateOptionsCalls[1]).toHaveLength(1);
    expect(monacoHarness.updateOptionsCalls[0][0]).toMatchObject({
      tabSize: 8,
      wordWrap: "bounded",
      cursorStyle: "underline",
    });
    expect(monacoHarness.updateOptionsCalls[1][0]).toMatchObject({
      tabSize: 8,
      wordWrap: "bounded",
      cursorStyle: "underline",
    });

    await act(async () => {
      resetCodeEditorSettings();
    });

    expect(monacoHarness.updateOptionsCalls[0]).toHaveLength(2);
    expect(monacoHarness.updateOptionsCalls[1]).toHaveLength(2);
    expect(monacoHarness.updateOptionsCalls[0][1]).toMatchObject({
      tabSize: 4,
      wordWrap: "off",
      cursorStyle: "line",
    });
  });

  it("dismisses the open-files dropdown on outside/editor pointerdown, Escape, and window blur", async () => {
    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
        />,
      ),
    );
    await settle();

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="All open files"]')!;
    const menu = () => host.querySelector('[role="menu"][aria-label="Open files"]');

    // 1. Clicking inside the editor canvas closes the dropdown.
    await act(async () => toggle.click());
    expect(menu()).not.toBeNull();
    const canvas = host.querySelector(".editor-canvas")!;
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();

    // 2. Pressing Escape on window closes the dropdown.
    await act(async () => toggle.click());
    expect(menu()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(menu()).toBeNull();

    // 3. Blurring the window closes the dropdown.
    await act(async () => toggle.click());
    expect(menu()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(menu()).toBeNull();
  });

  it("offers Close, Close others, Close all, and Copy path on Code file tabs", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await act(async () =>
      root.render(
        <>
          <ContextMenu actions={{ openProject: vi.fn(), openSettings: vi.fn() }} />
          <CodeWorkbench
            projectId={1}
            rootPath="/repo"
            contextKey="p1"
            visible
            openRequest={{ id: 1, path: "src/app.ts" }}
            onChanged={vi.fn()}
          />
        </>,
      ),
    );
    await settle();
    await act(async () =>
      root.render(
        <>
          <ContextMenu actions={{ openProject: vi.fn(), openSettings: vi.fn() }} />
          <CodeWorkbench
            projectId={1}
            rootPath="/repo"
            contextKey="p1"
            visible
            openRequest={{ id: 2, path: "src/util.ts" }}
            onChanged={vi.fn()}
          />
        </>,
      ),
    );
    await settle();

    const firstTab = host.querySelector<HTMLElement>('.editor-tab[data-path="src/app.ts"]')!;
    await act(async () => {
      firstTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    });
    const items = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items().map((b) => b.textContent)).toEqual(["Close", "Close others", "Close all", "Copy path"]);

    await act(async () => { items()[3]!.click(); });
    expect(writeText).toHaveBeenCalledWith("/repo/src/app.ts");

    await act(async () => {
      firstTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    });
    await act(async () => { items()[1]!.click(); });
    await settle();
    expect(host.querySelectorAll(".editor-tab")).toHaveLength(1);
    expect(host.querySelector('.editor-tab[data-path="src/app.ts"]')).not.toBeNull();
  });

  it("disables Monaco's built-in context menu and routes editor right-clicks through Oxide's ContextMenu", async () => {
    monacoHarness.actions["editor.action.revealDefinition"] = { isSupported: () => true, run: vi.fn() };
    monacoHarness.actions["editor.action.goToReferences"] = { isSupported: () => true, run: vi.fn() };
    monacoHarness.actions["editor.action.formatDocument"] = { isSupported: () => true, run: vi.fn() };
    monacoHarness.actions["actions.find"] = { isSupported: () => true, run: vi.fn() };

    await act(async () =>
      root.render(
        <>
          <ContextMenu actions={{ openProject: vi.fn(), openSettings: vi.fn() }} />
          <CodeWorkbench
            projectId={1}
            rootPath="/repo"
            contextKey="p1"
            visible
            openRequest={{ id: 1, path: "src/app.ts" }}
            onChanged={vi.fn()}
          />
        </>,
      ),
    );
    await settle();

    expect(monacoHarness.createOptions?.contextmenu).toBe(false);

    const browserEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
    await act(async () => {
      monacoHarness.emitContextMenu(browserEvent);
      window.dispatchEvent(browserEvent);
    });

    const items = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items().map((b) => b.querySelector("span")?.textContent)).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "Select All",
      "Find",
      "Format Document",
      "Go to Definition",
      "Find References",
    ]);

    await act(async () => { items()[6]!.click(); });
    expect(monacoHarness.actions["editor.action.revealDefinition"]!.run).toHaveBeenCalledOnce();
  });
});
