// ADR-0018 (Platform layer): OS-specific code lives in `crates/oxide-platform`, nowhere else.
//
//   node tools/checks/platform-layer.mjs                   check (the fast tier and CI run this)
//   node tools/checks/platform-layer.mjs --write-baseline  lower the baseline after a migration
//
// Three rules, all text checks that give the same answer on every OS:
//
// 1. Outside the platform layer (and the test-support helpers under `tests/support/`) there is
//    no OS conditional-compilation attribute (`#[cfg(windows)]`, `unix`, `target_os`,
//    `target_family`, also inside `not(...)`, `all(...)`, `any(...)` and `cfg_attr`) and no
//    direct use of an OS-only API (`std::os::{unix,windows,...}`, `libc`, `windows_sys`,
//    `objc2*`, `winapi`, `sysinfo`). Existing violations are counted per file in
//    `platform-layer-baseline.json`; a file may not gain one, and a file that lost some must
//    lower its entry. The expression form (`cfg!(windows)`, `std::env::consts::OS`) is fine
//    anywhere: every OS compiles and checks both branches.
// 2. The platform layer's per-OS implementations (`src/unix/**`, `src/windows/**`) offer the
//    same public items with the same signatures, and select the OS with no `cfg` attribute
//    (only `src/lib.rs` does that, once per implementation).
// 3. Only the platform layer's Cargo.toml depends on OS binding crates.
//
// A text check has limits: a macro that expands to an OS attribute, or an OS API reached through a
// re-export under another name, is invisible to it. Those are left to review and to the CI
// Windows lane (docs/agents/engineering.md).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_CRATE = "crates/oxide-platform";
export const BASELINE_FILE = "tools/checks/platform-layer-baseline.json";
const IMPLEMENTATIONS = ["macos", "linux", "windows"];
const SKIPPED_DIRECTORIES = new Set(["target", "node_modules", ".git"]);
const OS_BINDING_CRATES = ["libc", "windows-sys", "windows", "winapi", "objc2", "sysinfo", "nix"];

const OS_PREDICATE = /\b(?:windows|unix|target_os|target_family|windows_subsystem)\b/;
const OS_API = /\b(?:std::os::(?:unix|windows|linux|macos|fd|raw|wasi)\b|os::(?:unix|windows)::|libc::|windows_sys\b|winapi\b|objc2\w*::|sysinfo::)/;

/** Whether a file may hold OS-specific code: the platform layer and the shared test support. */
export function isPlatformCode(file) {
  return file.startsWith(`${PLATFORM_CRATE}/`) || /^crates\/[^/]+\/tests\/support\//.test(file);
}

function* rustFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* rustFiles(join(directory, entry.name));
    } else if (entry.name.endsWith(".rs")) yield join(directory, entry.name);
  }
}

// Blank line and block comments and string literals' content, keeping every line break so line
// numbers stay right. Raw strings and char literals are rare enough here that a plain scan of
// `"..."` is the honest limit.
function strip(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (text.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else { if (text[i] === "\n") out += "\n"; i++; }
      }
      i--;
    } else if (text[i] === '"') {
      out += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") out += "\n";
        i++;
      }
      out += '"';
    } else if (text[i] === "'" && /^'(?:\\.[^']*|[^\\'])'/.test(text.slice(i, i + 12))) {
      i += text.slice(i).match(/^'(?:\\.[^']*|[^\\'])'/)[0].length - 1;
      out += "' '";
    } else out += text[i];
  }
  return out;
}

// The text inside the brackets that open at `start` (just after `[`), or the rest of the file.
function bracketed(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every OS-specific use in one Rust source, as `{ line, kind }`: `cfg` for a conditional
 * compilation attribute, `api` for a direct use of an OS-only API.
 */
export function findOsCode(source) {
  const text = strip(source);
  const found = [];
  for (const match of text.matchAll(/#!?\[\s*(cfg|cfg_attr)\s*\(/g)) {
    const attribute = bracketed(text, match.index + match[0].indexOf("[") + 1);
    if (OS_PREDICATE.test(attribute)) found.push({ line: lineOf(text, match.index), kind: "cfg" });
  }
  text.split("\n").forEach((line, index) => {
    if (OS_API.test(line)) found.push({ line: index + 1, kind: "api" });
  });
  return found;
}

/** Every file under `crates/` outside the platform layer with its OS-specific uses. */
export function scanViolations(root) {
  const files = {};
  for (const path of rustFiles(join(root, "crates"))) {
    const file = relative(root, path).split(sep).join("/");
    if (isPlatformCode(file)) continue;
    const found = findOsCode(readFileSync(path, "utf8"));
    if (found.length > 0) files[file] = found;
  }
  return files;
}

/**
 * Compares counts to the baseline. `grew` lists files that gained violations (a new file, or a
 * higher count); `shrunk` lists files whose entry must be lowered or removed.
 */
export function compareBaseline(violations, baseline) {
  const grew = [];
  const shrunk = [];
  for (const [file, found] of Object.entries(violations)) {
    const allowed = baseline[file] ?? 0;
    if (found.length > allowed) grew.push({ file, allowed, found: found.length, lines: found.map(({ line }) => line) });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = violations[file]?.length ?? 0;
    if (count < allowed) shrunk.push({ file, allowed, found: count });
  }
  return { grew, shrunk };
}

// --- Parity of the per-OS implementations ---

const ITEM = /^[ \t]*pub\s+((?:const\s+|unsafe\s+|async\s+)*(?:fn|struct|enum|trait|type|const|static|mod))\s+(\w+)/gm;

/**
 * The public items of a Rust source with their signatures, keyed by `kind name`. A function's
 * signature is the text up to its body or semicolon, whitespace collapsed.
 */
export function publicItems(source) {
  const text = strip(source);
  const items = new Map();
  for (const match of text.matchAll(ITEM)) {
    const kind = match[1].replace(/\s+/g, " ");
    let end = match.index + match[0].length;
    let signature = match[0].trim();
    if (kind.endsWith("fn") || kind.endsWith("const") || kind.endsWith("static") || kind.endsWith("type")) {
      let depth = 0;
      for (let i = end; i < text.length; i++) {
        const ch = text[i];
        if ("(<[".includes(ch)) depth++;
        else if (")>]".includes(ch) && !(ch === ">" && text[i - 1] === "-")) depth--;
        else if ((ch === "{" || ch === ";") && depth <= 0) { end = i; break; }
        else if (ch === "=" && depth <= 0 && !kind.endsWith("fn")) { end = i; break; }
      }
      signature = text.slice(match.index, end).trim();
    }
    // A leading underscore only says "unused here": `_grace` and `grace` are the same parameter.
    const normalised = signature.replace(/\s+/g, " ").replace(/,\s*\)/g, ")").replace(/\(\s+/g, "(").replace(/\b_(\w+)\s*:/g, "$1:");
    items.set(`${kind} ${match[2]}`, normalised);
  }
  return items;
}

// `pub use crate::posix::<module>::*;` re-exports the Unix code the macOS and Linux
// implementations share: its public items count as the implementation's own.
function withShared(root, source) {
  let text = source;
  for (const [, module] of source.matchAll(/pub use crate::posix::(\w+)::\*;/g)) {
    text += `\n${readFileSync(join(root, PLATFORM_CRATE, "src", "posix", `${module}.rs`), "utf8")}`;
  }
  return text;
}

/**
 * Differences between the implementations: a missing file, a missing public item or a different
 * signature, compared with the first implementation, and a `cfg` attribute that selects the OS.
 */
export function checkParity(root) {
  const problems = [];
  const files = {};
  for (const implementation of IMPLEMENTATIONS) {
    const base = join(root, PLATFORM_CRATE, "src", implementation);
    files[implementation] = new Map();
    let paths;
    try { paths = [...rustFiles(base)]; } catch { paths = []; }
    for (const path of paths) files[implementation].set(relative(base, path).split(sep).join("/"), readFileSync(path, "utf8"));
  }
  const reference = IMPLEMENTATIONS[0];
  const names = new Set(IMPLEMENTATIONS.flatMap((implementation) => [...files[implementation].keys()]));
  for (const name of names) {
    for (const implementation of IMPLEMENTATIONS) {
      if (!files[implementation].has(name)) {
        problems.push(`${PLATFORM_CRATE}/src/${implementation}/${name} is missing: the other implementations have it.`);
      }
    }
    for (const implementation of IMPLEMENTATIONS) {
      const own = files[implementation].get(name);
      if (own === undefined) continue;
      for (const { line } of findOsCode(own).filter(({ kind }) => kind === "cfg")) {
        problems.push(`${PLATFORM_CRATE}/src/${implementation}/${name}:${line} selects the OS with a cfg attribute. Only src/lib.rs picks an implementation.`);
      }
    }
    const expected = files[reference].get(name);
    if (expected === undefined) continue;
    const wanted = publicItems(withShared(root, expected));
    for (const implementation of IMPLEMENTATIONS.slice(1)) {
      const own = files[implementation].get(name);
      if (own === undefined) continue;
      const actual = publicItems(withShared(root, own));
      for (const [key, signature] of wanted) {
        if (!actual.has(key)) problems.push(`${PLATFORM_CRATE}/src/${implementation}/${name} lacks \`${key}\`, which ${reference} offers.`);
        else if (actual.get(key) !== signature) problems.push(`\`${key}\` in ${name} has different signatures:\n    ${reference}: ${signature}\n    ${implementation}: ${actual.get(key)}`);
      }
      for (const key of actual.keys()) {
        if (!wanted.has(key)) problems.push(`${PLATFORM_CRATE}/src/${reference}/${name} lacks \`${key}\`, which ${implementation} offers.`);
      }
    }
  }
  return problems;
}

// --- OS binding crates ---

/** Manifests under `crates/` other than the platform layer's that name an OS binding crate. */
export function strayBindings(root) {
  const problems = [];
  for (const entry of readdirSync(join(root, "crates"), { withFileTypes: true })) {
    if (!entry.isDirectory() || `crates/${entry.name}` === PLATFORM_CRATE) continue;
    const manifest = `crates/${entry.name}/Cargo.toml`;
    readFileSync(join(root, manifest), "utf8").split("\n").forEach((line, index) => {
      const name = line.match(/^\s*([A-Za-z0-9_-]+)\s*(?:=|\.)/)?.[1];
      if (name && (name.startsWith("objc2") || OS_BINDING_CRATES.includes(name.replaceAll("_", "-")))) {
        problems.push(`${manifest}:${index + 1}: depends on the OS binding crate \`${name}\`. Only ${PLATFORM_CRATE} does.`);
      }
    });
  }
  return problems;
}

export function readBaseline(root) {
  return JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
}

const HOW_TO_FIX =
  "OS-only code (an OS conditional-compilation attribute or an OS-only API) belongs in crates/oxide-platform: add one function to src/unix/ and the same one to src/windows/, then call it. " +
  "For a value that only differs per OS (a shell name, a flag, a suffix), use the expression form `if cfg!(windows) { .. } else { .. }`, which every OS compiles. See ADR-0018.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const github = process.env.GITHUB_ACTIONS === "true";
  const report = (message, file, line) => console.error(github && file ? `::error file=${file}${line ? `,line=${line}` : ""}::${message}` : message);
  const violations = scanViolations(root);

  if (process.argv.includes("--write-baseline")) {
    const baseline = readBaseline(root);
    const next = {};
    for (const [file, found] of Object.entries(violations)) {
      if (found.length > (baseline[file] ?? 0)) {
        console.error(`${file} has ${found.length} violations, above its baseline of ${baseline[file] ?? 0}. The baseline only shrinks: move the code to the platform layer.`);
        process.exit(1);
      }
      next[file] = found.length;
    }
    writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
    console.log(`Baseline written: ${Object.keys(next).length} files, ${Object.values(next).reduce((sum, count) => sum + count, 0)} violations.`);
    process.exit(0);
  }

  const { grew, shrunk } = compareBaseline(violations, readBaseline(root));
  let failed = false;
  for (const { file, allowed, found, lines } of grew) {
    failed = true;
    for (const line of lines) report(`${file}:${line}: OS-specific code outside the platform layer (${found} in this file, baseline ${allowed}). ${HOW_TO_FIX}`, file, line);
  }
  for (const { file, allowed, found } of shrunk) {
    failed = true;
    report(`${file} now has ${found} OS-specific uses, below its baseline of ${allowed}. Lower the baseline so it cannot grow back: node tools/checks/platform-layer.mjs --write-baseline`, BASELINE_FILE);
  }
  for (const problem of [...checkParity(root), ...strayBindings(root)]) {
    failed = true;
    report(problem, undefined);
  }
  if (!failed) console.log("OS-specific code stays in the platform layer; the per-OS implementations match.");
  process.exitCode = failed ? 1 : 0;
}
