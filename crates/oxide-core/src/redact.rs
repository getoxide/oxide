//! Keeps credentials out of the messages that leave Core.
//!
//! A pasted clone URL such as `https://user:token@host/repo.git` is echoed back
//! by Git's own stderr and by `gh`. [`redact_url_credentials`] is the one place
//! that removes the userinfo from such text; every Git and `gh` error string
//! passes through it before it becomes an [`crate::Error`].

/// `text` with the userinfo (`user:password@`) removed from every
/// `scheme://userinfo@host` URL in it.
pub(crate) fn redact_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let authority_start = at + 3;
        out.push_str(&rest[..authority_start]);
        rest = &rest[authority_start..];
        // The authority ends at the path, query, fragment, whitespace or a quote.
        let end = rest
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '/' | '?' | '#' | '\'' | '"' | '<' | '>')
            })
            .unwrap_or(rest.len());
        if let Some(last_at) = rest[..end].rfind('@') {
            rest = &rest[last_at + 1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::redact_url_credentials as redact;

    #[test]
    fn removes_user_and_password() {
        assert_eq!(
            redact("fatal: unable to access 'https://user:s3cret-token@host/repo.git/': 403"),
            "fatal: unable to access 'https://host/repo.git/': 403"
        );
    }

    #[test]
    fn removes_a_token_used_as_user_name() {
        assert_eq!(
            redact("https://ghp_SYNTHETIC@host/r.git"),
            "https://host/r.git"
        );
    }

    #[test]
    fn removes_userinfo_with_an_unescaped_at_sign() {
        assert_eq!(redact("ssh://me:p@ss@host/r"), "ssh://host/r");
    }

    #[test]
    fn handles_several_urls_and_schemes() {
        assert_eq!(
            redact("a https://u:p@one/x then git://v:q@two:9418/y"),
            "a https://one/x then git://two:9418/y"
        );
    }

    #[test]
    fn leaves_credential_free_text_alone() {
        for text in [
            "Cloning into 'repo'...",
            "https://host/path/with@sign",
            "git@host:owner/repo.git",
            "https://host/repo.git",
            "",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn keeps_multibyte_text_intact() {
        assert_eq!(redact("è https://u:p@host/é"), "è https://host/é");
    }
}
