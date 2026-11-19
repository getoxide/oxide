import { describe, expect, it } from "vitest";
import { canSubmitComment, canSubmitIssue, issuePhase, titleChanged } from "./issueView";

describe("issueView", () => {
  it("validates issue creation title", () => {
    expect(canSubmitIssue("")).toBe(false);
    expect(canSubmitIssue("   ")).toBe(false);
    expect(canSubmitIssue("Valid title")).toBe(true);
  });

  it("validates comment body", () => {
    expect(canSubmitComment("")).toBe(false);
    expect(canSubmitComment("   ")).toBe(false);
    expect(canSubmitComment("Looks good")).toBe(true);
  });

  it("tells open, completed and not planned apart", () => {
    expect(issuePhase({ state: "OPEN", stateReason: "" })).toBe("open");
    expect(issuePhase({ state: "OPEN", stateReason: "REOPENED" })).toBe("open");
    expect(issuePhase({ state: "CLOSED", stateReason: "COMPLETED" })).toBe("completed");
    expect(issuePhase({ state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe("notPlanned");
    expect(issuePhase({ state: "CLOSED", stateReason: "" })).toBe("completed");
  });

  it("sends a title only when it says something new", () => {
    expect(titleChanged("Old", "New")).toBe(true);
    expect(titleChanged("Old", " Old ")).toBe(false);
    expect(titleChanged("Old", "  ")).toBe(false);
  });
});
