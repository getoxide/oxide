import { expect, it } from "vitest";
import { openTerminal, programName, renameTerminal, setRunning, terminalTitle } from "./terminalTabs";

it("names the program a command line runs, past assignments, wrappers and paths", () => {
  expect(programName("vim notes.md")).toBe("vim");
  expect(programName("sudo dnf install zapfast")).toBe("dnf");
  expect(programName("RUST_LOG=debug cargo test")).toBe("cargo");
  expect(programName("env NODE_ENV=test pnpm test")).toBe("pnpm");
  expect(programName("sudo -E nice -n 5 make")).toBe("make");
  expect(programName("sudo -u postgres psql")).toBe("psql");
  expect(programName("/usr/bin/htop")).toBe("htop");
  expect(programName("./scripts/dev.sh --watch")).toBe("dev.sh");
  expect(programName("cargo build && cargo test | tee log")).toBe("cargo");
  expect(programName("  \nnpm run dev")).toBe("npm");
  expect(programName('FOO="a b" cargo run')).toBe("cargo");
  expect(programName("(cd web && pnpm dev)")).toBe("cd");
  expect(programName("FOO=1")).toBeNull();
  expect(programName("")).toBeNull();
  expect(programName(null)).toBeNull();
});

it("shows the running program in place of the default name, and the default name again once idle", () => {
  let state = openTerminal({}, 1);
  const tab = () => state[1].tabs[0];
  expect(terminalTitle(tab())).toBe("Terminal 1");
  state = setRunning(state, 1, 1, "sudo dnf update");
  expect(terminalTitle(tab())).toBe("dnf");
  state = setRunning(state, 1, 1, null);
  expect(terminalTitle(tab())).toBe("Terminal 1");
});

it("keeps a name given by hand while programs run", () => {
  let state = renameTerminal(openTerminal({}, 1), 1, 1, " backend ");
  state = setRunning(state, 1, 1, "cargo test");
  expect(state[1].tabs[0]).toMatchObject({ name: "backend", customName: true });
  expect(terminalTitle(state[1].tabs[0])).toBe("backend");
});
