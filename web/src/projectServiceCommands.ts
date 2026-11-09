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

/** `--port`, `--port=N`, `-p N`, `-p=N` and `PORT=N`, ignoring quoted text. */
function bindsPort(tokens: Token[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.quoted) continue;
    if (token.value === "--port" || token.value.startsWith("--port=")) return true;
    if (token.value.startsWith("PORT=")) return true;
    if (token.value === "-p") {
      const value = tokens[index + 1]?.value ?? "";
      if (/^\d+$/.test(value)) return true;
    }
    if (token.value.startsWith("-p=") && /^\d+$/.test(token.value.slice(3))) return true;
  }
  return false;
}

const exact = (words: string[], prefix: string[]): boolean =>
  prefix.every((word, index) => words[index] === word);

/** Known dev servers, watchers and port-binding runners. Conservative: a miss is cheaper than a false positive. */
function matchesServer(words: string[]): boolean {
  const [first, second] = words;
  if (!first) return false;
  const rest = words.slice(1);

  if (first === "npx") return matchesServer(rest);

  switch (first) {
    case "npm":
      return exact(rest, ["run", "dev"]) || exact(rest, ["run", "start"]) || second === "start";
    case "pnpm":
    case "yarn":
      return (
        second === "dev" ||
        second === "start" ||
        exact(rest, ["run", "dev"]) ||
        exact(rest, ["run", "start"])
      );
    case "bun":
      return second === "dev" || exact(rest, ["run", "dev"]);
    case "vite":
      return second === undefined || second === "dev" || second === "preview" || second!.startsWith("-");
    case "next":
    case "nuxt":
      return second === "dev" || second === "start";
    case "ng":
      return second === "serve";
    case "astro":
      return second === "dev" || second === "preview";
    case "cargo":
      return second === "run" || second === "watch";
    case "python":
    case "python3":
      return (
        (second === "-m" && words[2] === "http.server") ||
        (second === "-m" && words[2] === "flask" && words[3] === "run")
      );
    case "uvicorn":
      return true;
    case "flask":
      return second === "run";
    case "rails":
      return second === "server" || second === "s";
    case "php":
      return second === "-S";
    case "go":
      return second === "run";
    case "air":
    case "watchexec":
    case "nodemon":
    case "watcher":
    case "http-server":
    case "serve":
      return true;
    case "deno":
      return second === "run";
    case "docker":
      return exact(rest, ["compose", "up"]);
    case "docker-compose":
      return second === "up";
    case "webpack":
      return second === "serve";
    case "parcel":
      return second !== "build";
    case "hugo":
      return second === "server";
    case "jekyll":
    case "mkdocs":
      return second === "serve";
    default:
      return false;
  }
}

/**
 * Classify a shell command as something that should become a Project Service: a known dev
 * server/watcher, a command that binds a port, or any command explicitly ended with `&`.
 * Returns `null` when the command should stay in the interactive shell.
 */
export function backgroundCommand(command: string): BackgroundCommand | null {
  const { command: stripped, explicit } = splitExplicit(command);
  if (!stripped) return null;

  const tokens = tokenize(stripped);
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!.value)) {
    start += 1;
  }
  const server = bindsPort(tokens) || matchesServer(tokens.slice(start).map((token) => token.value));
  if (!explicit && !server) return null;
  return { command: stripped, explicit };
}
