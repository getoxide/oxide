import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_BUILDERS, findStrayProcesses } from "./process-builders.mjs";

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "oxide-process-builders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const stray = (root) => findStrayProcesses(root).map(({ file, line }) => `${file}:${line}`);

test("a Git process created outside the builders fails the check", (t) => {
  const root = repo(t, { "crates/oxide-core/src/sneaky.rs": 'fn f() {\n    let _ = Command::new("git").arg("status");\n}\n' });
  assert.deepEqual(stray(root), ["crates/oxide-core/src/sneaky.rs:2"]);
});

test("gh, git.exe, qualified paths and multi-line calls are all caught", (t) => {
  const root = repo(t, {
    "crates/a/src/one.rs": 'let c = std::process::Command::new("gh");\n',
    "crates/a/src/two.rs": 'let c = Command::new("git.exe");\n',
    "crates/a/src/three.rs": 'let c = tokio::process::Command::new(\n    resolve("gh").unwrap(),\n);\n',
    "crates/a/src/four.rs": 'let c = Command::new( "git" );\n',
  });
  assert.deepEqual(stray(root).sort(), ["crates/a/src/four.rs:1", "crates/a/src/one.rs:1", "crates/a/src/three.rs:1", "crates/a/src/two.rs:1"]);
});

test("the hardened builders are allowed", (t) => {
  const files = Object.fromEntries(ALLOWED_BUILDERS.map((path) => [path, 'let c = Command::new(find("gh")); let d = Command::new("git");\n']));
  assert.deepEqual(stray(repo(t, files)), []);
});

test("other programs, other arguments, comments and integration tests are allowed", (t) => {
  const root = repo(t, {
    "crates/a/src/ok.rs": 'let c = Command::new("ps").args(["-A"]); let d = Command::new("sh").arg("git");\n',
    "crates/a/tests/fixture.rs": 'let c = Command::new("git").arg("init");\n',
    "crates/a/src/comment.rs": '// Command::new("git") is forbidden here\n',
  });
  assert.deepEqual(stray(root), []);
});

test("src/**/tests modules are scanned, only crates/<crate>/tests is exempt", (t) => {
  const root = repo(t, {
    "crates/a/src/tests/helper.rs": 'let c = Command::new("git");\n',
    "crates/a/src/deep/tests/helper.rs": 'let c = Command::new("gh");\n',
    "crates/a/tests/fixture.rs": 'let c = Command::new("git");\n',
  });
  assert.deepEqual(stray(root).sort(), ["crates/a/src/deep/tests/helper.rs:1", "crates/a/src/tests/helper.rs:1"]);
});

test("a first argument that names git or gh as an identifier is caught", (t) => {
  const root = repo(t, {
    "crates/a/src/one.rs": "let c = Command::new(git_path);\n",
    "crates/a/src/two.rs": "let c = std::process::Command::new(GH);\n",
    "crates/a/src/three.rs": "let c = Command::new(&git);\n",
    "crates/a/src/split.rs": "let c = Command\n    ::new(\n        git,\n    );\n",
  });
  assert.deepEqual(stray(root).sort(), ["crates/a/src/one.rs:1", "crates/a/src/split.rs:1", "crates/a/src/three.rs:1", "crates/a/src/two.rs:1"]);
});

test("other non-literal programs and identifiers that merely contain git are allowed", (t) => {
  const root = repo(t, {
    "crates/a/src/ok.rs": "let a = Command::new(os_tool(\"ps\")); let b = Command::new(shell()); let c = Command::new(digit_path); let d = Command::new(helpers::DITTO); let e = Command::new(legit);\n",
  });
  assert.deepEqual(stray(root), []);
});

test("an unreadable directory fails the check instead of passing it", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const root = repo(t, { "crates/a/src/locked/x.rs": 'let c = Command::new("git");\n' });
  const locked = join(root, "crates/a/src/locked");
  chmodSync(locked, 0o000);
  try {
    assert.throws(() => findStrayProcesses(root));
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("a missing crates directory fails the check", (t) => {
  assert.throws(() => findStrayProcesses(repo(t, {})));
});

test("the real repository is clean", () => {
  assert.deepEqual(findStrayProcesses(fileURLToPath(new URL("../../", import.meta.url))), []);
});
