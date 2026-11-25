// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor label="Comment" value={value} onChange={setValue} />;
}

const area = () => host.querySelector("textarea") as HTMLTextAreaElement;
const tool = (name: string) => host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;

it("offers Write and Preview tabs and the formatting toolbar", async () => {
  await act(async () => root.render(<Harness initial="" />));
  expect(host.querySelector('[role="tablist"]')).not.toBeNull();
  for (const name of ["Heading", "Bold", "Italic", "Quote", "Code", "Link", "Bulleted list", "Numbered list", "Task list"]) {
    expect(tool(name)).not.toBeNull();
  }
});

it("formats the selected text from the toolbar", async () => {
  await act(async () => root.render(<Harness initial="hello world" />));
  area().setSelectionRange(0, 5);
  await act(async () => tool("Bold").click());
  expect(area().value).toBe("**hello** world");
});

it("hides the toolbar while previewing", async () => {
  await act(async () => root.render(<Harness initial="x" />));
  const preview = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Preview") as HTMLElement;
  await act(async () => preview.click());
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
});

function MentionHarness({ initial = "", onKeyDown, onMentionOpen }: {
  initial?: string;
  onKeyDown?: (key: string) => void;
  onMentionOpen?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      label="Comment"
      value={value}
      onChange={setValue}
      mentions={["octo-cat", "monalisa", "octo-dog", "hubot"]}
      onMentionOpen={onMentionOpen}
      onKeyDown={(e) => onKeyDown?.(e.key)}
    />
  );
}

async function type(text: string) {
  const el = area();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, el.value + text);
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}
const menu = () => host.querySelector('[role="listbox"]');
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const selected = () => host.querySelector('[role="option"][aria-selected="true"]')?.textContent;

it("opens a filtered mention list after @ and asks for more candidates", async () => {
  const opened = vi.fn();
  await act(async () => root.render(<MentionHarness onMentionOpen={opened} />));
  await type("Hi @");
  expect(options()).toEqual(["octo-cat", "monalisa", "octo-dog", "hubot"]);
  expect(opened).toHaveBeenCalled();
  await type("OC");
  expect(options()).toEqual(["octo-cat", "octo-dog"]);
  await type("x");
  expect(menu()).toBeNull();
});

it("does not open for an email address", async () => {
  await act(async () => root.render(<MentionHarness />));
  await type("mail a@");
  expect(menu()).toBeNull();
});

it("moves with the arrows and inserts the choice with Enter", async () => {
  const keys = vi.fn();
  await act(async () => root.render(<MentionHarness initial="cc " onKeyDown={keys} />));
  await type("@oc");
  expect(selected()).toBe("octo-cat");
  await press("ArrowDown");
  expect(selected()).toBe("octo-dog");
  await press("ArrowDown");
  expect(selected()).toBe("octo-cat");
  await press("ArrowUp");
  expect(selected()).toBe("octo-dog");
  await press("Enter");
  expect(area().value).toBe("cc @octo-dog ");
  expect(area().selectionStart).toBe("cc @octo-dog ".length);
  expect(menu()).toBeNull();
  expect(keys).not.toHaveBeenCalled();
});

it("inserts with Tab before the text after the caret", async () => {
  await act(async () => root.render(<MentionHarness initial=" thanks" />));
  await act(async () => area().setSelectionRange(0, 0));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(area(), "@hu thanks");
    area().setSelectionRange(3, 3);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Tab");
  expect(area().value).toBe("@hubot  thanks");
  expect(area().selectionStart).toBe(7);
});

it("inserts a clicked candidate", async () => {
  await act(async () => root.render(<MentionHarness />));
  await type("@mo");
  const option = host.querySelector('[role="option"]') as HTMLElement;
  await act(async () => option.click());
  expect(area().value).toBe("@monalisa ");
});

it("closes only the mention list on Escape", async () => {
  const keys = vi.fn();
  await act(async () => root.render(<MentionHarness onKeyDown={keys} />));
  await type("@oc");
  await press("Escape");
  expect(menu()).toBeNull();
  expect(keys).not.toHaveBeenCalled();
  expect(area().value).toBe("@oc");
  await press("Escape");
  expect(keys).toHaveBeenCalledWith("Escape");
});

it("leaves Enter and Cmd+Enter to the form while the list is closed", async () => {
  const keys = vi.fn();
  await act(async () => root.render(<MentionHarness initial="done" onKeyDown={keys} />));
  await press("Enter", { metaKey: true });
  expect(keys).toHaveBeenCalledWith("Enter");
});
