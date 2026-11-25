// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

/** Just enough of Monaco for the language sessions: models, markers and provider registration. */
const fake = vi.hoisted(() => {
  const markers = new Map<unknown, unknown[]>();
  const disposable = () => ({ dispose: () => {} });
  return {
    markers,
    monaco: {
      Range: class {
        constructor(
          public startLineNumber: number,
          public startColumn: number,
          public endLineNumber: number,
          public endColumn: number,
        ) {}
      },
      MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
      Uri: {
        file: (path: string) => ({ path, toString: () => `file://${path}` }),
        parse: (uri: string) => ({ path: uri.replace("file://", ""), toString: () => uri }),
      },
      editor: {
        setModelMarkers: (model: unknown, _owner: string, list: unknown[]) => markers.set(model, list),
        setModelLanguage: (model: { language: string }, language: string) => {
          model.language = language;
        },
      },
      languages: {
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: disposable,
        registerHoverProvider: disposable,
        registerDefinitionProvider: disposable,
        registerReferenceProvider: disposable,
        registerDocumentFormattingEditProvider: disposable,
        registerRenameProvider: disposable,
      },
    },
  };
});
vi.mock("./editorRuntime", () => ({
  monaco: fake.monaco,
  serverLanguage: (language: string) =>
    ({ typescript: "typescript", javascript: "typescript", python: "python", rust: "rust", c: "cpp", cpp: "cpp" })[language] ?? null,
}));

import { EditorLanguages } from "./editorLanguages";
import type { monaco as Monaco } from "./editorRuntime";

type Model = Monaco.editor.ITextModel & { language: string };
function model(path: string, language: string): Model {
  const m = {
    language,
    uri: fake.monaco.Uri.file(path),
    getLanguageId: () => m.language,
    getVersionId: () => 1,
    getValue: () => "text",
    isDisposed: () => false,
  };
  return m as unknown as Model;
}

/** Fake language servers behind Core's commands: what each received, and a way to hold one's start. */
let servers: { language: string; channel: Channel<string>; received: { method?: string; params?: { textDocument?: { uri: string } } }[]; stopped: boolean }[];
let held: Map<string, () => void>;
const server = (language: string) => servers.filter((s) => s.language === language);
const received = (language: string, method: string) =>
  server(language).flatMap((s) => s.received.filter((m) => m.method === method));
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  servers = [];
  held = new Map();
  fake.markers.clear();
  mockIPC(async (command, args) => {
    const a = args as Record<string, unknown>;
    if (command === "language_tools")
      return ["typescript", "python"].map((language) => ({
        language,
        name: language,
        installed: true,
        installCommand: "",
        documentation: "",
        config: { command: language, args: [] },
      }));
    if (command === "start_language_server") {
      const language = a.language as string;
      const hold = held.get(language);
      if (hold) await new Promise<void>((resolve) => held.set(language, resolve));
      servers.push({ language, channel: a.onMessage as Channel<string>, received: [], stopped: false });
      return { id: servers.length - 1, root: "/project", language, initializationOptions: null };
    }
    if (command === "language_server_message") {
      const s = servers[a.id as number];
      const message = JSON.parse(a.message as string);
      s.received.push(message);
      if (message.method === "initialize")
        queueMicrotask(() => s.channel.onmessage(JSON.stringify({ id: message.id, result: { capabilities: {} } })));
      return null;
    }
    if (command === "stop_language_server") {
      servers[a.id as number].stopped = true;
      return null;
    }
    return null;
  });
});
afterEach(clearMocks);

const sessions = () => new EditorLanguages(1, () => {}, async () => {});

it("does not open a buffer on its old server when its language changes while that server is starting", async () => {
  held.set("typescript", () => {});
  const languages = sessions();
  const buffer = model("/project/notes.ts", "typescript");
  languages.add(buffer);
  await settle();

  languages.remove(buffer);
  fake.monaco.editor.setModelLanguage(buffer, "python");
  languages.add(buffer);
  held.get("typescript")!();
  await settle();

  expect(received("typescript", "textDocument/didOpen")).toEqual([]);
  expect(received("python", "textDocument/didOpen")).toHaveLength(1);

  // Closing it later tells only the server it was open on.
  languages.remove(buffer);
  await settle();
  expect(received("typescript", "textDocument/didClose")).toEqual([]);
  expect(received("python", "textDocument/didClose")).toHaveLength(1);
  languages.dispose();
});

const publish = (language: string, uri: string) =>
  server(language).at(-1)!.channel.onmessage(
    JSON.stringify({
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: `from ${language}`, severity: 1 }] },
    }),
  );

it("shows a buffer only the diagnostics of the server of its current language", async () => {
  const languages = sessions();
  const buffer = model("/project/notes.ts", "typescript");
  languages.add(buffer);
  await settle();
  expect(received("typescript", "textDocument/didOpen")).toHaveLength(1);

  languages.remove(buffer);
  fake.monaco.editor.setModelLanguage(buffer, "python");
  languages.add(buffer);
  await settle();

  // A late report from the server it left is dropped.
  publish("typescript", buffer.uri.toString());
  expect(fake.markers.get(buffer)).toEqual([]);
  publish("python", buffer.uri.toString());
  expect(fake.markers.get(buffer)).toEqual([expect.objectContaining({ message: "from python" })]);
  languages.dispose();
});
