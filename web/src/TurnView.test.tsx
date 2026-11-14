// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ItemSnapshot, ModelInfo } from "./bindings";
import type { TranscriptTurn } from "./transcript";
import * as attachments from "./attachments";
import * as transcriptView from "./transcriptView";
import { TurnView } from "./TurnView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

let nextId = 1;
const item = (
  itemIndex: number,
  kind: ItemSnapshot["kind"],
  content: string,
  category: ItemSnapshot["category"] = null,
): ItemSnapshot => ({ id: nextId++, itemIndex, kind, content, parentItemIndex: null, category, command: { line: null, outcome: "unknown", exitCode: null }, createdAt: "2026-10-22T10:00:00Z" });

const turn = (over: Partial<TranscriptTurn>): TranscriptTurn => ({
  id: 1,
  turnIndex: 0,
  prompt: "do it",
  model: null,
  effort: null,
  segments: [],
  status: "completed",
  startedAt: "2026-10-22T10:00:00Z",
  completedAt: "2026-10-22T10:00:42Z",
  items: [],
  error: null,
  approvals: [],
  unknownEvents: [],
  ...over,
});

async function render(t: TranscriptTurn, catalog: ModelInfo[] | null = null) {
  await act(async () =>
    root.render(
      <TurnView turn={t} provider="claude" catalog={catalog} onRespond={vi.fn()} isWorking={t.status === "running"} instant />,
    ),
  );
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const buttonWith = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const phase = (label: string) =>
  [...container.querySelectorAll<HTMLElement>(".activity-phase-toggle")].find((b) => b.textContent?.startsWith(label));
const generating = () => container.querySelector('[role="status"][aria-label="Generating response…"]');

const worked = [
  item(0, "tool_call", "Read src/a.ts\nconst a = 1;", "explore"),
  item(1, "file_change", "src/a.ts"),
  item(2, "tool_call", "Run cargo test\n1 passed", "run"),
  item(3, "agent_message", "All done."),
];

it("humanizes the Model and capitalizes the Effort in the Turn header, without repeating it", async () => {
  const catalog: ModelInfo[] = [
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", description: null, supportedEfforts: [], defaultEffort: null, isLegacy: false },
  ];
  await render(turn({ model: "gemini-3.8-flash-low", effort: "low", items: [item(0, "agent_message", "hi")] }), catalog);
  const header = container.querySelector(".agent-header")!;
  expect(header.querySelector(".model-name")?.textContent).toBe("Gemini 3.8 Flash");
  expect(header.querySelector(".effort-badge")?.textContent).toBe("Effort: Low");
  expect(header.textContent).not.toContain("gemini-3.8-flash-low");
  expect(header.textContent).not.toContain("· low");
});

it("shows the Effort on its own when the catalog has no name for the Model", async () => {
  await render(turn({ model: "claude-opus-5-5", effort: "high", items: [item(0, "agent_message", "hi")] }), null);
  const header = container.querySelector(".agent-header")!;
  expect(header.querySelector(".model-name")?.textContent).toBe("Claude Opus 5.5");
  expect(header.querySelector(".effort-badge")?.textContent).toBe("Effort: High");
});

it("keeps the Effort the Model carries when the Turn has no separate value", async () => {
  await render(turn({ model: "gemini-3.8-flash-low", effort: null, items: [item(0, "agent_message", "hi")] }), null);
  const header = container.querySelector(".agent-header")!;
  expect(header.querySelector(".model-name")?.textContent).toBe("Gemini 3.8 Flash");
  expect(header.querySelector(".effort-badge")?.textContent).toBe("Effort: Low");
});

it("shows sent Line comments as formatted text with the quoted code, not as raw markdown", async () => {
  const text = "I reviewed your changes and left 1 comment. Please address each one.\n\n### src/a.ts:2\n```\nconst x = 1;\n```\nWhy this value?\n";
  await render(turn({ segments: [{ kind: "text", text }] }));
  const shown = container.querySelector(".review-comments")!;
  expect(shown.querySelector('[role="heading"]')?.textContent).toBe("src/a.ts:2");
  expect(shown.querySelector("pre")?.textContent).toContain("const x = 1;");
  expect(shown.textContent).not.toContain("```");
});

it("ends collapsed on a summary with the time worked, the final message staying outside", async () => {
  await render(turn({ items: worked }));
  const summary = buttonWith("Explored 1 file · Edited 1 file · Ran 1 command");
  expect(summary?.getAttribute("aria-expanded")).toBe("false");
  expect(summary?.textContent).toContain("Worked for 42s");
  expect(container.textContent).toContain("All done.");
  expect(container.textContent).not.toContain("Pondering");
  expect(container.textContent).not.toContain("cargo test");
});

it("drills down from the summary to a phase to an Item's detail", async () => {
  await render(turn({ items: worked }));
  await click(buttonWith("Explored 1 file"));
  expect(phase("Ran")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("cargo test");

  await click(phase("Ran"));
  await click(buttonWith("Run cargo test"));
  expect(container.textContent).toContain("1 passed");
  // Other phases stay closed.
  expect(container.textContent).not.toContain("const a = 1;");
});

it("shows a live line while running, ponders when idle, and drops it when the Turn ends", async () => {
  const running = turn({ status: "running", completedAt: null, startedAt: new Date().toISOString() });
  await render(running);
  expect(container.textContent).toContain("Pondering…");

  await render({ ...running, items: [item(0, "tool_call", "Run cargo test", "run")] });
  expect(container.textContent).not.toContain("Pondering");
  expect(container.querySelector(".activity-live-sub")?.textContent).toBe("Run cargo test");

  await render({ ...running, status: "completed", completedAt: new Date().toISOString(), items: [item(0, "tool_call", "Run cargo test", "run")] });
  expect(container.querySelector(".activity-live")).toBeNull();
  expect(buttonWith("Ran 1 command")).toBeTruthy();
});

it("shows a generating indicator while running before any content arrives", async () => {
  await render(turn({ status: "running", completedAt: null, startedAt: new Date().toISOString() }));
  expect(generating()).toBeTruthy();
});

it("keeps the generating indicator while only Activity has arrived", async () => {
  await render(
    turn({
      status: "running",
      completedAt: null,
      startedAt: new Date().toISOString(),
      items: [item(0, "tool_call", "Read src/a.ts", "explore")],
    }),
  );
  expect(generating()).toBeTruthy();
});

it("drops the generating indicator once a message block streams in", async () => {
  await render(
    turn({
      status: "running",
      completedAt: null,
      startedAt: new Date().toISOString(),
      items: [item(0, "agent_message", "Here is the answer.")],
    }),
  );
  expect(generating()).toBeNull();
  expect(container.textContent).toContain("Here is the answer.");
});

it("shows no generating indicator on a Turn that is not running", async () => {
  await render(turn({ status: "completed" }));
  expect(generating()).toBeNull();
});

it("shows no live line while waiting on an Approval", async () => {
  await render(
    turn({
      status: "running",
      completedAt: null,
      approvals: [{ id: 1, turnId: 1, approvalId: "a", kind: "command", summary: "rm", options: [], decision: null, createdAt: "", decidedAt: null }],
    }),
  );
  expect(container.querySelector(".activity-live-timer")).toBeNull();
  expect(container.textContent).toContain("Waiting for your approval");
});

it("shows no generating indicator while an Approval is pending", async () => {
  await render(
    turn({
      status: "running",
      completedAt: null,
      startedAt: new Date().toISOString(),
      approvals: [{ id: 1, turnId: 1, approvalId: "a", kind: "command", summary: "rm", options: [], decision: null, createdAt: "", decidedAt: null }],
    }),
  );
  expect(generating()).toBeNull();
  expect(container.textContent).toContain("Waiting for your approval");
});

it("renders no Activity for a Turn with no tool activity", async () => {
  await render(turn({ items: [item(0, "agent_message", "hello")] }));
  expect(container.querySelector(".activity")).toBeNull();
  expect(container.textContent).toContain("hello");
});

it("keeps the Activity open while new Items stream in", async () => {
  const running = turn({ status: "running", completedAt: null, startedAt: new Date().toISOString(), items: [worked[0]] });
  await render(running);
  await click(buttonWith("Explored 1 file"));
  await render({ ...running, items: [worked[0], worked[2]] });
  expect(buttonWith("Explored 1 file · Ran 1 command")?.getAttribute("aria-expanded")).toBe("true");
});


it("copies the prompt text and the response markdown", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await render(turn({
    prompt: "Compare [a.png] with the spec",
    segments: [
      { kind: "text", text: "Compare " },
      { kind: "attachment", id: "id-a", name: "a.png", attachmentKind: "image", mediaType: "image/png", sizeBytes: 2048, path: "/h/a.png" },
      { kind: "text", text: " with the spec" },
    ],
    items: [item(0, "agent_message", "Here is **the answer**.")],
  }));

  const promptCopy = container.querySelector('[aria-label="Copy prompt"]');
  expect(promptCopy).toBeTruthy();
  await act(async () => (promptCopy as HTMLElement).click());
  expect(writeText).toHaveBeenLastCalledWith("Compare [a.png] with the spec");

  const responseCopy = container.querySelector('[aria-label="Copy response"]');
  expect(responseCopy).toBeTruthy();
  await act(async () => (responseCopy as HTMLElement).click());
  expect(writeText).toHaveBeenLastCalledWith("Here is **the answer**.");
});

it("draws Attachments as chips between the words of the prompt, the same for every Provider", async () => {
  const attachment = (name: string, attachmentKind: "image" | "pdf" | "text" | "other") => ({
    kind: "attachment" as const, id: `id-${name}`, name, attachmentKind, mediaType: "x/y", sizeBytes: 2048, path: `/h/attachments/id-${name}/${name}`,
  });
  await render(turn({
    prompt: "Compare [a.png] with [spec.pdf]",
    segments: [
      { kind: "text", text: "Compare " }, attachment("a.png", "image"),
      { kind: "text", text: " with " }, attachment("spec.pdf", "pdf"),
    ],
  }));
  const bubble = container.querySelector(".user-bubble")!;
  const chips = Array.from(bubble.querySelectorAll('[role="img"]'));
  expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Attachment, a.png, image", "Attachment, spec.pdf, PDF"]);
  expect(chips[0].getAttribute("title")).toBe("a.png · 2.0 KB");
  expect(Array.from(bubble.childNodes).map((n) => n.textContent)).toEqual(["Compare ", "a.png", " with ", "spec.pdf"]);
  expect(bubble.querySelector("img")).toBeNull();
  expect(bubble.querySelectorAll("svg.attachment-chip-icon")).toHaveLength(2);
  expect(bubble.querySelector("button")).toBeNull();
});

it("memoizes turn item grouping, model/effort parts, and prompt plain text across re-renders", async () => {
  const groupSpy = vi.spyOn(transcriptView, "groupTurnItems");
  const modelSpy = vi.spyOn(transcriptView, "modelEffortParts");
  const plainSpy = vi.spyOn(attachments, "plainText");

  const items = [worked[0], worked[3]];
  const segments = [{ kind: "text" as const, text: "Check this" }];
  const baseTurn = turn({
    status: "running",
    completedAt: null,
    model: "claude-opus-5-5",
    effort: "high",
    segments,
    items,
  });
  const onRespond = vi.fn();

  await act(async () =>
    root.render(<TurnView turn={baseTurn} provider="claude" catalog={null} onRespond={onRespond} isWorking instant />),
  );
  expect(groupSpy).toHaveBeenCalledTimes(1);
  expect(modelSpy).toHaveBeenCalledTimes(1);
  expect(plainSpy).toHaveBeenCalledTimes(1);

  groupSpy.mockClear();
  modelSpy.mockClear();
  plainSpy.mockClear();

  // Re-render when turn status/completedAt and isWorking change, while items/segments/model/effort are unchanged.
  const completedTurn = { ...baseTurn, status: "completed" as const, completedAt: "2026-10-22T10:00:42Z" };
  await act(async () =>
    root.render(<TurnView turn={completedTurn} provider="claude" catalog={null} onRespond={onRespond} isWorking={false} instant />),
  );
  expect(groupSpy).not.toHaveBeenCalled();
  expect(modelSpy).not.toHaveBeenCalled();
  expect(plainSpy).not.toHaveBeenCalled();

  // Updating items recomputes only groupTurnItems.
  await act(async () =>
    root.render(
      <TurnView
        turn={{ ...completedTurn, items: [...items, item(4, "agent_message", "More")] }}
        provider="claude"
        catalog={null}
        onRespond={onRespond}
        isWorking={false}
        instant
      />,
    ),
  );
  expect(groupSpy).toHaveBeenCalledTimes(1);
  expect(modelSpy).not.toHaveBeenCalled();
  expect(plainSpy).not.toHaveBeenCalled();
});
