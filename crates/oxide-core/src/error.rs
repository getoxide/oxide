use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("database is at version {found}, newer than this build supports ({supported})")]
    DatabaseTooNew { found: u32, supported: u32 },
    #[error("path is outside the checkout: {0}")]
    InvalidPath(String),
    #[error("terminal error: {0}")]
    Terminal(String),
    #[error("project service error: {0}")]
    ProjectService(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Github(String),
    #[error("{0}")]
    Editor(String),
    /// A link from repository content to a host outside the allowlist: the UI shows the host
    /// and asks before opening it. The prefix is matched by the webview.
    #[error("Unlisted link host: {host}")]
    UnlistedLinkHost { host: String },
}

pub type Result<T> = std::result::Result<T, Error>;
