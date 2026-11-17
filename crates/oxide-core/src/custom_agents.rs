//! Custom agents (ADR-0017): an agent CLI the user added in Settings with a name and the command
//! that launches it.
//!
//! The command is text the user typed, so it runs through their shell (ADR-0016). Everything
//! about it is validated here, in Core, not in the webview. A Custom agent has no Permission
//! mode, no Model list, no resume and no status unless it reports OSC 7501 itself.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The prefix of a Custom agent's id in a Thread's `provider` column.
pub const PROVIDER_PREFIX: &str = "custom:";

pub const MAX_AGENTS: usize = 16;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_COMMAND_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomAgent {
    /// Stable identity of the agent: Threads keep it after a rename. Lowercase letters, digits
    /// and `-`.
    pub id: String,
    /// What the Provider choice and the sidebar show.
    pub name: String,
    /// The command that launches the agent, run through the user's shell in the Thread's
    /// checkout.
    pub command: String,
}

impl CustomAgent {
    /// The value of a Thread's `provider` column for this agent.
    pub fn provider_id(&self) -> String {
        format!("{PROVIDER_PREFIX}{}", self.id)
    }

    /// Why this agent cannot be saved: the field and the reason, or `None`.
    pub fn problem(&self) -> Option<(&'static str, String)> {
        if self.id.is_empty()
            || self.id.len() > MAX_ID_BYTES
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Some(("id", "must be 1-32 lowercase letters, digits or `-`".into()));
        }
        let name = self.name.trim();
        let chars = name.chars().count();
        if chars == 0 || chars > MAX_NAME_CHARS {
            return Some(("name", format!("must be 1-{MAX_NAME_CHARS} characters")));
        }
        if self.name != name
            || !name.chars().all(|c| {
                c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | '+' | '(' | ')')
            })
        {
            return Some((
                "name",
                "may hold letters, digits, spaces and . - _ + ( ) only, without leading or trailing spaces".into(),
            ));
        }
        if self.command.trim().is_empty() || self.command.len() > MAX_COMMAND_BYTES {
            return Some(("command", format!("must be 1-{MAX_COMMAND_BYTES} bytes")));
        }
        if self.command.chars().any(char::is_control) {
            return Some((
                "command",
                "must be one line without control characters".into(),
            ));
        }
        None
    }
}

/// The first problem in a list of agents as `(index, field, message)`: each agent valid, ids and
/// names (ignoring case) unique, and no more than [`MAX_AGENTS`].
pub fn list_problem(agents: &[CustomAgent]) -> Option<(usize, &'static str, String)> {
    if agents.len() > MAX_AGENTS {
        return Some((
            MAX_AGENTS,
            "name",
            format!("at most {MAX_AGENTS} Custom agents"),
        ));
    }
    for (index, agent) in agents.iter().enumerate() {
        if let Some((field, message)) = agent.problem() {
            return Some((index, field, message));
        }
        if let Some(first) = agents[..index].iter().find(|other| other.id == agent.id) {
            return Some((index, "id", format!("`{}` is used twice", first.id)));
        }
        if agents[..index]
            .iter()
            .any(|other| other.name.eq_ignore_ascii_case(&agent.name))
        {
            return Some((index, "name", format!("`{}` is used twice", agent.name)));
        }
    }
    None
}

/// The id of the Custom agent a Thread's `provider` names, if it names one.
pub fn custom_id(provider: &str) -> Option<&str> {
    provider.strip_prefix(PROVIDER_PREFIX)
}

/// The program and arguments that run `command` through the user's shell.
pub(crate) fn shell_invocation(command: &str) -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        (
            PathBuf::from("powershell.exe"),
            vec!["-NoLogo".into(), "-Command".into(), command.to_string()],
        )
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| shell.starts_with('/'))
            .unwrap_or_else(|| "/bin/sh".into());
        (PathBuf::from(shell), vec!["-c".into(), command.to_string()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, command: &str) -> CustomAgent {
        CustomAgent {
            id: "mine".into(),
            name: name.into(),
            command: command.into(),
        }
    }

    #[test]
    fn a_name_and_a_one_line_command_are_accepted() {
        assert_eq!(agent("My agent (beta)", "my-agent --fast").problem(), None);
        assert_eq!(
            agent("Agent", "FOO=1 aider --model x | cat").problem(),
            None
        );
    }

    #[test]
    fn names_that_are_empty_long_or_odd_are_refused() {
        for bad in [
            "",
            "   ",
            " padded",
            "tab\tname",
            "new\nline",
            "a/b",
            "semi;colon",
            "emoji\u{1F600}",
            &"x".repeat(MAX_NAME_CHARS + 1),
        ] {
            assert_eq!(
                agent(bad, "run").problem().map(|p| p.0),
                Some("name"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn commands_that_are_empty_long_or_multi_line_are_refused() {
        for bad in [
            "",
            "   ",
            "a\nb",
            "a\rb",
            "a\0b",
            "a\x1b[2Jb",
            &"x".repeat(MAX_COMMAND_BYTES + 1),
        ] {
            assert_eq!(
                agent("Agent", bad).problem().map(|p| p.0),
                Some("command"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn ids_are_restricted_to_a_safe_alphabet() {
        for bad in ["", "Mine", "a b", "a:b", "../x", &"a".repeat(33)] {
            let mut a = agent("Agent", "run");
            a.id = bad.into();
            assert_eq!(a.problem().map(|p| p.0), Some("id"), "{bad:?}");
        }
    }

    #[test]
    fn a_list_refuses_duplicates_and_too_many() {
        let a = agent("Agent", "run");
        let mut same_id = agent("Other", "run");
        same_id.id = a.id.clone();
        assert_eq!(list_problem(&[a.clone(), same_id]).map(|p| p.1), Some("id"));
        let mut same_name = agent("AGENT", "run");
        same_name.id = "other".into();
        assert_eq!(
            list_problem(&[a.clone(), same_name]).map(|p| p.1),
            Some("name")
        );
        let many: Vec<CustomAgent> = (0..=MAX_AGENTS)
            .map(|i| CustomAgent {
                id: format!("a{i}"),
                name: format!("Agent {i}"),
                command: "run".into(),
            })
            .collect();
        assert!(list_problem(&many).is_some());
        assert_eq!(list_problem(&many[..MAX_AGENTS]), None);
    }

    #[test]
    fn the_command_reaches_the_shell_as_one_argument() {
        let (_, args) = shell_invocation("run 'a b'; echo $HOME");
        #[cfg(not(windows))]
        assert_eq!(args, ["-c", "run 'a b'; echo $HOME"]);
        #[cfg(windows)]
        assert_eq!(
            args.last().map(String::as_str),
            Some("run 'a b'; echo $HOME")
        );
    }

    #[test]
    fn a_custom_provider_id_round_trips() {
        let a = agent("Agent", "run");
        assert_eq!(custom_id(&a.provider_id()), Some("mine"));
        assert_eq!(custom_id("claude"), None);
    }
}
