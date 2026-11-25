//! Reactions on an issue or pull request description, a comment or a review: read with the
//! timeline, toggled through GitHub's `addReaction` / `removeReaction` GraphQL mutations.

use super::{Gh, checked_node_id};
use crate::Result;
use serde::Serialize;
use std::path::Path;

/// One of the eight reactions GitHub offers. A closed set: nothing else reaches `gh`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReactionContent {
    ThumbsUp,
    ThumbsDown,
    Laugh,
    Hooray,
    Confused,
    Heart,
    Rocket,
    Eyes,
}

impl ReactionContent {
    /// GitHub's GraphQL name of the reaction.
    fn graphql(self) -> &'static str {
        match self {
            Self::ThumbsUp => "THUMBS_UP",
            Self::ThumbsDown => "THUMBS_DOWN",
            Self::Laugh => "LAUGH",
            Self::Hooray => "HOORAY",
            Self::Confused => "CONFUSED",
            Self::Heart => "HEART",
            Self::Rocket => "ROCKET",
            Self::Eyes => "EYES",
        }
    }

    fn from_graphql(name: &str) -> Option<Self> {
        Some(match name {
            "THUMBS_UP" => Self::ThumbsUp,
            "THUMBS_DOWN" => Self::ThumbsDown,
            "LAUGH" => Self::Laugh,
            "HOORAY" => Self::Hooray,
            "CONFUSED" => Self::Confused,
            "HEART" => Self::Heart,
            "ROCKET" => Self::Rocket,
            "EYES" => Self::Eyes,
            _ => return None,
        })
    }
}

/// How many people gave one reaction, and whether the signed-in user is one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionGroup {
    pub content: ReactionContent,
    pub count: u32,
    pub viewer_has_reacted: bool,
}

/// The GraphQL selection the timeline query adds to every node that can be reacted to.
pub(super) const REACTION_FIELDS: &str =
    "reactionGroups{content viewerHasReacted reactors{totalCount}}";

/// The non-empty reaction groups of a node, in GitHub's order.
pub(super) fn reactions_from(node: &serde_json::Value) -> Vec<ReactionGroup> {
    node["reactionGroups"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|group| {
            let count = group["reactors"]["totalCount"].as_u64().unwrap_or(0) as u32;
            if count == 0 {
                return None;
            }
            Some(ReactionGroup {
                content: ReactionContent::from_graphql(group["content"].as_str()?)?,
                count,
                viewer_has_reacted: group["viewerHasReacted"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

/// Adds (`add`) or removes the signed-in user's `content` reaction on the issue, pull
/// request, comment or review whose GraphQL node id is `subject_id`.
pub fn toggle_reaction(
    gh: &Gh,
    cwd: &Path,
    subject_id: &str,
    content: ReactionContent,
    add: bool,
) -> Result<()> {
    let subject_id = checked_node_id(subject_id)?;
    gh.require_ready(cwd)?;
    let mutation = if add { "addReaction" } else { "removeReaction" };
    gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("subject={subject_id}"),
            "-f",
            &format!("content={}", content.graphql()),
            "-f",
            &format!(
                "query=mutation($subject:ID!,$content:ReactionContent!){{{mutation}(input:{{subjectId:$subject,content:$content}}){{reaction{{content}}}}}}"
            ),
        ],
    )?;
    Ok(())
}
