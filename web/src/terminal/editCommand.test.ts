// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEditCommand } from "./editCommand";

describe("runEditCommand", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let readText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    writeText = vi.fn().mockResolvedValue(undefined);
    readText = vi.fn().mockResolvedValue("pasted");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops when an oxide-editor-edit listener cancels the event", () => {
    const input = document.createElement("input");
    input.value = "hello";
    document.body.append(input);
    input.focus();

    const listener = (e: Event) => e.preventDefault();
    window.addEventListener("oxide-editor-edit", listener);
    try {
      runEditCommand("selectAll", document.activeElement);
      expect(input.selectionStart).toBe(input.selectionEnd);
    } finally {
      window.removeEventListener("oxide-editor-edit", listener);
    }
  });

  it("supports selectAll, copy, cut, and paste on input and textarea elements", async () => {
    const input = document.createElement("input");
    input.value = "hello world";
    document.body.append(input);
    input.focus();
    const onInput = vi.fn();
    input.addEventListener("input", onInput);

    runEditCommand("selectAll", input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("hello world".length);

    input.setSelectionRange(0, 5);
    runEditCommand("copy", input);
    expect(writeText).toHaveBeenCalledWith("hello");

    input.setSelectionRange(6, 11);
    runEditCommand("cut", input);
    expect(writeText).toHaveBeenCalledWith("world");
    expect(input.value).toBe("hello ");
    expect(onInput).toHaveBeenCalledTimes(1);

    input.setSelectionRange(6, 6);
    runEditCommand("paste", input);
    await vi.waitFor(() => {
      expect(input.value).toBe("hello pasted");
    });
    expect(onInput).toHaveBeenCalledTimes(2);
  });

  it("does not mutate readOnly or disabled inputs on cut or paste", async () => {
    const input = document.createElement("input");
    input.value = "locked";
    input.readOnly = true;
    document.body.append(input);
    input.setSelectionRange(0, 6);

    runEditCommand("cut", input);
    runEditCommand("paste", input);
    await Promise.resolve();
    expect(input.value).toBe("locked");
    expect(readText).not.toHaveBeenCalled();
  });

  it("supports selectAll, copy, cut, and paste on contentEditable and document selections", async () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.textContent = "alpha beta";
    const outside = document.createElement("p");
    outside.textContent = "outside";
    document.body.append(editable, outside);
    const onInput = vi.fn();
    editable.addEventListener("input", onInput);

    runEditCommand("selectAll", editable);
    const sel = window.getSelection();
    expect(sel?.toString()).toBe("alpha beta");

    runEditCommand("copy", editable);
    expect(writeText).toHaveBeenCalledWith("alpha beta");

    runEditCommand("cut", editable);
    expect(writeText).toHaveBeenLastCalledWith("alpha beta");
    expect(editable.textContent).toBe("");
    expect(onInput).toHaveBeenCalledTimes(1);

    runEditCommand("paste", editable);
    await vi.waitFor(() => {
      expect(editable.textContent).toBe("pasted");
    });
    expect(onInput).toHaveBeenCalledTimes(2);
  });
});
