//! Code shared by the macOS and Linux implementations. Each of them re-exports these modules
//! with `pub use crate::posix::<module>::*;`, so the parity check reads them as its own.

pub(crate) mod fs;
pub(crate) mod process;
pub(crate) mod signal;
pub(crate) mod terminal;
