// The local Windows check (ADR-0019): `node tools/check.mjs windows` cross-compiles the workspace
// for Windows and runs Clippy, so a contributor on macOS or Linux sees a Windows-only mistake in
// the platform layer before pushing. Helpers for the runner:
//
// - `windowsCheckEnvironment`: what cargo-xwin needs, or what to install.
// - a stamp of the Windows implementation's files, written when the check passes, so the full
//   check can say "you changed a Windows implementation and have not run the Windows check".
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const WINDOWS_IMPLEMENTATION = "crates/oxide-platform/src/windows";
const STAMP = "target/windows-check-stamp.json";
// Where Homebrew puts a full LLVM, which has `llvm-lib` (C dependencies such as `ring` need it).
const LLVM_DIRECTORIES = ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"];

/**
 * The environment for the Windows check, or what is missing. cargo-xwin needs LLVM's `llvm-lib`
 * on the PATH. `RUSTFLAGS` is set because cargo-xwin cannot read the Windows linker flag in
 * `.cargo/config.toml` (it contains spaces); the flag only matters when linking, which a check
 * does not do.
 */
export function windowsCheckEnvironment(env, { exists = existsSync, hasXwin = true } = {}) {
  const problems = [];
  const next = { ...env };
  if (!hasXwin) problems.push("cargo-xwin is not installed. Install it with: cargo install --locked cargo-xwin");
  const path = (env.PATH ?? "").split(delimiter);
  const hasLlvmLib = path.some((directory) => directory && exists(join(directory, "llvm-lib")));
  if (!hasLlvmLib) {
    const llvm = LLVM_DIRECTORIES.find((directory) => exists(join(directory, "llvm-lib")));
    if (llvm) next.PATH = [llvm, ...path].join(delimiter);
    else problems.push("llvm-lib is not on the PATH. Install LLVM with: brew install llvm (Linux: your package manager's llvm package)");
  }
  next.RUSTFLAGS = env.RUSTFLAGS ?? "-Cdebuginfo=0";
  return { env: next, problems };
}

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) yield* files(join(directory, entry.name));
    else yield join(directory, entry.name);
  }
}

/** A hash of the Windows implementation's files (names and contents). */
export function windowsStateHash(root) {
  const hash = createHash("sha256");
  const base = join(root, WINDOWS_IMPLEMENTATION);
  if (existsSync(base)) {
    for (const path of files(base)) hash.update(path.slice(root.length)).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

export function writeWindowsStamp(root) {
  const path = join(root, STAMP);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ hash: windowsStateHash(root) })}\n`);
}

function readWindowsStamp(root) {
  try {
    return JSON.parse(readFileSync(join(root, STAMP), "utf8")).hash;
  } catch {
    return undefined;
  }
}

/** The Windows implementation files that differ from `origin/main`, or `undefined` when Git cannot say. */
export function changedWindowsFiles(root) {
  const result = spawnSync("git", ["diff", "--name-only", "origin/main", "--", WINDOWS_IMPLEMENTATION], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * What the full check says about the Windows check: nothing when no Windows implementation file
 * changed or the check has passed on the current files, else a notice to run it.
 */
export function windowsCheckNotice({ changed, hash, stamp }) {
  if (changed !== undefined && changed.length === 0) return undefined;
  if (stamp === hash) return undefined;
  const what = changed === undefined ? "the Windows implementation of the platform layer" : `${changed.length} file(s) of the Windows implementation of the platform layer`;
  return `NOTICE: you changed ${what} and the Windows check has not passed on the current files. Run: node tools/check.mjs windows`;
}

/** The notice for this checkout, or `undefined`. */
export function currentWindowsNotice(root) {
  return windowsCheckNotice({ changed: changedWindowsFiles(root), hash: windowsStateHash(root), stamp: readWindowsStamp(root) });
}
