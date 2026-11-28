# Platform layer: one contract, private implementations

The platform layer of ADR-0019 is split into three levels: a contract that declares and documents every OS-dependent function once, code that is the same on every OS, and one private implementation per OS. The criterion for what goes in the layer is OS-specific *behaviour*, not only an OS-only API. This amends ADR-0019; its checks, baseline and Windows cross-check stay.

## Background and problem

ADR-0019 moved OS-only APIs into `oxide-platform`, with `src/macos/`, `src/linux/` and `src/windows/` offering the same functions, re-exported as `oxide_platform::{fs, process, system, terminal}`. Two gaps remained.

- **No single contract.** What a function promises was written in each implementation, often three times (`open_url`'s comment was identical in all three files), and a reader of `terminate_group` had to open `windows/process.rs` and `posix/process.rs` to learn what callers may rely on. Logic every OS needs before it acts, such as the Command block token check of ADR-0016, was called from each implementation.
- **Behaviour escaped the layer.** The check looks for OS attributes and OS-only APIs, so code that encodes knowledge about one OS but uses portable APIs passed it: `oxide-app/src/shell_path.rs` (launchd gives a Dock-launched macOS app a bare `PATH`, Homebrew's directories, the `:` separator, an `unsafe` `set_var`) lived in the app behind `if cfg!(target_os = "macos")`. The LLVM directories of `winget` and Homebrew, `chmod 0700` and `chmod 0755` were written in Core under `#[cfg]`.

## Decision

- **Level 1, the contract.** `src/fs.rs`, `src/process.rs`, `src/system.rs`, `src/terminal.rs` and `src/env.rs` declare what the platform offers. Each public function is documented once, says what it does on every OS, and delegates to `crate::imp::<module>`. The types that belong to a contract live with it (`ShellKind`, `ShellLaunch`, `ShellProcess` in `terminal`; `ProcessIdentity` in `process`) and stay re-exported from the crate root.
- **Level 2, the same on every OS.** `command`, `diag`, `sync`, `registry`, `child`, `bounded_lines`, and logic a contract function runs before it delegates: `terminal::block_script` checks the token once and the implementations receive a checked one.
- **Level 3, the implementations.** `src/imp/macos/`, `src/imp/linux/` and `src/imp/windows/`, with `src/imp/posix/` shared by the two Unix ones. `src/lib.rs` still picks one per OS, once, as the private module `imp`; no `cfg` appears inside. Being private, an implementation function that the contract does not call fails the build (`dead_code = "deny"`), and a contract function the implementation lacks does not compile, so the compiler checks the current OS and `platform-layer.mjs` checks the other two by text. The implementation modules allow `clippy::unnecessary_wraps`: a no-op on one OS keeps the signature another OS needs.
- **Behaviour, not only APIs.** A difference that is a *value* (a shell name, a flag, a package manager) is still written with the expression form anywhere. A difference in *behaviour* (steps that exist on one OS only, or knowledge of where an OS keeps things) is a contract function, even when it needs no OS-only API. A domain module may still choose between two portable code paths with `if cfg!(windows)`, which every OS type-checks, as `github.rs` does for the `cmd.exe` shim of `gh`.
- **The check knows the contract.** `tools/checks/platform-layer.mjs` reads the implementations under `src/imp/` and fails when an implementation module has no contract module of the same name at the crate root.

## Consequences

- Adding a capability: declare and document the function in its contract module, implement it in `imp/macos/`, `imp/linux/` and `imp/windows/` (or `imp/posix/`), call the contract. Implementation comments say how, not what.
- Code review reads a change to the contract in one file; a diff under `src/imp/windows/` is visibly Windows-only, and the paths suit CODEOWNERS.
- Moved in this change: `shell_path.rs` became `env::inherit_login_shell_path` (macOS merges the login shell's `PATH`; Linux and Windows do nothing), so its `unsafe` now lives in the platform layer as ADR-0016 requires. Core calls `fs::restrict_dir_to_owner`, `fs::make_executable` and `system::llvm_dirs` instead of its own `#[cfg]` blocks, and `github.rs` uses the expression form. The baseline fell from 49 to 35 uses.
- Tests that create symlinks, file modes or executable scripts take them from `crates/oxide-core/tests/support/` (#622); an OS-only test returns early elsewhere and prints that it was skipped. What remains in the baseline is the macOS-only `RunEvent::Reopen` variant of Tauri (the platform layer does not depend on Tauri) and the `windows_subsystem` attribute of `main.rs`, which must sit there.
- The Windows stamp of `node tools/check.mjs windows` now covers `crates/oxide-platform/src/imp/windows/`.
