import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsCheckEnvironment, windowsCheckNotice, windowsStateHash, writeWindowsStamp, WINDOWS_IMPLEMENTATION } from "./windows-check.mjs";

test("the environment adds Homebrew's LLVM to the PATH and neutralises the linker flag", () => {
  const exists = (path) => path === "/opt/homebrew/opt/llvm/bin/llvm-lib";
  const { env, problems } = windowsCheckEnvironment({ PATH: "/usr/bin" }, { exists });
  assert.deepEqual(problems, []);
  assert.equal(env.PATH, "/opt/homebrew/opt/llvm/bin:/usr/bin");
  assert.equal(env.RUSTFLAGS, "-Cdebuginfo=0");
});

test("a caller's RUSTFLAGS and an llvm-lib already on the PATH are left alone", () => {
  const { env, problems } = windowsCheckEnvironment({ PATH: "/tools:/usr/bin", RUSTFLAGS: "-Cfoo" }, { exists: (path) => path === "/tools/llvm-lib" });
  assert.deepEqual(problems, []);
  assert.equal(env.PATH, "/tools:/usr/bin");
  assert.equal(env.RUSTFLAGS, "-Cfoo");
});

test("a missing cargo-xwin or llvm-lib is named with what to install", () => {
  const { problems } = windowsCheckEnvironment({ PATH: "/usr/bin" }, { exists: () => false, hasXwin: false });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /cargo install --locked cargo-xwin/);
  assert.match(problems[1], /brew install llvm/);
});

test("the notice appears only for a changed Windows implementation without a passing check", () => {
  assert.equal(windowsCheckNotice({ changed: [], hash: "a", stamp: undefined }), undefined);
  assert.equal(windowsCheckNotice({ changed: ["x.rs"], hash: "a", stamp: "a" }), undefined);
  assert.match(windowsCheckNotice({ changed: ["x.rs"], hash: "a", stamp: undefined }), /node tools\/check\.mjs windows/);
  assert.match(windowsCheckNotice({ changed: ["x.rs"], hash: "b", stamp: "a" }), /1 file\(s\)/);
  assert.match(windowsCheckNotice({ changed: undefined, hash: "b", stamp: "a" }), /Windows implementation/);
  assert.equal(windowsCheckNotice({ changed: undefined, hash: "a", stamp: "a" }), undefined);
});

test("the stamp follows the contents of the Windows implementation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oxide-windows-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, WINDOWS_IMPLEMENTATION), { recursive: true });
  writeFileSync(join(root, WINDOWS_IMPLEMENTATION, "process.rs"), "pub fn a() {}\n");
  const before = windowsStateHash(root);
  writeWindowsStamp(root);
  assert.equal(windowsStateHash(root), before);
  writeFileSync(join(root, WINDOWS_IMPLEMENTATION, "process.rs"), "pub fn b() {}\n");
  assert.notEqual(windowsStateHash(root), before);
});
