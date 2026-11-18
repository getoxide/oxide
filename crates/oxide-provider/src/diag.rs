//! What to do with a result Oxide cannot act on.
//!
//! `unwrap`, `expect` and `panic!` are denied, which leaves one tempting way out: `let _ = ...`
//! or `.ok();`. That throws the failure away without a trace. Use these instead:
//!
//! - [`best_effort`]: the step may fail without stopping the caller (reaping a child, an event to
//!   a window that closed, a cleanup). The failure is written to stderr with its call site.
//! - [`SenderExt::tell`]: a message to an actor or reader that may already be gone. A closed
//!   channel is the normal end of a Thread or a window, so nothing is logged.
//!
//! If the failure matters, return it with `?` instead. `clippy::let_underscore_must_use` and
//! `clippy::unused_result_ok` are denied in the workspace, so a bare `let _ =` does not compile.
#![allow(
    clippy::let_underscore_must_use,
    reason = "the single place that discards a Result on purpose (ADR-0016)"
)]

use std::fmt::Display;

/// Runs nothing; reports `result`'s error, if any, as `warning: <what> failed at <file:line>: <error>`.
#[track_caller]
pub fn best_effort<T, E: Display>(what: &str, result: Result<T, E>) {
    if let Err(error) = result {
        let site = std::panic::Location::caller();
        eprintln!("warning: {what} failed at {site}: {error}");
    }
}

/// Like [`best_effort`] for `JoinHandle::join`: reports that the thread panicked.
#[track_caller]
pub fn joined<T>(what: &str, result: std::thread::Result<T>) {
    if let Err(payload) = result {
        let site = std::panic::Location::caller();
        let message = payload
            .downcast_ref::<&str>()
            .map(|m| (*m).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_owned());
        eprintln!("warning: thread {what} panicked ({message}), noticed at {site}");
    }
}

/// Sending that ignores a receiver which already hung up.
pub trait SenderExt<T> {
    /// Delivers `message` unless the receiving side is gone, which is expected during shutdown.
    fn tell(&self, message: T);
}

impl<T> SenderExt<T> for crossbeam_channel::Sender<T> {
    fn tell(&self, message: T) {
        let _ = self.send(message);
    }
}

impl<T> SenderExt<T> for std::sync::mpsc::Sender<T> {
    fn tell(&self, message: T) {
        let _ = self.send(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tell_to_a_dropped_receiver_does_not_panic() {
        let (sender, receiver) = crossbeam_channel::unbounded::<u8>();
        drop(receiver);
        sender.tell(1);
    }

    #[test]
    fn best_effort_accepts_ok_and_err() {
        best_effort("ok", Ok::<(), String>(()));
        best_effort("err", Err::<(), _>("boom"));
    }
}
