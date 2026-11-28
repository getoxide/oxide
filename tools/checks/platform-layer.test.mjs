import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkParity, compareBaseline, findOsCode, isPlatformCode, publicItems, scanViolations, strayBindings } from "./platform-layer.mjs";

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "oxide-platform-layer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const kinds = (source) => findOsCode(source).map(({ line, kind }) => `${line}:${kind}`);

test("OS conditional-compilation attributes are found in every form", () => {
  const source = [
    "#[cfg(windows)]", "fn a() {}",
    "#[cfg(not(unix))]", "fn b() {}",
    '#[cfg(target_os = "macos")]', "fn c() {}",
    "#[cfg(all(test, windows))]", "mod d {}",
    "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]",
    "#[cfg_attr(unix, derive(Debug))]", "struct E;",
    "#[cfg(\n    any(unix, windows)\n)]", "fn f() {}",
  ].join("\n");
  assert.deepEqual(kinds(source), ["1:cfg", "3:cfg", "5:cfg", "7:cfg", "9:cfg", "10:cfg", "12:cfg"]);
});

test("the expression form and unrelated attributes pass", () => {
  const source = 'fn f() -> &\'static str { if cfg!(windows) { "cmd" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" } }\n#[cfg(test)]\nmod t {}\n#[cfg(feature = "x")]\nfn g() {}\n';
  assert.deepEqual(kinds(source), []);
});

test("OS-only APIs are found, comments and strings are not", () => {
  const source = [
    "use std::os::unix::fs::PermissionsExt;",
    "let n = libc::kill(1, 0);",
    "use windows_sys::Win32::Foundation::CloseHandle;",
    "use objc2_foundation::NSString;",
    "// std::os::unix is fine in a comment",
    'let s = "libc::kill";',
    "/* windows_sys::x */",
  ].join("\n");
  assert.deepEqual(kinds(source), ["1:api", "2:api", "3:api", "4:api"]);
});

test("the platform layer and test support are exempt, everything else is scanned", (t) => {
  const bad = "#[cfg(windows)]\nfn f() {}\n";
  const root = repo(t, {
    "crates/oxide-platform/src/imp/windows/process.rs": bad,
    "crates/oxide-core/tests/support/mod.rs": bad,
    "crates/oxide-core/src/a.rs": bad,
    "crates/oxide-core/tests/b.rs": bad,
  });
  assert.deepEqual(Object.keys(scanViolations(root)).sort(), ["crates/oxide-core/src/a.rs", "crates/oxide-core/tests/b.rs"]);
  assert.ok(isPlatformCode("crates/oxide-platform/src/lib.rs"));
  assert.ok(!isPlatformCode("crates/oxide-core/tests/support.rs"));
});

test("the baseline blocks growth, new files and silent shrinking", () => {
  const found = (n) => Array.from({ length: n }, (_, i) => ({ line: i + 1, kind: "cfg" }));
  assert.deepEqual(compareBaseline({ "a.rs": found(2) }, { "a.rs": 2 }), { grew: [], shrunk: [] });
  assert.equal(compareBaseline({ "a.rs": found(3) }, { "a.rs": 2 }).grew[0].file, "a.rs");
  assert.equal(compareBaseline({ "new.rs": found(1) }, {}).grew[0].file, "new.rs");
  assert.deepEqual(compareBaseline({ "a.rs": found(1) }, { "a.rs": 2 }).shrunk, [{ file: "a.rs", allowed: 2, found: 1 }]);
  assert.deepEqual(compareBaseline({}, { "gone.rs": 4 }).shrunk, [{ file: "gone.rs", allowed: 4, found: 0 }]);
});

test("public items carry their signatures", () => {
  const items = publicItems("pub fn a(x: i32,\n    y: &str) -> Result<(), E> {\n}\npub struct S;\nfn private() {}\npub const N: u32 = 3;\n");
  assert.equal(items.get("fn a"), "pub fn a(x: i32, y: &str) -> Result<(), E>");
  assert.ok(items.has("struct S"));
  assert.ok(items.has("const N"));
  assert.ok(!items.has("fn private"));
});

const three = (files) => Object.fromEntries(
  Object.entries(files).flatMap(([name, bodies]) => [
    [`crates/oxide-platform/src/${name}`, "// the contract\n"],
    ...["macos", "linux", "windows"].map((os, i) => [`crates/oxide-platform/src/imp/${os}/${name}`, bodies[Math.min(i, bodies.length - 1)]]),
  ]),
);

test("parity: equal implementations pass, a missing function or a different signature fails", (t) => {
  const same = repo(t, three({ "process.rs": ["pub fn kill(pid: i32) -> bool { true }\n"] }));
  assert.deepEqual(checkParity(same), []);

  const missing = repo(t, three({ "process.rs": ["pub fn kill(pid: i32) {}\npub fn alive(pid: i32) -> bool { true }\n", "pub fn kill(pid: i32) {}\npub fn alive(pid: i32) -> bool { true }\n", "pub fn kill(pid: i32) {}\n"] }));
  assert.match(checkParity(missing).join("\n"), /lacks `fn alive`/);

  const different = repo(t, three({ "process.rs": ["pub fn kill(pid: i32) {}\n", "pub fn kill(pid: i32) {}\n", "pub fn kill(pid: u32) {}\n"] }));
  assert.match(checkParity(different).join("\n"), /different signatures/);

  const lonely = repo(t, {
    "crates/oxide-platform/src/imp/macos/fs.rs": "pub fn f() {}\n",
    "crates/oxide-platform/src/imp/linux/fs.rs": "pub fn f() {}\n",
    "crates/oxide-platform/src/imp/windows/process.rs": "",
  });
  assert.equal(checkParity(lonely).filter((p) => /is missing/.test(p)).length, 3);
});

test("contract: every implementation module has its contract at the crate root", (t) => {
  const root = repo(t, {
    "crates/oxide-platform/src/fs.rs": "pub fn f() {}\n",
    ...Object.fromEntries(["macos", "linux", "windows"].flatMap((os) => [
      [`crates/oxide-platform/src/imp/${os}/mod.rs`, "pub mod fs;\npub mod env;\n"],
      [`crates/oxide-platform/src/imp/${os}/fs.rs`, "pub fn f() {}\n"],
      [`crates/oxide-platform/src/imp/${os}/env.rs`, "pub fn g() {}\n"],
    ])),
  });
  const problems = checkParity(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /imp\/\*\/env\.rs has no contract/);
});

test("parity: an implementation may not select the OS with a cfg attribute", (t) => {
  const root = repo(t, three({ "process.rs": ["#[cfg(unix)]\npub fn kill() {}\n", "pub fn kill() {}\n"] }));
  assert.match(checkParity(root).join("\n"), /process.rs:1 selects the OS/);
});

test("OS binding crates may be declared only by the platform layer", (t) => {
  const root = repo(t, {
    "crates/oxide-platform/Cargo.toml": "[dependencies]\nlibc = { workspace = true }\n",
    "crates/oxide-core/Cargo.toml": "[dependencies]\nserde = { workspace = true }\n[target.'cfg(windows)'.dependencies]\nsysinfo = \"0.40\"\n",
    "crates/oxide-app/Cargo.toml": "[dependencies]\nobjc2-app-kit = \"1\"\nwindows-sys = { workspace = true }\n",
  });
  const problems = strayBindings(root);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => !p.startsWith("crates/oxide-platform/")));
});
