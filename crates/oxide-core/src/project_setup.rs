//! Getting a folder on disk ready to be registered as a Project: creating it with
//! `git init`, or cloning into it from a Git URL or GitHub.

use crate::redact::redact_url_credentials;
use crate::{Error, Result, git};
use std::fs;
use std::path::{Path, PathBuf};

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// A folder name that stays inside its parent.
fn checked_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(Error::Git(format!("`{name}` is not a valid folder name.")));
    }
    Ok(name)
}

/// The folder `parent/name`, which must not exist yet. Creates `parent` if needed.
fn fresh_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    fs::create_dir_all(parent).map_err(io(parent))?;
    let dest = parent.join(checked_name(name)?);
    if dest.exists() {
        return Err(Error::Git(format!("{} already exists.", dest.display())));
    }
    Ok(dest)
}

/// A new folder `parent/name` holding a freshly initialised repository.
pub fn create(parent: &Path, name: &str) -> Result<PathBuf> {
    let dest = fresh_folder(parent, name)?;
    fs::create_dir(&dest).map_err(io(&dest))?;
    if let Err(e) = git::run(&dest, &["init", "-q"]) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(dest)
}

/// `https://host/owner/repo.git`, `git@host:owner/repo`, `/path/repo/` or `C:\path\repo` → `repo`.
pub fn repository_name(url: &str) -> Option<&str> {
    let last = url
        .trim()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', ':', '\\'])
        .next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty()).then_some(name)
}

/// Whether `url` is `user@host:path`, the scp-like form of an SSH remote.
fn is_scp_like(url: &str) -> bool {
    let Some((user, rest)) = url.split_once('@') else {
        return false;
    };
    let Some((host, path)) = rest.split_once(':') else {
        return false;
    };
    let word = |s: &str, extra: &[char]| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
    };
    word(user, &['-', '_', '.'])
        && word(host, &['-', '.'])
        && !path.is_empty()
        && !path.starts_with(':')
}

/// The trimmed `url` if it is a normal Git URL: `https://`, `ssh://`, `git://`,
/// scp-like `user@host:path`, or a path that exists. Anything else, such as the
/// `ext::` and `fd::` transports, an option or text with control characters, is
/// refused before Git runs.
pub fn checked_clone_url(url: &str) -> Result<&str> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::Git("Enter a Git URL to clone.".into()));
    }
    let refused = || {
        Err(Error::Git(
            "Not a Git URL Oxide can clone. Use an https://, ssh:// or git:// URL, user@host:path, or a local path."
                .into(),
        ))
    };
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return refused();
    }
    let remote = ["https://", "ssh://", "git://"].iter().any(|scheme| {
        url.len() > scheme.len()
            && url
                .get(..scheme.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
            && !url.contains(char::is_whitespace)
    });
    if remote || is_scp_like(url) || Path::new(url).exists() {
        Ok(url)
    } else {
        refused()
    }
}

/// Clones `url` into `parent/<repository name>`.
pub fn clone_url(parent: &Path, url: &str) -> Result<PathBuf> {
    let url = checked_clone_url(url)?;
    let name = repository_name(url).ok_or_else(|| {
        Error::Git(format!(
            "Cannot tell the repository name from `{}`.",
            redact_url_credentials(url)
        ))
    })?;
    let dest = fresh_folder(parent, name)?;
    git::run_user(parent, &["clone", "-q", "--", url, &dest.to_string_lossy()])?;
    Ok(dest)
}

/// The folder a GitHub repository `owner/name` is cloned into: `parent/name`.
pub fn github_clone_target(parent: &Path, name_with_owner: &str) -> Result<PathBuf> {
    let valid = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    match name_with_owner.split_once('/') {
        Some((owner, name)) if valid(owner) && valid(name) => fresh_folder(parent, name),
        _ => Err(Error::Github(format!(
            "`{name_with_owner}` is not an owner/name repository."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_repository_from_every_kind_of_location() {
        for (url, name) in [
            ("https://host/owner/repo.git", "repo"),
            ("git@host:owner/repo", "repo"),
            ("/path/to/repo/", "repo"),
            ("C:\\Users\\me\\repo", "repo"),
            ("C:\\Users\\me\\repo.git\\", "repo"),
        ] {
            assert_eq!(repository_name(url), Some(name), "{url}");
        }
        assert_eq!(repository_name(""), None);
        assert_eq!(repository_name("/"), None);
    }

    #[test]
    fn refuses_what_is_not_a_normal_git_url() {
        for url in [
            "ext::sh -c 'touch /tmp/oxide-synthetic'",
            "fd::0",
            "fd::0/repo",
            "--upload-pack=touch /tmp/oxide-synthetic",
            "-oProxyCommand=x",
            "https://host/repo.git\nsecond line",
            "https://host/repo\0.git",
            "file:///etc",
            "http://host/repo.git",
            "ftp://host/repo.git",
            "nonexistent-folder-synthetic",
            "https://",
            "a b@host:path",
            "abcdeé/x",
            "abcdefgé/x",
            "",
        ] {
            assert!(checked_clone_url(url).is_err(), "{url:?} should be refused");
        }
    }

    #[test]
    fn accepts_each_allowed_form() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().to_string_lossy().into_owned();
        for url in [
            "https://github.com/owner/repo.git",
            "https://user:pw@host/owner/repo.git",
            "ssh://git@host:2222/owner/repo.git",
            "git://host/owner/repo.git",
            "git@github.com:owner/repo.git",
            "deploy_user@host.example:~/repo",
            local.as_str(),
        ] {
            assert_eq!(checked_clone_url(&format!("  {url}\n")).unwrap(), url);
        }
    }

    #[test]
    fn a_refused_clone_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let url = format!("ext::sh -c 'touch {}'", marker.display());
        assert!(clone_url(dir.path(), &url).is_err());
        assert!(!marker.exists());
    }

    #[test]
    fn a_failed_clone_does_not_show_the_credential() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing listens on port 1, so Git fails and echoes the URL in its stderr.
        let message = clone_url(
            dir.path(),
            "https://user:synthetic-secret@127.0.0.1:1/r.git",
        )
        .unwrap_err()
        .to_string();
        assert!(!message.contains("synthetic-secret"), "{message}");
    }
}
