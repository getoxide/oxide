//! The platform layer (ADR-0019, ADR-0022): everything that depends on the operating system lives
//! here, in three levels.
//!
//! 1. **The contract.** [`fs`], [`process`], [`system`], [`terminal`] and [`env`] declare what the
//!    platform offers. Each public function is documented once there, says what it does on every
//!    OS, and delegates to the implementation for the OS it was compiled for.
//! 2. **Code that is the same on every OS.** [`command`], [`diag`], [`sync`], [`registry`],
//!    [`child`] and [`bounded_lines`], plus any logic a contract function runs before it delegates
//!    (such as the validation of a Command block token). They sit here because the implementations
//!    need them and this crate depends on no other Oxide crate.
//! 3. **The implementations.** `imp/macos/`, `imp/linux/` and `imp/windows/` offer the same
//!    functions with the same signatures. Each is compiled only for its OS and holds no
//!    conditional compilation; the two Unix ones share `imp/posix/`. They are private: callers
//!    only see the contract, and `dead_code = "deny"` fails the build when an implementation
//!    offers a function the contract does not call.
//!
//! `tools/checks/platform-layer.mjs` keeps OS-specific code out of the other crates and checks that
//! the three implementations offer the same public items with the same signatures, which a Mac
//! compiler cannot see for Windows. Code outside this crate that needs a different *value* per OS
//! uses the expression form (`if cfg!(windows) { .. } else { .. }`), which every OS compiles; a
//! different *behaviour* per OS is a function of the contract.

pub mod bounded_lines;
pub mod child;
pub mod command;
pub mod diag;
pub mod env;
mod explorer;
mod fonts;
pub mod fs;
pub mod process;
pub mod registry;
pub mod sync;
pub mod system;
pub mod terminal;

// The only place that picks an implementation (level 3) for the OS being compiled.
#[cfg(target_os = "macos")]
#[allow(
    clippy::unnecessary_wraps,
    reason = "an implementation keeps the contract's signature, which another OS needs in full"
)]
#[path = "imp/macos/mod.rs"]
mod imp;
#[cfg(target_os = "linux")]
#[allow(
    clippy::unnecessary_wraps,
    reason = "an implementation keeps the contract's signature, which another OS needs in full"
)]
#[path = "imp/linux/mod.rs"]
mod imp;
#[cfg(windows)]
#[allow(
    clippy::unnecessary_wraps,
    reason = "an implementation keeps the contract's signature, which another OS needs in full"
)]
#[path = "imp/windows/mod.rs"]
mod imp;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
compile_error!("Oxide supports macOS, Linux and Windows.");

#[cfg(unix)]
#[allow(
    clippy::unnecessary_wraps,
    reason = "an implementation keeps the contract's signature, which another OS needs in full"
)]
#[path = "imp/posix/mod.rs"]
mod posix;

pub use process::ProcessIdentity;
pub use terminal::{AvailableShell, ShellKind, ShellLaunch, ShellProcess};
