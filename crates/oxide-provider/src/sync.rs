//! The one place that decides what a poisoned lock means (ADR-0016, "Errors").
//!
//! A lock is poisoned when a thread panicked while holding it. Oxide's shared state stays
//! usable after that, so every acquisition recovers the guard instead of panicking
//! (`unwrap`, `expect` are denied) or skipping the work (`if let Ok(guard) = m.lock()`).
//! Call these methods; `Mutex::lock`, `RwLock::read` and `RwLock::write` are disallowed
//! by `clippy.toml`.
#![allow(
    clippy::disallowed_methods,
    reason = "the single poisoning-recovery implementation (ADR-0016)"
)]

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// `lock` that recovers from poisoning.
pub trait LockExt<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `read` / `write` that recover from poisoning.
pub trait RwLockExt<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T>;
    fn write_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_recover(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn lock_recover_returns_the_guard_of_a_poisoned_mutex() {
        let shared = Arc::new(Mutex::new(1));
        let poisoner = Arc::clone(&shared);
        let outcome = std::thread::spawn(move || {
            let _guard = poisoner.lock_recover();
            std::panic::resume_unwind(Box::new("poison"));
        })
        .join();
        assert!(outcome.is_err());
        assert!(shared.is_poisoned());
        *shared.lock_recover() += 1;
        assert_eq!(*shared.lock_recover(), 2);
    }
}
