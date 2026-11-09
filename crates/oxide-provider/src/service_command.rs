//! Recognition of commands that should run as a Project Service: local dev servers,
//! file watchers, and anything the user or agent explicitly backgrounds with `&`.
//!
//! The classifier is deliberately conservative: a false positive turns an ordinary tool
//! call into a detached process. The Provider adapters use it to decide which tool calls to
//! report for detachment; the terminal path mirrors the same patterns in
//! `web/src/projectServiceCommands.ts`.

/// A command that runs a local server or watcher and would otherwise block the caller.
pub fn is_background_command(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    if is_explicit_background(command) {
        return true;
    }
    if binds_port(command) {
        return true;
    }
    let Some((program, args)) = invocation(command) else {
        return false;
    };
    is_server_invocation(&program, &args)
}

/// Whether the command explicitly ends with a single unquoted `&`.
///
/// `&&` is a shell chain, not backgrounding, so it does not count. The marker must be the
/// last thing on the line, which keeps `echo 'x &'` and redirections such as `2>&1` out.
pub fn is_explicit_background(command: &str) -> bool {
    let trimmed = command.trim_end();
    let Some(head) = trimmed.strip_suffix('&') else {
        return false;
    };
    !head.trim_end().ends_with('&')
}

/// The command to run once `&` has done its job: the marker is shell syntax, and a service
/// spawns the command itself rather than letting a wrapper shell background it and exit.
pub fn without_background_marker(command: &str) -> &str {
    let trimmed = command.trim();
    if is_explicit_background(trimmed) {
        trimmed[..trimmed.len() - 1].trim_end()
    } else {
        trimmed
    }
}

/// The port a command line asks for (`--port N`, `--port=N`, `-p N`, `-p=N`, `PORT=N`, or the
/// positional port of `python -m http.server PORT`). Core's `port_from_command` delegates here,
/// and `web/src/projectServiceCommands.ts` mirrors the same syntax, so the three paths agree.
pub fn port_in_command(command: &str) -> Option<u16> {
    if let Some(port) = python_http_server_port(command) {
        return Some(port);
    }
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ';' | ','
            )
        });
        if let Some(value) = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("-p="))
        {
            if let Some(port) = parse_port(value) {
                return Some(port);
            }
        } else if let Some(value) = token.strip_prefix("PORT=") {
            if let Some(port) = parse_port(value) {
                return Some(port);
            }
        } else if (token == "--port" || token == "-p")
            && let Some(value) = tokens.get(index + 1)
            && let Some(port) = parse_port(value)
        {
            return Some(port);
        }
        index += 1;
    }
    None
}

/// The URL an agent is told a service is reachable at.
pub fn service_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// The confirmation an agent sees in place of the long-running tool result.
///
/// The URL is omitted when the command did not name a port; output-based detection can
/// still fill it in later.
pub fn service_notice(command: &str, pid: u32, port: Option<u16>) -> String {
    match port {
        Some(port) => format!(
            "[Oxide] Started Project Service '{command}' on {} (PID {pid})",
            service_url(port)
        ),
        None => format!("[Oxide] Started Project Service '{command}' (PID {pid})"),
    }
}

/// Wrappers that run another command; they do not change what is being started.
const WRAPPERS: &[&str] = &["env", "exec", "nohup", "sudo", "time", "command", "nice"];

fn invocation(command: &str) -> Option<(String, Vec<String>)> {
    let mut tokens = command.split_whitespace().peekable();
    loop {
        let token = *tokens.peek()?;
        if is_env_assignment(token) || WRAPPERS.contains(&token) {
            tokens.next();
            continue;
        }
        break;
    }
    let program = normalize_program(tokens.next()?);
    let args = tokens.map(normalize_argument).collect();
    Some((program, args))
}

/// Whether the command names a port, which is enough to treat it as a server. Matches the
/// terminal path's patterns (`--port`, `--port=N`, `-p N`, `-p=N`, `PORT=N`).
fn binds_port(command: &str) -> bool {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        if token.starts_with("--port") || token.starts_with("PORT=") {
            return true;
        }
        if token
            .strip_prefix("-p=")
            .is_some_and(|value| value.chars().all(|c| c.is_ascii_digit()))
        {
            return true;
        }
        if token == "-p"
            && tokens
                .get(index + 1)
                .is_some_and(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()))
        {
            return true;
        }
        index += 1;
    }
    false
}

fn is_env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn normalize_program(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    name.trim_matches(|character: char| {
        matches!(character, '"' | '\'' | '`' | '(' | ')' | ';' | ',')
    })
    .to_ascii_lowercase()
    .trim_end_matches(".exe")
    .to_string()
}

fn normalize_argument(argument: &str) -> String {
    argument
        .trim_matches(|character: char| {
            matches!(character, '"' | '\'' | '`' | '(' | ')' | ';' | ',')
        })
        .to_string()
}

fn is_server_invocation(program: &str, args: &[String]) -> bool {
    match program {
        "npm" | "pnpm" | "yarn" | "bun" => package_manager_script(args),
        "npx" | "pnpx" | "bunx" => args
            .first()
            .map(|next| is_server_invocation(&normalize_program(next), &args[1..]))
            .unwrap_or(false),
        "vite" | "webpack-dev-server" | "serve" | "http-server" | "uvicorn" | "gunicorn"
        | "watchexec" | "watcher" | "nodemon" | "browser-sync" | "air" => true,
        "next" | "nuxt" | "astro" | "remix" | "ng" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "dev" | "start" | "serve" | "preview")),
        "webpack" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "serve" | "--watch" | "-w" | "--serve")),
        "flask" => args.first().is_some_and(|arg| arg == "run"),
        "rails" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "server" | "s")),
        "cargo" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "run" | "watch")),
        "go" => args.first().is_some_and(|arg| arg == "run"),
        "deno" => args.first().is_some_and(|arg| arg == "run"),
        "php" => args.first().is_some_and(|arg| arg == "-S"),
        "parcel" => args.first().is_none_or(|arg| arg != "build"),
        "hugo" => args.first().is_some_and(|arg| arg == "server"),
        "jekyll" | "mkdocs" => args.first().is_some_and(|arg| arg == "serve"),
        "docker" => args.len() >= 2 && args[0] == "compose" && args[1] == "up",
        "docker-compose" => args.first().is_some_and(|arg| arg == "up"),
        "python" | "python3" | "py" => python_server(args),
        "tail" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "-f" | "-F")),
        _ => false,
    }
}

fn package_manager_script(args: &[String]) -> bool {
    let Some(first) = args.first() else {
        return false;
    };
    if matches!(first.as_str(), "start" | "serve" | "watch" | "dev") {
        return true;
    }
    if first == "run"
        && let Some(script) = args.get(1)
    {
        return script == "start"
            || script == "serve"
            || script == "watch"
            || script == "dev"
            || script.starts_with("dev:")
            || script.starts_with("watch:")
            || script.starts_with("serve:");
    }
    false
}

fn python_server(args: &[String]) -> bool {
    let runs_module = args.windows(2).any(|window| {
        window[0] == "-m"
            && matches!(
                window[1].as_str(),
                "http.server" | "uvicorn" | "gunicorn" | "flask"
            )
    });
    let runs_script = args.first().is_some_and(|arg| arg.ends_with("manage.py"))
        && args.iter().any(|arg| arg == "runserver");
    runs_module || runs_script
}

fn parse_port(raw: &str) -> Option<u16> {
    let digits = raw.trim_matches(|c: char| !c.is_ascii_digit());
    if digits.is_empty() {
        return None;
    }
    let value: u32 = digits.parse().ok()?;
    (1..=65_535).contains(&value).then_some(value as u16)
}

/// The positional port of `python -m http.server [PORT]`: no flag names it, but it is the
/// conventional first argument once the module is named.
fn python_http_server_port(command: &str) -> Option<u16> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let python = tokens
        .iter()
        .position(|token| matches!(*token, "python" | "python3" | "py"))?;
    let rest = &tokens[python + 1..];
    let module = rest.iter().position(|token| *token == "-m")?;
    if rest.get(module + 1) != Some(&"http.server") {
        return None;
    }
    rest.get(module + 2).and_then(|raw| parse_port(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_dev_servers_and_watchers() {
        for command in [
            "npm run dev",
            "npm run dev -- --port 3000",
            "npm start",
            "pnpm dev",
            "pnpm run serve",
            "yarn watch",
            "bun run dev:client",
            "npx vite",
            "vite",
            "next dev",
            "next start",
            "cargo run",
            "cargo watch -x test",
            "go run .",
            "python3 -m http.server",
            "python -m http.server 8000",
            "python3 manage.py runserver",
            "uvicorn app:app --reload",
            "flask run",
            "rails server",
            "nodemon server.js",
            "watchexec -e rs cargo test",
            "watcher",
            "air",
            "ng serve",
            "php -S localhost:8000",
            "deno run --watch main.ts",
            "docker compose up",
            "docker-compose up",
            "parcel",
            "hugo server",
            "jekyll serve",
            "mkdocs serve",
            "PORT=4000 node server.js",
            "tail -f logs/dev.log",
        ] {
            assert!(is_background_command(command), "{command} should detach");
        }
    }

    #[test]
    fn leaves_ordinary_commands_alone() {
        for command in [
            "echo hi",
            "cargo test",
            "cargo build",
            "npm test",
            "npm run build",
            "pnpm install",
            "git status",
            "python script.py",
            "python3 -c 'print(1)'",
            "next build",
            "flask --help",
            "rails db:migrate",
            "parcel build",
            "docker compose down",
            "go test ./...",
            "tail -n 20 logs/dev.log",
            "ls -la",
        ] {
            assert!(
                !is_background_command(command),
                "{command} should not detach"
            );
        }
    }

    #[test]
    fn explicit_background_needs_a_single_trailing_ampersand() {
        assert!(is_explicit_background("sleep 30 &"));
        assert!(is_explicit_background("make 2>&1 &"));
        assert!(!is_explicit_background("make && make install"));
        assert!(!is_explicit_background("echo 'x &'"));
        assert!(!is_explicit_background("sleep 30"));
    }

    #[test]
    fn explicit_background_commands_are_background_commands() {
        assert!(is_background_command("sleep 30 &"));
        assert!(is_background_command("some-tool --flag &"));
    }

    #[test]
    fn strips_the_background_marker_before_spawning() {
        assert_eq!(without_background_marker("sleep 30 &"), "sleep 30");
        assert_eq!(
            without_background_marker("  npm run dev  &  "),
            "npm run dev"
        );
        assert_eq!(without_background_marker("sleep 30"), "sleep 30");
    }

    #[test]
    fn reads_ports_from_command_lines() {
        assert_eq!(port_in_command("npm run dev --port 3000"), Some(3000));
        assert_eq!(port_in_command("vite --port=5173"), Some(5173));
        assert_eq!(port_in_command("serve -p 8080"), Some(8080));
        assert_eq!(port_in_command("PORT=4000 node server.js"), Some(4000));
        assert_eq!(port_in_command("python3 -m http.server 8000"), Some(8000));
        assert_eq!(
            port_in_command("python -m http.server 8000 --bind 127.0.0.1"),
            Some(8000)
        );
        assert_eq!(port_in_command("python3 -m http.server"), None);
        assert_eq!(port_in_command("sleep -p 1.5"), None);
        assert_eq!(port_in_command("npm run dev"), None);
    }

    #[test]
    fn describes_the_started_service() {
        assert_eq!(
            service_notice("npm run dev --port 3000", 42, Some(3000)),
            "[Oxide] Started Project Service 'npm run dev --port 3000' on http://localhost:3000 (PID 42)"
        );
        assert_eq!(
            service_notice("watchexec -- cargo test", 7, None),
            "[Oxide] Started Project Service 'watchexec -- cargo test' (PID 7)"
        );
    }
}
