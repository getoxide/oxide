// Local runner: what the PR lanes run on this OS, with the same commands as CI.
//
//   node tools/check.mjs          everything the PR lanes run here (the full tier)
//   node tools/check.mjs fast     rustfmt, the text checks, ESLint and TypeScript, in seconds
//   node tools/check.mjs windows  macOS and Linux: cross-compile for Windows and run Clippy
//
// It says what it can't run here and why, and prints every failed command.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBuildSpace, compilesRust } from "./checks/build-space.mjs";
import { withBuildSession } from "./checks/build-session.mjs";
import { currentWindowsNotice, windowsCheckEnvironment, writeWindowsStamp } from "./checks/windows-check.mjs";
import { commandLine, localPlan } from "./ci/policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
let plan;
try {
  plan = localPlan(process.platform, process.argv[2] ?? "pr");
} catch (error) {
  console.error(`${error.message}\nUsage: node tools/check.mjs [fast|pr|windows]`);
  process.exit(2);
}

const exec = (command, env = process.env) =>
  // cmd.exe, needed for .cmd shims on Windows, reads "/" in a program path as a switch.
  spawnSync(windows ? command[0].replaceAll("/", "\\") : command[0], command.slice(1), {
    cwd: repoRoot, stdio: "inherit", env, shell: windows,
  });

if (plan.run.some(({ command }) => command[1] === "nextest") &&
    spawnSync("cargo", ["nextest", "--version"], { stdio: "ignore", shell: windows }).status !== 0) {
  console.error("cargo-nextest is required, as in CI. Install it with: cargo install --locked cargo-nextest");
  process.exit(1);
}

for (const { id, reason } of plan.skipped) console.log(`skip  ${id}: ${reason}`);

// The Windows cross-check needs cargo-xwin and LLVM; say what is missing before building anything.
const windowsTier = process.argv[2] === "windows" && plan.run.length > 0;
let windowsEnv = {};
if (windowsTier) {
  const hasXwin = spawnSync("cargo", ["xwin", "--version"], { stdio: "ignore" }).status === 0;
  const { env, problems } = windowsCheckEnvironment(process.env, { hasXwin });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  windowsEnv = { PATH: env.PATH, RUSTFLAGS: env.RUSTFLAGS };
}

const failures = [];
let completed = 0;
const runChecks = (session) => {
  for (const { id, command } of plan.run) {
    if (compilesRust(command)) assertBuildSpace(repoRoot);
    console.log(`\n> ${id}: ${commandLine(command)}`);
    // All checks reuse the persistent Cargo target, including Tauri and bindings.
    const result = exec(command, windowsTier ? { ...(session?.env ?? process.env), ...windowsEnv } : session?.env);
    if (result.error) console.error(`Cannot start ${command[0]}: ${result.error.message}`);
    completed++;
    if (result.status !== 0) failures.push({ id, command });
    else session?.reportOutputs(command);
    if (compilesRust(command)) assertBuildSpace(repoRoot);
  }
};

let lifecycleFailed = false;
try {
  if (plan.run.some(({ command }) => compilesRust(command))) {
    assertBuildSpace(repoRoot);
    withBuildSession(repoRoot, process.env, runChecks);
  } else runChecks();
} catch (error) {
  lifecycleFailed = true;
  console.error(error.message);
}

console.log(`\n${completed - failures.length} passed, ${failures.length} failed, ${plan.skipped.length} skipped, ${plan.run.length - completed} not run`);
for (const { id, command } of failures) console.log(`FAILED ${id}: ${commandLine(command)}`);
process.exitCode = lifecycleFailed || failures.length > 0 ? 1 : 0;

// The Windows check passed: remember the state of the Windows implementation it passed on.
if (windowsTier && process.exitCode === 0 && completed > 0) writeWindowsStamp(repoRoot);
// The full check cannot run the Windows lane here, so it says when that lane is still owed.
if (!windows && process.argv[2] !== "fast" && process.argv[2] !== "windows") {
  const notice = currentWindowsNotice(repoRoot);
  if (notice) console.log(`\n${notice}`);
}
