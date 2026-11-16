// ADR-0016 (Processes): `git` and `gh` are started only by the hardened builders.
//
//   node tools/checks/process-builders.mjs
//
// Fails on a `Command::new(...)` in Rust source whose program is `git` or `gh`
// (also `git.exe`, `gh.exe`, or a lookup such as `resolve("gh")`) outside
// ALLOWED_BUILDERS. Integration tests under `tests/` may start Git to build
// fixtures. Adding a file to ALLOWED_BUILDERS needs a line in ADR-0016.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The only files allowed to start Git or `gh`: the hardened builders. */
export const ALLOWED_BUILDERS = [
  "crates/oxide-core/src/git_command.rs",
  "crates/oxide-core/src/github.rs",
];

const SKIPPED_DIRECTORIES = new Set(["target", "node_modules", ".git", "tests"]);
const PROGRAM = /["'](?:git|gh)(?:\.exe)?["']/;

function* rustFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* rustFiles(join(directory, entry.name));
    } else if (entry.name.endsWith(".rs")) yield join(directory, entry.name);
  }
}

// The text inside the parentheses that open at `start`, or the rest of the file.
function callArguments(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return text.slice(start, index);
  }
  return text.slice(start);
}

/** Every `Command::new` of git or gh outside the allowed builders, as `{ file, line }`. */
export function findStrayProcesses(root) {
  const found = [];
  const crates = join(root, "crates");
  let files;
  try { files = [...rustFiles(crates)]; } catch { return found; }
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    if (ALLOWED_BUILDERS.includes(file)) continue;
    // Blank whole-line comments, keeping line numbers.
    const text = readFileSync(path, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const match of text.matchAll(/Command::new\(/g)) {
      if (PROGRAM.test(callArguments(text, match.index + match[0].length))) {
        found.push({ file, line: text.slice(0, match.index).split("\n").length });
      }
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const stray = findStrayProcesses(root);
  for (const { file, line } of stray) {
    const message = `${file}:${line}: starts git or gh outside the hardened builders (${ALLOWED_BUILDERS.join(", ")}). See ADR-0016.`;
    console.error(process.env.GITHUB_ACTIONS === "true" ? `::error file=${file},line=${line}::${message}` : message);
  }
  if (stray.length === 0) console.log("No git or gh process is started outside the hardened builders.");
  process.exitCode = stray.length === 0 ? 0 : 1;
}
