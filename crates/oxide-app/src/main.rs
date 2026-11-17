// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A Provider's per-launch `notify` runs this same executable as the session reporter
    // (ADR-0016): it reports a session id to the running app and never opens a window.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(oxide_core::agent_reporter::REPORTER_FLAG) {
        let rest: Vec<String> = args.collect();
        let code =
            oxide_core::agent_reporter::run_reporter(&rest, &|name| std::env::var(name).ok());
        std::process::exit(code);
    }
    oxide_app_lib::run()
}
