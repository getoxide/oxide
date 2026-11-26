import { describe, expect, it } from "vitest";
import { packageManagerCommand } from "./packageManagerCommand";

describe("packageManagerCommand", () => {
  it("names the APT command for a deb install", () => {
    expect(packageManagerCommand("apt")).toBe("sudo apt update && sudo apt upgrade");
  });
  it("names the DNF command for an rpm install", () => {
    expect(packageManagerCommand("dnf")).toBe("sudo dnf upgrade");
  });
  it("has none for channels Oxide updates itself or never updates", () => {
    expect(packageManagerCommand("inApp")).toBeNull();
    expect(packageManagerCommand("development")).toBeNull();
  });
});
