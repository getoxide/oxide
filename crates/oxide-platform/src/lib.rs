//! The platform layer (ADR-0018): everything that needs an API existing on one operating system
//! only lives here, one implementation per OS behind the same functions.
//!
//! - `macos/`, `linux/` and `windows/` are the implementations. Each is compiled only for its OS
//!   and holds no conditional compilation. The two Unix ones share `posix/`.
//! - [`command`], [`diag`] and [`sync`] are the same on every OS. They sit here because the
//!   implementations need them and this crate depends on no other Oxide crate.
//!
//! `tools/checks/platform-layer.mjs` keeps OS-specific code out of the other crates and checks
//! that the three implementations offer the same public items with the same signatures.
//! Code outside this crate that needs a different value per OS uses the expression form
//! (`if cfg!(windows) { .. } else { .. }`), which every OS compiles.

pub mod command;
pub mod diag;
mod explorer;
pub mod registry;
pub mod sync;

#[cfg(target_os = "macos")]
#[path = "macos/mod.rs"]
mod implementation;
#[cfg(target_os = "linux")]
#[path = "linux/mod.rs"]
mod implementation;
#[cfg(windows)]
#[path = "windows/mod.rs"]
mod implementation;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
compile_error!("Oxide supports macOS, Linux and Windows.");

#[cfg(unix)]
mod posix;

pub use implementation::{fs, process, system, terminal};

use serde::{Deserialize, Serialize};

/// How to start the interactive shell of a Terminal: plain data the caller turns into a PTY
/// command, so this crate needs no PTY library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellLaunch {
    pub program: std::ffi::OsString,
    pub args: Vec<std::ffi::OsString>,
    pub env: Vec<(String, String)>,
}

/// A running shell, as [`terminal::close_session`] needs to see it.
pub trait ShellProcess {
    /// Collects the shell's exit status if it already ended, so a dead shell stops counting as
    /// alive (on Unix a zombie leader keeps its group looking alive).
    fn reap(&mut self);
    /// Ends the shell process itself.
    fn kill(&mut self);
}

/// What identifies one running process beyond its id, which the OS reuses: the image it runs and
/// when it started. Only Windows can read it; elsewhere [`process::process_identity`] is `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub image: String,
    pub creation_time: u64,
}
