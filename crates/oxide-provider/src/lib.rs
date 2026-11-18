//! Process, locking and diagnostics primitives shared by Core and the App shell.
//!
//! The crate keeps its historical name; it no longer talks to any agent CLI (ADR-0018).

pub mod bounded_lines;
pub mod command;
pub mod diag;
pub mod process;
pub mod sync;
