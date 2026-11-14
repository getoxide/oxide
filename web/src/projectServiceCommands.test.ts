import { describe, expect, it } from "vitest";
import { backgroundCommand } from "./projectServiceCommands";

const detached = (command: string) => ({ command, explicit: false });

describe("backgroundCommand", () => {
  it.each([
    "npm run dev",
    "npm run start",
    "npm start",
    "pnpm dev",
    "pnpm start",
    "yarn dev",
    "yarn start",
    "bun dev",
    "vite",
    "next dev",
    "nuxt dev",
    "ng serve",
    "remix dev",
    "cargo run",
    "cargo watch",
    "python -m http.server",
    "python3 -m http.server 8080",
    "python -m flask run",
    "uvicorn app:app",
    "gunicorn app:app",
    "flask run",
    "rails server",
    "php -S localhost:8000",
    "go run .",
    "air",
    "watchexec -e rs",
    "nodemon server.js",
    "deno run --allow-net main.ts",
    "http-server",
    "serve",
    "webpack serve",
    "webpack-dev-server",
    "browser-sync start --proxy localhost:3000",
    "parcel index.html",
    "astro dev",
    "hugo server",
    "jekyll serve",
    "mkdocs serve",
    "watcher",
  ])("recognises %s as a long-running command", (command) => {
    expect(backgroundCommand(command)).toEqual(detached(command));
  });

  it.each([
    "env npm run dev",
    "env FOO=bar npm run dev",
    "nohup npm run dev",
    "sudo npm run dev",
    "nice npm run dev",
    "exec npm run dev",
    "time npm run dev",
    "pnpx vite",
    "bunx vite",
    "./node_modules/.bin/vite",
  ])("strips the wrapper in %s before classifying", (command) => {
    expect(backgroundCommand(command)).toEqual(detached(command));
  });

  it.each([
    "npm run dev -- --port 3000",
    "vite --port 4000",
    "PORT=4000 npm start",
  ])("recognises %s as a long-running command with an explicit port", (command) => {
    expect(backgroundCommand(command)).toEqual(detached(command));
  });

  it.each([
    "ls",
    "git status",
    "echo 'npm run dev'",
    "clear",
    "cls",
    "Clear-Host",
    "npm test",
    "vite build",
    "cat package.json",
    "python -m flask --help",
    "ssh -p 22 host",
    "lsof -p 123",
    "PORT=4000 cargo test",
    "node server.js --port 3000",
    "docker compose up",
    "docker-compose up",
    "docker compose down",
  ])("leaves %s in the shell", (command) => {
    expect(backgroundCommand(command)).toBeNull();
  });

  it.each([
    ["sleep 300 &", "sleep 300"],
    ["  npm run dev &  ", "npm run dev"],
    ["sleep 300&", "sleep 300"],
    ["echo 'a & b' &", "echo 'a & b'"],
  ])("strips a trailing ampersand from %s", (input, command) => {
    expect(backgroundCommand(input)).toEqual({ command, explicit: true });
  });

  it("does not treat a quoted or doubled ampersand as explicit backgrounding", () => {
    expect(backgroundCommand("echo 'a & b'")).toBeNull();
    expect(backgroundCommand("sleep 1 && echo done")).toBeNull();
  });

  it("ignores an empty command", () => {
    expect(backgroundCommand("   ")).toBeNull();
  });
});
