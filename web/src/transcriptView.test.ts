import { describe, expect, it } from "vitest";
import type { ItemSnapshot, ModelInfo } from "./bindings";
import { formatElapsed, liveStatus, STATUS_PHRASES, statusPhrase, summaryText, type Activity } from "./activity";
import { groupTurnItems, splitHeadline, formatTime, modelEffortParts } from "./transcriptView";

let nextId = 1;
function item(
  itemIndex: number,
  kind: ItemSnapshot["kind"],
  content = "",
  parentItemIndex: number | null = null,
  category: ItemSnapshot["category"] = null,
): ItemSnapshot {
  return { id: nextId++, itemIndex, kind, content, parentItemIndex, category, command: { line: null, outcome: "unknown", exitCode: null }, createdAt: "2026-10-22T10:00:00Z" };
}

function activityOf(items: ItemSnapshot[]): Activity | null {
  const block = groupTurnItems(items).find((b) => b.type === "activity");
  return block?.type === "activity" ? block.activity : null;
}

describe("groupTurnItems", () => {
  it("puts everything the Provider did into one Activity above the agent's messages", () => {
    const blocks = groupTurnItems([
      item(0, "agent_message", "looking"),
      item(1, "tool_call", "Read a", null, "explore"),
      item(2, "tool_call", "Run b", null, "run"),
      item(3, "agent_message", "done"),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["activity", "message", "message"]);
  });

  it("marks only the last top-level agent message as the final answer", () => {
    const blocks = groupTurnItems([
      item(0, "agent_message", "thinking out loud"),
      item(1, "tool_call", "Read a", null, "explore"),
      item(2, "agent_message", "final"),
    ]);
    const messages = blocks.filter((b) => b.type === "message");
    expect(messages.map((m) => m.type === "message" && m.final)).toEqual([false, true]);
  });

  it("draws Slash command output as its own block, never a message or Activity", () => {
    const blocks = groupTurnItems([item(0, "slash_command_output", "| a |")]);
    expect(blocks.map((b) => b.type)).toEqual(["command"]);
  });

  it("draws a restore mark as its own block, never a message or Activity", () => {
    const blocks = groupTurnItems([
      item(0, "agent_message", "done"),
      item(1, "restore_marker", "Restored the files to how they were before Turn 1."),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["message", "restore"]);
  });

  it("renders no Activity for a Turn without tool-like Items", () => {
    expect(groupTurnItems([item(0, "agent_message", "hi")]).map((b) => b.type)).toEqual(["message"]);
  });

  it("renders nothing for a reasoning Item without text", () => {
    expect(groupTurnItems([item(0, "reasoning", "  ")])).toEqual([]);
  });

  it("treats an orphaned child (parent missing) as top level", () => {
    expect(activityOf([item(5, "tool_call", "x", 99, "run")])?.phases.map((p) => p.kind)).toEqual(["run"]);
  });
});

describe("Activity phases", () => {
  it("merges consecutive Items of one kind and starts a new Phase when the kind returns", () => {
    const activity = activityOf([
      item(0, "reasoning", "hmm"),
      item(1, "tool_call", "Read a", null, "explore"),
      item(2, "tool_call", "Grep b", null, "explore"),
      item(3, "file_change", "src/a.rs"),
      item(4, "tool_call", "Read c", null, "explore"),
    ]);
    expect(activity?.phases.map((p) => [p.kind, p.items.length])).toEqual([
      ["reasoning", 1],
      ["explore", 2],
      ["edit", 1],
      ["explore", 1],
    ]);
  });

  it("falls back on the Item kind for Items stored without a category", () => {
    const activity = activityOf([
      item(0, "tool_call", "view_file x"),
      item(1, "file_change", "src/a.rs"),
      item(2, "subagent", "Explore"),
      item(3, "reasoning", "hmm"),
    ]);
    expect(activity?.phases.map((p) => p.kind)).toEqual(["other", "edit", "delegate", "reasoning"]);
  });

  it("files a tool call the adapter categorised as edit or delegate under that Phase", () => {
    const activity = activityOf([item(0, "tool_call", "x", null, "edit"), item(1, "tool_call", "Task y", null, "delegate")]);
    expect(activity?.phases.map((p) => p.kind)).toEqual(["edit", "delegate"]);
  });

  it("nests Subagent children inside a Delegate phase, out of the top level", () => {
    const activity = activityOf([
      item(0, "subagent", "Explore"),
      item(1, "tool_call", "Grep", 0, "explore"),
      item(2, "agent_message", "found", 0),
      item(3, "agent_message", "final"),
    ]);
    expect(activity?.phases).toHaveLength(1);
    expect(activity?.phases[0].kind).toBe("delegate");
    expect(activity?.phases[0].items[0].children.map((c) => c.kind)).toEqual(["tool_call", "agent_message"]);
    const blocks = groupTurnItems([item(0, "subagent", "Explore"), item(2, "agent_message", "found", 0), item(3, "agent_message", "final")]);
    // A nested message never counts as the Turn's final answer, nor shows outside the Activity.
    expect(blocks.filter((b) => b.type === "message")).toHaveLength(1);
  });
});

describe("Activity summary", () => {
  it("counts distinct files explored and edited, commands run and tasks delegated", () => {
    const activity = activityOf([
      item(0, "tool_call", "Read a.ts", null, "explore"),
      item(1, "tool_call", "Read a.ts", null, "explore"),
      item(2, "tool_call", "Read b.ts", null, "explore"),
      item(3, "file_change", "src/a.rs"),
      item(4, "file_change", "src/a.rs"),
      item(5, "file_change", "src/b.rs"),
      item(6, "tool_call", "Run x", null, "run"),
      item(7, "tool_call", "Run y", null, "run"),
      item(8, "tool_call", "Run z", null, "run"),
    ]);
    expect(activity && summaryText(activity)).toBe("Explored 2 files · Edited 2 files · Ran 3 commands");
  });

  it("omits chips with a zero count and shows reasoning as a phase, not a chip", () => {
    const activity = activityOf([item(0, "reasoning", "hmm"), item(1, "tool_call", "Run x", null, "run")]);
    expect(activity?.chips.map((c) => c.label)).toEqual(["Ran 1 command"]);
    expect(activity?.phases[0].kind).toBe("reasoning");
  });

  it("groups unrecognised tools under a generic chip", () => {
    const activity = activityOf([item(0, "tool_call", "Frobnicate", null, "other")]);
    expect(activity?.chips.map((c) => c.label)).toEqual(["Used 1 tool"]);
  });
});

describe("live status", () => {
  it("ponders before anything has happened or while reasoning is the latest step", () => {
    expect(liveStatus(null).category).toBe("pondering");
    expect(liveStatus(activityOf([item(0, "reasoning", "hmm")])).category).toBe("pondering");
  });

  it("names the kind of the latest step and its target", () => {
    const status = liveStatus(
      activityOf([item(0, "tool_call", "Read a.ts\nbody", null, "explore"), item(1, "tool_call", "Run cargo test", null, "run")]),
    );
    expect(status).toEqual({ category: "run", subline: "Run cargo test" });
  });

  it("only ever picks a phrase from the kind's pool, rotating within it", () => {
    for (const category of Object.keys(STATUS_PHRASES) as (keyof typeof STATUS_PHRASES)[]) {
      for (let r = 0; r < 7; r++) expect(STATUS_PHRASES[category]).toContain(statusPhrase(category, r));
    }
    expect(statusPhrase("explore", 0)).not.toBe(statusPhrase("explore", 1));
  });

  it("formats how long a Turn worked", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("splitHeadline", () => {
  it("splits the first line from the detail", () => {
    expect(splitHeadline("Read a\nline1\nline2")).toEqual({ headline: "Read a", detail: "line1\nline2" });
    expect(splitHeadline("only")).toEqual({ headline: "only", detail: "" });
  });
});

describe("labels", () => {
  const catalog: ModelInfo[] = [
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", description: null, supportedEfforts: [], defaultEffort: null, isLegacy: false },
    { id: "claude-opus-5-5", name: "Opus 5.5", description: null, supportedEfforts: [], defaultEffort: null, isLegacy: false },
  ];

  it("formats Model · Effort, omitting what is unknown", () => {
    expect(modelEffortParts("Opus 5.5", "high")).toEqual({ model: "Opus 5.5", effort: "High" });
    expect(modelEffortParts("Opus 5.5", null)).toEqual({ model: "Opus 5.5", effort: null });
    expect(modelEffortParts(null, null)).toEqual({ model: "default model", effort: null });
  });

  it("uses the catalog's name for the Model", () => {
    expect(modelEffortParts("claude-opus-5-5", "high", catalog)).toEqual({ model: "Opus 5.5", effort: "High" });
  });

  it("humanizes a raw slug when the catalog does not know the Model", () => {
    expect(modelEffortParts("gemini-3.8-flash-low", "low", null)).toEqual({ model: "Gemini 3.8 Flash", effort: "Low" });
    expect(modelEffortParts("claude-future-9", null, null)).toEqual({ model: "Claude Future 9", effort: null });
  });

  it("keeps the Effort the Model carries when the Turn has no separate value", () => {
    expect(modelEffortParts("gemini-3.8-flash-low", null, null)).toEqual({ model: "Gemini 3.8 Flash", effort: "Low" });
    expect(modelEffortParts("gpt-5-1-codex-high", null, null)).toEqual({ model: "GPT 5.1 Codex", effort: "High" });
    expect(modelEffortParts("gemini-3.8-flash-high", null, catalog)).toEqual({ model: "Gemini 3.8 Flash", effort: "High" });
    expect(
      modelEffortParts("gemini-3.8-flash", null, [
        { ...catalog[0]!, id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (XHigh)" },
      ]),
    ).toEqual({ model: "Gemini 3.8 Flash", effort: "Extra High" });
    expect(
      modelEffortParts("claude-opus-5-5", null, [
        { ...catalog[1]!, name: "Opus 5.5 · max" },
      ]),
    ).toEqual({ model: "Opus 5.5", effort: "Max" });
  });

  it("never repeats the Effort the Model name carries", () => {
    expect(modelEffortParts("gemini-3.8-flash-low", "low", catalog)).toEqual({ model: "Gemini 3.8 Flash", effort: "Low" });
    expect(modelEffortParts("gemini-3.8-flash-high", "high", [{ ...catalog[0]!, id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash - High" }])).toEqual({
      model: "Gemini 3.8 Flash",
      effort: "High",
    });
  });

  it("capitalizes every Effort level", () => {
    expect(modelEffortParts("Opus 5.5", "low")).toEqual({ model: "Opus 5.5", effort: "Low" });
    expect(modelEffortParts("Opus 5.5", "medium")).toEqual({ model: "Opus 5.5", effort: "Medium" });
    expect(modelEffortParts("Opus 5.5", "high")).toEqual({ model: "Opus 5.5", effort: "High" });
    expect(modelEffortParts("Opus 5.5", "max")).toEqual({ model: "Opus 5.5", effort: "Max" });
  });

  it("formats an ISO time as HH:MM", () => {
    expect(formatTime("2026-10-22T10:05:00Z")).toMatch(/\d{1,2}:05/);
  });
});
