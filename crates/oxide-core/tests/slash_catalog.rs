use oxide_core::slash_catalog::merge;
use oxide_provider::{SlashCommandInfo, SlashRoute};

fn command(name: &str, route: SlashRoute) -> SlashCommandInfo {
    SlashCommandInfo {
        name: name.into(),
        description: None,
        argument_hint: None,
        aliases: Vec::new(),
        route,
    }
}

fn names(provider: Vec<SlashCommandInfo>) -> Vec<String> {
    merge(provider).into_iter().map(|c| c.name).collect()
}

#[test]
fn effort_is_not_in_the_merged_catalog_while_oxide_commands_remain() {
    let names = names(Vec::new());
    assert!(!names.iter().any(|name| name == "effort"));
    for oxide in [
        "clear",
        "diff",
        "model",
        "permissions",
        "reload-cache",
        "rename",
    ] {
        assert!(
            names.iter().any(|name| name == oxide),
            "{oxide} must stay in the catalog"
        );
    }
}

#[test]
fn a_provider_reported_effort_is_not_surfaced() {
    let names = names(vec![
        command("effort", SlashRoute::Passthrough),
        command("context", SlashRoute::Passthrough),
    ]);
    assert!(!names.iter().any(|name| name == "effort"));
    assert!(names.iter().any(|name| name == "context"));
}
