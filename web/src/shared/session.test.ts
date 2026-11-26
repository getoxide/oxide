// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  changeDirectoryLine, forgetTerminalSession, readSession, readTerminalSession, restoreSessionEnabled,
  setRestoreSession, writeSession, writeTerminalSession, SESSION_BLOCKS, SESSION_OUTPUT,
} from "./session";

beforeEach(() => localStorage.clear());
const block = (command: string, output = "out") => ({ command, output, exitCode: 0, at: 1, completedAt: 2 });

it("is on by default and restores the Terminals, open Code workspaces and halves", () => {
  expect(restoreSessionEnabled()).toBe(true);
  writeSession({
    terminals: { 1: { tabs: [{ id: 2, name: "server", customName: true, running: "npm run dev" }, { id: 1, name: "Terminal 1", customName: false, running: "vim" }], selectedId: 2, nextId: 3 } },
    code: [1], lastHalf: { 1: "code" },
  });
  expect(readSession()).toEqual({
    terminals: { 1: { tabs: [{ id: 2, name: "server", customName: true, running: null }, { id: 1, name: "Terminal 1", customName: false, running: null }], selectedId: 2, nextId: 3 } },
    code: [1], lastHalf: { 1: "code" },
  });
});

it("tells a name given by hand from the default one in a snapshot saved before the flag", () => {
  localStorage.setItem("oxide:session:v1", JSON.stringify({ terminals: { 1: { tabs: [{ id: 1, name: "Terminal 1" }, { id: 2, name: "backend" }], nextId: 3, selectedId: 1 } }, code: [], lastHalf: {} }));
  expect(readSession()!.terminals[1].tabs.map((tab) => tab.customName)).toEqual([false, true]);
});

it("keeps a Terminal's folder and only its recent blocks, each with the tail of its output", () => {
  const blocks = Array.from({ length: SESSION_BLOCKS + 3 }, (_, i) => block(`echo ${i}`, "x".repeat(SESSION_OUTPUT + 10)));
  writeTerminalSession("1:1", { cwd: "/project/src", blocks });
  const session = readTerminalSession("1:1")!;
  expect(session.cwd).toBe("/project/src");
  expect(session.blocks.map((b) => b.command)).toEqual(blocks.slice(-SESSION_BLOCKS).map((b) => b.command));
  expect(session.blocks[0].output).toHaveLength(SESSION_OUTPUT);
  forgetTerminalSession("1:1");
  expect(readTerminalSession("1:1")).toBeNull();
});

it("forgets everything when turned off, and saves nothing while off", () => {
  writeSession({ terminals: {}, code: [], lastHalf: {} });
  writeTerminalSession("1:1", { cwd: null, blocks: [block("ls")] });
  setRestoreSession(false);
  expect(localStorage.getItem("oxide:session:v1")).toBeNull();
  expect(localStorage.getItem("oxide:terminal-session:1:1")).toBeNull();
  writeTerminalSession("1:1", { cwd: null, blocks: [block("ls")] });
  expect(localStorage.getItem("oxide:terminal-session:1:1")).toBeNull();
  setRestoreSession(true);
  expect(readSession()).toBeNull();
});

it("ignores a hand-edited or corrupt snapshot", () => {
  localStorage.setItem("oxide:session:v1", JSON.stringify({ terminals: { x: 1, 2: { tabs: [{ id: 9, name: "" }, { id: 1, name: "ok" }], nextId: 2, selectedId: 7 } }, code: ["a", 2], lastHalf: { 2: "nope" } }));
  expect(readSession()).toEqual({ terminals: { 2: { tabs: [{ id: 1, name: "ok", customName: true, running: null }], selectedId: 1, nextId: 2 } }, code: [2], lastHalf: {} });
});

it("quotes the folder for the shell", () => {
  expect(changeDirectoryLine("/a/it's", false)).toBe(" cd -- '/a/it'\\''s' 2>/dev/null\n");
  expect(changeDirectoryLine("C:\\it's", true)).toBe(" Set-Location -LiteralPath 'C:\\it''s'\r");
});
