// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedStorage, readJson, readText, removeKey, storageKeys, writeJson, writeText } from "./storage";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("guarded storage", () => {
  it("round-trips JSON and text", () => {
    writeJson("k", { a: [1, 2] });
    expect(readJson("k")).toEqual({ a: [1, 2] });
    writeText("t", "hello");
    expect(readText("t")).toBe("hello");
    removeKey("t");
    expect(readText("t")).toBeNull();
  });

  it("reads null for a missing or corrupt value instead of throwing", () => {
    expect(readJson("missing")).toBeNull();
    localStorage.setItem("bad", "{not json");
    expect(readJson("bad")).toBeNull();
  });

  it("keeps working when storage refuses writes or reads", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => writeJson("k", 1)).not.toThrow();
    expect(() => removeKey("k")).not.toThrow();
    expect(readJson("k")).toBeNull();
    expect(readText("k")).toBeNull();
  });

  it("offers the same guarded access to helpers that take a Storage", () => {
    guardedStorage.setItem("g", "1");
    expect(guardedStorage.getItem("g")).toBe("1");
  });

  it("keeps the key strings people already have stored", () => {
    expect(storageKeys.appearance).toBe("oxide:appearance:v1");
    expect(storageKeys.panelSize("sidebar")).toBe("oxide.layout.sidebar");
    expect(storageKeys.codeTabs("p1")).toBe("oxide:code-tabs:p1");
    expect(storageKeys.terminalHistory("p1")).toBe("oxide:terminal-history:p1");
    expect(storageKeys.languageDismissed("rust")).toBe("oxide:language-dismissed:rust");
  });
});
