// ADR-0016 (Processes): `git` and `gh` are started only by the hardened builders.
//
//   node tools/checks/process-builders.mjs
//
// Fails on a `Command::new(...)` in Rust source whose program is `git` or `gh`
// (also `git.exe`, `gh.exe`, or a lookup such as `resolve("gh")`) outside
// ALLOWED_BUILDERS. A first argument that is not a string literal is flagged when it
// names git or gh as an identifier (`Command::new(git_path)`, `Command::new(GH)`); a
// program reached through an unrelated name or through a shell is out of reach of a
// text check and is left to review (ADR-0016). Integration tests under
// `crates/<crate>/tests/` may start Git to build fixtures; `src/**/tests` modules may
// not. Adding a file to ALLOWED_BUILDERS needs a line in ADR-0016.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The only files allowed to start Git or `gh`: the hardened builders. */
export const ALLOWED_BUILDERS = [
  "crates/oxide-core/src/git_command.rs",
  "crates/oxide-core/src/github.rs",
];

const SKIPPED_DIRECTORIES = new Set(["target", "node_modules", ".git"]);
const PROGRAM = /["'](?:git|gh)(?:\.exe)?["']/;
// An identifier such as `git`, `GIT`, `git_path` or `GH_BIN`, not inside a string literal.
const PROGRAM_IDENTIFIER = /(?<![\w"'.])(?:git|gh)(?:_\w+)?(?![\w"'(])/i;

// `depth` counts directories below `crates/`: `crates/<crate>/tests` is depth 1 inside a crate.
function* rustFiles(directory, depth = 0) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (depth === 1 && entry.name === "tests") continue;
      yield* rustFiles(join(directory, entry.name), depth + 1);
    } else if (entry.name.endsWith(".rs")) yield join(directory, entry.name);
  }
}

// Whether the arguments of a `Command::new(...)` name git or gh: as a string literal, or as
// an identifier once string literals are taken out.
function startsGitOrGh(args) {
  if (PROGRAM.test(args)) return true;
  const withoutStrings = args.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return PROGRAM_IDENTIFIER.test(withoutStrings);
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
  // A directory that cannot be read must fail the check, not pass it.
  const files = [...rustFiles(crates)];
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    if (ALLOWED_BUILDERS.includes(file)) continue;
    // Blank whole-line comments, keeping line numbers.
    const text = readFileSync(path, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const match of text.matchAll(/Command\s*::\s*new\s*\(/g)) {
      if (startsGitOrGh(callArguments(text, match.index + match[0].length))) {
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
