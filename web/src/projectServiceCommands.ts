/** A command that should run as a Project Service instead of blocking the shell. */
export interface BackgroundCommand {
  /** The command to spawn: trimmed, with an explicit trailing `&` removed. */
  command: string;
  /** True when the user asked for it with a trailing shell `&`. */
  explicit: boolean;
}

interface Token {
  value: string;
  /** The token contained quotes, so it is data rather than a flag to interpret. */
  quoted: boolean;
}

/** Split a command the way a shell would for our purposes: whitespace outside quotes. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let quoted = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        quote = null;
        quoted = true;
        continue;
      }
      if (character === "\\" && quote === '"' && index + 1 < command.length) {
        value += command[index + 1]!;
        index += 1;
        continue;
      }
      value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      started = true;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      value += command[index + 1]!;
      index += 1;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push({ value, quoted });
        value = "";
        quoted = false;
        started = false;
      }
      continue;
    }
    value += character;
    started = true;
  }
  if (started) tokens.push({ value, quoted });
  return tokens;
}

/** Whether the `&` at `index` is a shell operator rather than quoted or escaped text. */
function unquotedAmpersand(command: string, index: number): boolean {
  let quote: "'" | '"' | null = null;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor]!;
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') cursor += 1;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "\\") cursor += 1;
  }
  return quote === null;
}

/** Strip a trailing `&` that the shell would read as "run this in the background". */
function splitExplicit(command: string): { command: string; explicit: boolean } {
  const trimmed = command.trim();
  const end = trimmed.length - 1;
  if (
    end >= 0 &&
    trimmed[end] === "&" &&
    trimmed[end - 1] !== "&" &&
    unquotedAmpersand(trimmed, end)
  ) {
    return { command: trimmed.slice(0, end).trimEnd(), explicit: true };
  }
  return { command: trimmed, explicit: false };
}

/** Wrappers that run another command; they do not change what is being started. Mirrors Rust. */
const WRAPPERS = new Set(["env", "exec", "nohup", "sudo", "time", "command", "nice"]);

function isEnvAssignment(value: string): boolean {
  const equals = value.indexOf("=");
  if (equals <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, equals));
}

/** The basename, lowercased and without `.exe`, like Rust's `normalize_program`. */
function normalizeProgram(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? value;
  return name
    .replace(/^["'`(;,]+|["'`(;,]+$/g, "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/** Package manager scripts that are servers/watchers. Mirrors Rust's `package_manager_script`. */
function packageManagerScript(rest: string[]): boolean {
  const first = rest[0];
  if (!first) return false;
  if (["start", "serve", "watch", "dev"].includes(first)) return true;
  if (first !== "run") return false;
  const script = rest[1];
  return (
    script !== undefined &&
    (["start", "serve", "watch", "dev"].includes(script) ||
      script.startsWith("dev:") ||
      script.startsWith("watch:") ||
      script.startsWith("serve:"))
  );
}

function pythonServer(rest: string[]): boolean {
  for (let index = 0; index + 1 < rest.length; index += 1) {
    if (
      rest[index] === "-m" &&
      ["http.server", "uvicorn", "gunicorn"].includes(rest[index + 1]!)
    ) {
      return true;
    }
  }
  for (let index = 0; index + 2 < rest.length; index += 1) {
    if (rest[index] === "-m" && rest[index + 1] === "flask" && rest[index + 2] === "run") {
      return true;
    }
  }
  return (rest[0]?.endsWith("manage.py") ?? false) && rest.includes("runserver");
}

const STANDALONE_SERVERS = new Set([
  "webpack-dev-server",
  "serve",
  "http-server",
  "uvicorn",
  "gunicorn",
  "watchexec",
  "watcher",
  "nodemon",
  "browser-sync",
  "air",
]);

/** Known dev servers and watchers. Conservative: a miss is cheaper than a false positive. */
function matchesServer(words: string[]): boolean {
  const [first, second] = words;
  if (!first) return false;
  const rest = words.slice(1);

  if (first === "npx" || first === "pnpx" || first === "bunx") {
    const [program, ...args] = rest.map((word, index) => (index === 0 ? normalizeProgram(word) : word));
    return program !== undefined && matchesServer([program, ...args]);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(first)) return packageManagerScript(rest);
  if (STANDALONE_SERVERS.has(first)) return true;

  switch (first) {
    case "vite":
      return second === undefined || second === "dev" || second === "preview" || second.startsWith("-");
    case "next":
    case "nuxt":
    case "astro":
    case "remix":
    case "ng":
      return second !== undefined && ["dev", "start", "serve", "preview"].includes(second);
    case "webpack":
      return rest.some((word) => ["serve", "--watch", "-w", "--serve"].includes(word));
    case "flask":
      return second === "run";
    case "rails":
      return second === "server" || second === "s";
    case "cargo":
      return second === "run" || second === "watch";
    case "go":
      return second === "run";
    case "deno":
      return second === "run";
    case "php":
      return second === "-S";
    case "parcel":
      return second === undefined || second !== "build";
    case "hugo":
      return second === "server";
    case "jekyll":
    case "mkdocs":
      return second === "serve";
    case "python":
    case "python3":
    case "py":
      return pythonServer(rest);
    case "tail":
      return second === "-f" || second === "-F";
    default:
      return false;
  }
}

/**
 * Classify a shell command as something that should become a Project Service: a known dev
 * server/watcher, or any command explicitly ended with `&`. A port flag on its own is not
 * enough (`ssh -p 22`, `lsof -p 123` and `PORT=4000 cargo test` stay in the shell).
 * Returns `null` when the command should stay in the interactive shell.
 */
export function backgroundCommand(command: string): BackgroundCommand | null {
  const { command: stripped, explicit } = splitExplicit(command);
  if (!stripped) return null;

  const tokens = tokenize(stripped);
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start]!;
    if (!token.quoted && (WRAPPERS.has(token.value) || isEnvAssignment(token.value))) {
      start += 1;
      continue;
    }
    break;
  }
  const words = tokens.slice(start).map((token) => token.value);
  if (words.length > 0) words[0] = normalizeProgram(words[0]!);
  const server = matchesServer(words);
  if (!explicit && !server) return null;
  return { command: stripped, explicit };
}
