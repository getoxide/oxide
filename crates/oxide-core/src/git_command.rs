//! The one place Oxide starts a `git` process.
//!
//! A repository's own configuration can name programs Git runs on our behalf
//! (`core.fsmonitor`, `diff.*.textconv`, `core.sshCommand`, hooks). Every
//! invocation therefore goes through [`GitCommand`], which always adds the
//! hardening below; no call site builds `Command::new("git")` itself.
//!
//! Two modes:
//! - [`Mode::ReadOnly`]: looking at a repository (status, branches, diff, log,
//!   plumbing, Oxide's own bookkeeping). Hooks are switched off, and so are the
//!   `filter.*` drivers the repository's own `.git/config` names.
//! - [`Mode::UserInitiated`]: commit, checkout, pull, push, clone and similar,
//!   which the user asked for. Hooks and helpers run as in a terminal.

use crate::redact::redact_url_credentials;
use crate::{Error, Result};
use oxide_platform::sync::LockExt as _;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// Configuration added to every Git invocation, in either mode.
pub(crate) const HARDENING_CONFIG: [(&str, &str); 3] = [
    ("core.fsmonitor", "false"),
    ("core.untrackedCache", "false"),
    ("protocol.ext.allow", "never"),
];

/// Subcommands that can run a repository-chosen diff driver or textconv.
const DIFFING: [&str; 3] = ["diff", "log", "show"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Hooks are disabled through an empty `core.hooksPath` that Oxide owns.
    ReadOnly,
    /// The user's hooks and helpers run, as they would in a terminal.
    UserInitiated,
}

#[derive(Debug, Clone)]
pub(crate) struct GitCommand {
    mode: Mode,
    cwd: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

impl GitCommand {
    pub(crate) fn read_only(cwd: impl Into<PathBuf>) -> Self {
        Self::new(Mode::ReadOnly, cwd)
    }

    pub(crate) fn user_initiated(cwd: impl Into<PathBuf>) -> Self {
        Self::new(Mode::UserInitiated, cwd)
    }

    fn new(mode: Mode, cwd: impl Into<PathBuf>) -> Self {
        Self {
            mode,
            cwd: cwd.into(),
            args: Vec::new(),
            env: Vec::new(),
        }
    }

    pub(crate) fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }

    pub(crate) fn envs<I, K, V>(mut self, env: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.env.extend(
            env.into_iter()
                .map(|(k, v)| (k.as_ref().to_os_string(), v.as_ref().to_os_string())),
        );
        self
    }

    /// The full argument list: hardening first, then the caller's arguments
    /// with the diff flags placed after the subcommand.
    #[cfg(test)]
    pub(crate) fn full_args(&self, hooks_dir: &Path) -> Vec<OsString> {
        self.full_args_with(hooks_dir, &[])
    }

    /// [`Self::full_args`] plus extra `-c key=value` pairs (the neutralised filter drivers).
    fn full_args_with(&self, hooks_dir: &Path, extra: &[(String, String)]) -> Vec<OsString> {
        let mut full: Vec<OsString> = Vec::new();
        let mut config = |key: &str, value: &OsStr| {
            full.push("-c".into());
            let mut pair = OsString::from(format!("{key}="));
            pair.push(value);
            full.push(pair);
        };
        for (key, value) in HARDENING_CONFIG {
            config(key, OsStr::new(value));
        }
        if self.mode == Mode::ReadOnly {
            config("core.hooksPath", hooks_dir.as_os_str());
            for (key, value) in extra {
                config(key, OsStr::new(value));
            }
        }
        let subcommand = subcommand_index(&self.args);
        for (i, arg) in self.args.iter().enumerate() {
            full.push(arg.clone());
            if Some(i) == subcommand && arg.to_str().is_some_and(|name| DIFFING.contains(&name)) {
                full.push("--no-ext-diff".into());
                full.push("--no-textconv".into());
            }
        }
        full
    }

    /// The process to start. Besides `filter_overrides`, which only lists configuration
    /// and so cannot run a repository's program, this is the only `Command::new` for Git.
    pub(crate) fn build(&self) -> Result<Command> {
        let git = crate::desktop_tools::resolve("git").unwrap_or_else(|| "git".into());
        let (hooks, filters) = match self.mode {
            Mode::ReadOnly => (empty_hooks_dir()?, filter_overrides(&git, &self.cwd)),
            Mode::UserInitiated => (PathBuf::new(), Vec::new()),
        };
        #[allow(
            clippy::disallowed_methods,
            reason = "GitCommand: the one hardened Command::new for Git (ADR-0016)"
        )]
        let mut command = Command::new(git);
        oxide_platform::process::hide_console(&mut command)
            .args(self.full_args_with(&hooks, &filters))
            .current_dir(&self.cwd)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        Ok(command)
    }

    /// Runs Git to completion and returns its standard output.
    pub(crate) fn run(&self) -> Result<String> {
        let output = self
            .build()?
            .output()
            .map_err(|e| Error::Git(redact_url_credentials(&format!("could not run git: {e}"))))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&output.stdout)
        } else {
            stderr
        };
        Err(Error::Git(redact_url_credentials(message.trim())))
    }
}

/// Index of the subcommand: the first argument that is not a global option
/// (or the value of `-c` / `-C`).
fn subcommand_index(args: &[OsString]) -> Option<usize> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].to_string_lossy();
        match arg.as_ref() {
            "-c" | "-C" => i += 2,
            _ if arg.starts_with('-') => i += 1,
            _ => return Some(i),
        }
    }
    None
}

/// The Oxide home, once a `Core` is open: the empty hooks folder lives under it, not in the
/// shared temporary folder where another user or process could replace it.
static HOME: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Records the Oxide home for [`empty_hooks_dir`].
pub(crate) fn set_home(home: &Path) {
    *HOME.lock_recover() = Some(home.to_path_buf());
}

/// An empty folder Oxide owns, used as `core.hooksPath` so that read-only
/// invocations find no hooks. Under the Oxide home (`0700`) when one is open,
/// otherwise a private temporary directory created once per process.
fn empty_hooks_dir() -> Result<PathBuf> {
    let home = HOME.lock_recover().clone();
    if let Some(home) = home {
        let dir = home.join("no-hooks");
        if std::fs::create_dir_all(&dir).is_ok() {
            oxide_platform::diag::best_effort(
                "restrict_dir_to_owner",
                oxide_platform::fs::restrict_dir_to_owner(&dir),
            );
            return Ok(dir);
        }
    }
    static DIR: OnceLock<std::result::Result<PathBuf, String>> = OnceLock::new();
    DIR.get_or_init(|| {
        tempfile::Builder::new()
            .prefix("oxide-no-hooks-")
            .tempdir()
            .map(tempfile::TempDir::keep)
            .map_err(|e| e.to_string())
    })
    .clone()
    .map_err(|e| Error::Git(format!("could not create the empty hooks folder: {e}")))
}

/// `-c` pairs that switch off every `filter.<name>` driver the repository's own `.git/config`
/// defines. A clean, smudge or process driver is a program Git runs on `add`, `status` and
/// `diff`; an empty command means "no filter", and `required=false` keeps Git from failing
/// on the missing one. Only the repository's own file is read: the user's global filters
/// (Git LFS) keep working. Failure to list them yields no overrides.
fn filter_overrides(git: &Path, cwd: &Path) -> Vec<(String, String)> {
    #[allow(
        clippy::disallowed_methods,
        reason = "GitCommand: the one hardened Command::new for Git (ADR-0016)"
    )]
    let mut command = Command::new(git);
    let output = oxide_platform::process::hide_console(&mut command)
        .args([
            "config",
            "--local",
            "--includes",
            "-z",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process|required)$",
        ])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(output) if output.status.success() => {
            filter_overrides_from(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// The overrides for the NUL-separated key names `git config -z --name-only` printed.
fn filter_overrides_from(names: &str) -> Vec<(String, String)> {
    let mut drivers: Vec<&str> = names
        .split('\0')
        .filter_map(|key| {
            let rest = key.strip_prefix("filter.")?;
            let (driver, _variable) = rest.rsplit_once('.')?;
            Some(driver)
        })
        .collect();
    drivers.sort_unstable();
    drivers.dedup();
    drivers
        .into_iter()
        .flat_map(|driver| {
            [
                (format!("filter.{driver}.clean"), String::new()),
                (format!("filter.{driver}.smudge"), String::new()),
                (format!("filter.{driver}.process"), String::new()),
                (format!("filter.{driver}.required"), "false".to_string()),
            ]
        })
        .collect()
}

/// The hardening as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
/// variables, for programs that run Git themselves (`gh`). Entries the user already set in
/// their own environment keep their slots; ours come after, so they win and are not lost.
pub(crate) fn hardening_env() -> Vec<(String, String)> {
    let existing = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|count| count.trim().parse::<usize>().ok())
        .unwrap_or(0);
    hardening_env_after(existing)
}

fn hardening_env_after(existing: usize) -> Vec<(String, String)> {
    let mut env = vec![(
        "GIT_CONFIG_COUNT".to_string(),
        (existing + HARDENING_CONFIG.len()).to_string(),
    )];
    for (n, (key, value)) in HARDENING_CONFIG.iter().enumerate() {
        let slot = existing + n;
        env.push((format!("GIT_CONFIG_KEY_{slot}"), (*key).to_string()));
        env.push((format!("GIT_CONFIG_VALUE_{slot}"), (*value).to_string()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    const BASE: [&str; 6] = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.ext.allow=never",
    ];

    #[test]
    fn both_modes_carry_the_base_hardening() {
        for command in [
            GitCommand::read_only("/x").args(["status"]),
            GitCommand::user_initiated("/x").args(["commit"]),
        ] {
            let args = strings(command.full_args(Path::new("/hooks")));
            assert_eq!(args[..6], BASE);
        }
    }

    #[test]
    fn read_only_disables_hooks_and_user_initiated_keeps_them() {
        let read = strings(
            GitCommand::read_only("/x")
                .args(["status"])
                .full_args(Path::new("/hooks")),
        );
        assert_eq!(read[6..], ["-c", "core.hooksPath=/hooks", "status"]);

        let user = strings(
            GitCommand::user_initiated("/x")
                .args(["commit"])
                .full_args(Path::new("/hooks")),
        );
        assert_eq!(user[6..], ["commit"]);
    }

    #[test]
    fn diff_log_and_show_never_run_external_drivers() {
        for sub in ["diff", "log", "show"] {
            let args = strings(
                GitCommand::read_only("/x")
                    .args(["--no-optional-locks", sub, "--numstat", "--"])
                    .full_args(Path::new("/h")),
            );
            let at = args.iter().position(|a| a == sub).unwrap();
            assert_eq!(args[at + 1..at + 3], ["--no-ext-diff", "--no-textconv"]);
        }
        let status = strings(
            GitCommand::read_only("/x")
                .args(["status"])
                .full_args(Path::new("/h")),
        );
        assert!(!status.contains(&"--no-textconv".to_string()));
    }

    #[test]
    fn a_value_that_looks_like_a_subcommand_is_not_mistaken_for_one() {
        let args = strings(
            GitCommand::read_only("/x")
                .args(["-C", "diff", "status"])
                .full_args(Path::new("/h")),
        );
        assert!(!args.contains(&"--no-textconv".to_string()));
    }

    #[test]
    fn gh_gets_the_same_base_hardening_through_its_environment() {
        let env = hardening_env();
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "3".into()));
        let pairs: Vec<_> = (0..3)
            .map(|n| {
                let get = |name: String| env.iter().find(|(k, _)| *k == name).unwrap().1.clone();
                (
                    get(format!("GIT_CONFIG_KEY_{n}")),
                    get(format!("GIT_CONFIG_VALUE_{n}")),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            [
                ("core.fsmonitor".to_string(), "false".to_string()),
                ("core.untrackedCache".to_string(), "false".to_string()),
                ("protocol.ext.allow".to_string(), "never".to_string()),
            ]
        );
    }

    #[test]
    fn gh_hardening_goes_after_the_users_own_git_config_entries() {
        let env = hardening_env_after(2);
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "5".into()));
        assert_eq!(env[1], ("GIT_CONFIG_KEY_2".into(), "core.fsmonitor".into()));
        assert_eq!(env[2], ("GIT_CONFIG_VALUE_2".into(), "false".into()));
        assert_eq!(
            env.last().unwrap(),
            &("GIT_CONFIG_VALUE_4".to_string(), "never".to_string())
        );
    }

    #[test]
    fn every_filter_driver_the_repository_names_is_emptied() {
        let names = "filter.evil.clean\0filter.evil.required\0filter.a.b.process\0core.x\0";
        let overrides = filter_overrides_from(names);
        let keys: Vec<&str> = overrides.iter().map(|(k, _)| k.as_str()).collect();
        for driver in ["evil", "a.b"] {
            for variable in ["clean", "smudge", "process"] {
                let key = format!("filter.{driver}.{variable}");
                assert!(keys.contains(&key.as_str()), "{key} in {keys:?}");
                assert!(overrides.contains(&(key, String::new())));
            }
        }
        assert!(overrides.contains(&("filter.evil.required".into(), "false".into())));
        assert_eq!(overrides.len(), 8);
    }

    #[cfg(unix)]
    #[test]
    fn a_filter_driver_in_the_repository_config_does_not_run_on_add_status_or_diff() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("r");
        std::fs::create_dir_all(&repo).unwrap();
        let marker = dir.path().join("MARKER");
        let script = dir.path().join("evil.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho ran >> '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let git = |args: &[&str]| {
            GitCommand::user_initiated(&repo)
                .args(args.iter().copied())
                .envs([
                    ("GIT_AUTHOR_NAME", "T"),
                    ("GIT_AUTHOR_EMAIL", "t@example.com"),
                    ("GIT_COMMITTER_NAME", "T"),
                    ("GIT_COMMITTER_EMAIL", "t@example.com"),
                ])
                .run()
                .unwrap()
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        let script = script.to_string_lossy().into_owned();
        for variable in ["clean", "smudge"] {
            git(&["config", &format!("filter.evil.{variable}"), &script]);
        }
        git(&["config", "filter.evil.required", "true"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("b.txt"), "new\n").unwrap();

        let read = |args: &[&str]| {
            GitCommand::read_only(&repo)
                .args(args.iter().copied())
                .envs([("GIT_INDEX_FILE", dir.path().join("tmp.index"))])
                .run()
                .unwrap()
        };
        read(&["add", "--all", "--", "."]);
        read(&["write-tree"]);
        GitCommand::read_only(&repo)
            .args(["status", "--porcelain"])
            .run()
            .unwrap();
        GitCommand::read_only(&repo).args(["diff"]).run().unwrap();
        assert!(!marker.exists(), "a filter driver ran");
    }

    #[test]
    fn git_errors_do_not_show_credentials_embedded_in_a_url() {
        let dir = tempfile::tempdir().unwrap();
        let alias = "alias.boom=!echo \"fatal: unable to access 'https://user:synthetic-secret@host/r.git/'\" >&2; exit 1";
        let message = GitCommand::read_only(dir.path())
            .args(["-c", alias, "boom"])
            .run()
            .unwrap_err()
            .to_string();
        assert!(message.contains("https://host/r.git"), "{message}");
        assert!(!message.contains("synthetic-secret"), "{message}");
    }
}
