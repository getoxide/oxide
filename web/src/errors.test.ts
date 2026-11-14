import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("extracts messages from strings, Error instances, and message-bearing objects", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ message: "ipc error" })).toBe("ipc error");
    expect(errorMessage(404)).toBe("404");
  });

  it("uses the explicit fallback when the thrown value has no message", () => {
    expect(errorMessage({}, "The file could not be attached.")).toBe("The file could not be attached.");
    expect(errorMessage(null, "The file could not be attached.")).toBe("The file could not be attached.");
    expect(errorMessage(undefined, "The file could not be attached.")).toBe("The file could not be attached.");
    expect(errorMessage("specific error", "The file could not be attached.")).toBe("specific error");
    expect(errorMessage({ message: "too large" }, "The file could not be attached.")).toBe("too large");
  });
});
