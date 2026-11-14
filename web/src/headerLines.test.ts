import { describe, expect, it } from "vitest";
import { displayPath, middleEllipsis, readableModel, readablePath } from "./headerLines";

describe("displayPath", () => {
  it("shortens the home directory to ~", () => {
    expect(displayPath("/Users/lorenzo/Developer/oxide")).toBe("~/Developer/oxide");
    expect(displayPath("/home/lorenzo/code")).toBe("~/code");
    expect(displayPath("/opt/work")).toBe("/opt/work");
  });
});

describe("readablePath", () => {
  it("shows Windows canonical paths without the extended-length prefix", () => {
    const winPath = String.raw`\\?\C:\Users\mbena\Documents\spotify_analysis`;
    expect(displayPath(winPath)).toBe(String.raw`C:\Users\mbena\Documents\spotify_analysis`);
    expect(readablePath(winPath)).toBe(String.raw`C:\Users\mbena\Documents\spotify_analysis`);
    expect(displayPath(String.raw`\\?\UNC\server\share\repo`)).toBe(String.raw`\\server\share\repo`);
    expect(readablePath(String.raw`\\?\Volume{1234}\work`)).toBe(String.raw`\\?\Volume{1234}\work`);
  });
});

describe("middleEllipsis", () => {
  it("leaves a short path alone", () => {
    expect(middleEllipsis("~/Developer/oxide", 40)).toBe("~/Developer/oxide");
  });

  it("cuts a long path in the middle, keeping both ends", () => {
    const cut = middleEllipsis("~/Developer/project/oxide/.claude/worktrees/feat+147-thread-header-banner", 40);
    expect(cut).toHaveLength(40);
    expect(cut.startsWith("~/Developer/")).toBe(true);
    expect(cut.endsWith("thread-header-banner")).toBe(true);
    expect(cut).toContain("…");
  });
});

describe("readableModel", () => {
  it("drops an effort the Model slug carries, even without a catalog", () => {
    expect(readableModel("gemini-3.8-flash-low", null)).toBe("Gemini 3.8 Flash");
    expect(readableModel("gpt-5-1-codex-high", null)).toBe("GPT 5.1 Codex");
  });
});
