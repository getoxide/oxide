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
  onDidChangeContent: (cb: () => void) => { dispose: () => void };
  dispose: () => void;
  /** Test helpers to simulate typing and undo at the Monaco boundary. */
  __edit: (next: string) => void;
  __undoTo: (versionId: number, content: string) => void;
}

const monacoHarness = vi.hoisted(() => {
  const models: MockModel[] = [];
  let currentModel: MockModel | null = null;
  let position = { lineNumber: 1, column: 1 };
  const cursorListeners = new Set<(e: { position: { lineNumber: number; column: number } }) => void>();

  const makeModel = (initial: string, _lang: string, uri: { path: string; toString: () => string }): MockModel => {
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
      getLanguageId: () => "typescript",
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
    reset() {
      models.length = 0;
      currentModel = null;
      position = { lineNumber: 1, column: 1 };
      cursorListeners.clear();
    },
    emitCursor(lineNumber: number, column: number) {
      position = { lineNumber, column };
      for (const cb of cursorListeners) cb({ position });
    },
    monaco: {
      MarkerSeverity: { Error: 8, Warning: 4 },
      Uri: {
        file: (path: string) => ({ path, toString: () => `file://${path}` }),
      },
      editor: {
        create: () => ({
          setModel: (m: MockModel | null) => { currentModel = m; },
          getModel: () => currentModel,
          saveViewState: () => null,
          restoreViewState: () => {},
          setSelection: () => {},
          revealRangeInCenter: () => {},
          focus: () => {},
          layout: () => {},
          hasTextFocus: () => false,
          getPosition: () => position,
          onDidChangeCursorPosition: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => {
            cursorListeners.add(cb);
            return { dispose: () => cursorListeners.delete(cb) };
          },
          updateOptions: () => {},
          trigger: () => {},
          getAction: () => null,
          dispose: () => cursorListeners.clear(),
        }),
        createModel: makeModel,
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
  serverLanguage: () => null,
}));

vi.mock("./editorLanguages", () => ({
  EditorLanguages: class {
    add() {}
    changed() {}
    saved() {}
    remove() {}
    reconnect() {}
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
          threadId={null}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
          onOpenLanguageSettings={vi.fn()}
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
          threadId={null}
          rootPath="/repo"
          contextKey="p1"
          visible
          showExplorer
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
          onOpenLanguageSettings={vi.fn()}
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

  it("persists open tabs on open/close and updates savedVersionId on save", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    await act(async () =>
      root.render(
        <CodeWorkbench
          projectId={1}
          threadId={null}
          rootPath="/repo"
          contextKey="p1"
          visible
          openRequest={{ id: 1, path: "src/app.ts" }}
          onChanged={vi.fn()}
          onOpenLanguageSettings={vi.fn()}
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
    const saveBtn = host.querySelector<HTMLButtonElement>(".editor-breadcrumb button:last-of-type")!;
    await act(async () => saveBtn.click());
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
});
