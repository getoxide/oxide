use crate::*;

impl From<oxide_core::ShellKind> for ShellKind {
    fn from(k: oxide_core::ShellKind) -> Self {
        match k {
            oxide_core::ShellKind::Default => Self::Default,
            oxide_core::ShellKind::Zsh => Self::Zsh,
            oxide_core::ShellKind::Bash => Self::Bash,
            oxide_core::ShellKind::PowerShell => Self::PowerShell,
            oxide_core::ShellKind::Pwsh => Self::Pwsh,
        }
    }
}

impl From<ShellKind> for oxide_core::ShellKind {
    fn from(k: ShellKind) -> Self {
        match k {
            ShellKind::Default => Self::Default,
            ShellKind::Zsh => Self::Zsh,
            ShellKind::Bash => Self::Bash,
            ShellKind::PowerShell => Self::PowerShell,
            ShellKind::Pwsh => Self::Pwsh,
        }
    }
}

impl From<oxide_core::AvailableShell> for AvailableShell {
    fn from(s: oxide_core::AvailableShell) -> Self {
        Self {
            kind: s.kind.into(),
            label: s.label,
            is_default: s.is_default,
        }
    }
}

impl From<oxide_core::TerminalSettings> for TerminalSettings {
    fn from(s: oxide_core::TerminalSettings) -> Self {
        Self {
            shell: s.shell.into(),
            load_user_config: s.load_user_config,
        }
    }
}

impl From<TerminalSettings> for oxide_core::TerminalSettings {
    fn from(s: TerminalSettings) -> Self {
        Self {
            shell: s.shell.into(),
            load_user_config: s.load_user_config,
        }
    }
}

impl From<oxide_core::GithubRepository> for GithubRepository {
    fn from(r: oxide_core::GithubRepository) -> Self {
        Self {
            name_with_owner: r.name_with_owner,
            description: r.description,
            is_private: r.is_private,
        }
    }
}

impl From<oxide_core::TerminalSummary> for Terminal {
    fn from(t: oxide_core::TerminalSummary) -> Self {
        Self {
            id: t.id,
            pid: t.pid,
            cwd: t.cwd,
            shell: t.shell,
        }
    }
}

impl From<oxide_core::FileEntry> for FileEntry {
    fn from(e: oxide_core::FileEntry) -> Self {
        Self {
            name: e.name,
            path: e.path,
            is_dir: e.is_dir,
        }
    }
}

impl From<oxide_core::LanguageTool> for LanguageTool {
    fn from(t: oxide_core::LanguageTool) -> Self {
        Self {
            language: t.language,
            name: t.name,
            config: t.config.into(),
            installed: t.installed,
            resolved_path: t.resolved_path,
            install_command: t.install_command,
            documentation: t.documentation,
        }
    }
}

impl From<oxide_core::LanguageServerSummary> for LanguageServer {
    fn from(s: oxide_core::LanguageServerSummary) -> Self {
        Self {
            id: s.id,
            root: s.root,
            language: s.language,
            initialization_options: s.initialization_options,
        }
    }
}

impl From<oxide_core::desktop_tools::DeveloperTool> for DeveloperTool {
    fn from(t: oxide_core::desktop_tools::DeveloperTool) -> Self {
        Self {
            id: t.id,
            name: t.name,
            installed: t.installed,
            path: t.path,
            can_install: t.can_install,
            documentation: t.documentation,
        }
    }
}

impl From<oxide_core::GithubAvailability> for GithubAvailability {
    fn from(a: oxide_core::GithubAvailability) -> Self {
        match a {
            oxide_core::GithubAvailability::Ready => Self::Ready,
            oxide_core::GithubAvailability::Missing => Self::Missing,
            oxide_core::GithubAvailability::LoggedOut => Self::LoggedOut,
        }
    }
}

impl From<oxide_core::PullRequest> for PullRequest {
    fn from(p: oxide_core::PullRequest) -> Self {
        Self {
            number: p.number,
            title: p.title,
            url: p.url,
            draft: p.draft,
            base: p.base,
            head: p.head,
            cross_repository: p.cross_repository,
            author: p.author,
            created_at: p.created_at,
        }
    }
}

impl From<oxide_core::PullRequestPhase> for PullRequestPhase {
    fn from(p: oxide_core::PullRequestPhase) -> Self {
        match p {
            oxide_core::PullRequestPhase::Draft => Self::Draft,
            oxide_core::PullRequestPhase::Open => Self::Open,
            oxide_core::PullRequestPhase::Merged => Self::Merged,
            oxide_core::PullRequestPhase::Closed => Self::Closed,
        }
    }
}

impl From<oxide_core::MergeMethod> for MergeMethod {
    fn from(m: oxide_core::MergeMethod) -> Self {
        match m {
            oxide_core::MergeMethod::Merge => Self::Merge,
            oxide_core::MergeMethod::Squash => Self::Squash,
            oxide_core::MergeMethod::Rebase => Self::Rebase,
        }
    }
}

impl From<MergeMethod> for oxide_core::MergeMethod {
    fn from(m: MergeMethod) -> Self {
        match m {
            MergeMethod::Merge => Self::Merge,
            MergeMethod::Squash => Self::Squash,
            MergeMethod::Rebase => Self::Rebase,
        }
    }
}

impl From<oxide_core::CheckState> for CheckState {
    fn from(s: oxide_core::CheckState) -> Self {
        match s {
            oxide_core::CheckState::Success => Self::Success,
            oxide_core::CheckState::Failure => Self::Failure,
            oxide_core::CheckState::Pending => Self::Pending,
            oxide_core::CheckState::Neutral => Self::Neutral,
            oxide_core::CheckState::Skipped => Self::Skipped,
        }
    }
}

impl From<oxide_core::PullRequestCheck> for PullRequestCheck {
    fn from(c: oxide_core::PullRequestCheck) -> Self {
        Self {
            name: c.name,
            state: c.state.into(),
            url: c.url,
            required: c.required,
        }
    }
}

impl From<oxide_core::MergeState> for MergeState {
    fn from(s: oxide_core::MergeState) -> Self {
        match s {
            oxide_core::MergeState::Clean => Self::Clean,
            oxide_core::MergeState::Conflicting => Self::Conflicting,
            oxide_core::MergeState::Behind => Self::Behind,
            oxide_core::MergeState::Blocked => Self::Blocked,
            oxide_core::MergeState::Unstable => Self::Unstable,
            oxide_core::MergeState::Unknown => Self::Unknown,
        }
    }
}

impl From<oxide_core::ReviewDecision> for ReviewDecision {
    fn from(d: oxide_core::ReviewDecision) -> Self {
        match d {
            oxide_core::ReviewDecision::Approved => Self::Approved,
            oxide_core::ReviewDecision::ChangesRequested => Self::ChangesRequested,
            oxide_core::ReviewDecision::ReviewRequired => Self::ReviewRequired,
        }
    }
}

impl From<oxide_core::ReviewState> for ReviewState {
    fn from(s: oxide_core::ReviewState) -> Self {
        match s {
            oxide_core::ReviewState::Requested => Self::Requested,
            oxide_core::ReviewState::Approved => Self::Approved,
            oxide_core::ReviewState::ChangesRequested => Self::ChangesRequested,
            oxide_core::ReviewState::Commented => Self::Commented,
            oxide_core::ReviewState::Dismissed => Self::Dismissed,
        }
    }
}

impl From<oxide_core::PullRequestReviewer> for PullRequestReviewer {
    fn from(r: oxide_core::PullRequestReviewer) -> Self {
        Self {
            login: r.login,
            state: r.state.into(),
        }
    }
}

impl From<oxide_core::PullRequestLabel> for PullRequestLabel {
    fn from(l: oxide_core::PullRequestLabel) -> Self {
        Self {
            name: l.name,
            color: l.color,
        }
    }
}

impl From<oxide_core::TimelineComment> for TimelineComment {
    fn from(x: oxide_core::TimelineComment) -> Self {
        Self {
            id: x.id,
            author: x.author,
            body: x.body,
            created_at: x.created_at,
            reactions: x.reactions.map(|r| r.into_iter().map(Into::into).collect()),
        }
    }
}

impl From<oxide_core::TimelineReview> for TimelineReview {
    fn from(x: oxide_core::TimelineReview) -> Self {
        Self {
            id: x.id,
            author: x.author,
            body: x.body,
            created_at: x.created_at,
            state: x.state.into(),
            reactions: x.reactions.map(|r| r.into_iter().map(Into::into).collect()),
        }
    }
}

impl From<oxide_core::ReactionContent> for ReactionContent {
    fn from(c: oxide_core::ReactionContent) -> Self {
        match c {
            oxide_core::ReactionContent::ThumbsUp => Self::ThumbsUp,
            oxide_core::ReactionContent::ThumbsDown => Self::ThumbsDown,
            oxide_core::ReactionContent::Laugh => Self::Laugh,
            oxide_core::ReactionContent::Hooray => Self::Hooray,
            oxide_core::ReactionContent::Confused => Self::Confused,
            oxide_core::ReactionContent::Heart => Self::Heart,
            oxide_core::ReactionContent::Rocket => Self::Rocket,
            oxide_core::ReactionContent::Eyes => Self::Eyes,
        }
    }
}

impl From<ReactionContent> for oxide_core::ReactionContent {
    fn from(c: ReactionContent) -> Self {
        match c {
            ReactionContent::ThumbsUp => Self::ThumbsUp,
            ReactionContent::ThumbsDown => Self::ThumbsDown,
            ReactionContent::Laugh => Self::Laugh,
            ReactionContent::Hooray => Self::Hooray,
            ReactionContent::Confused => Self::Confused,
            ReactionContent::Heart => Self::Heart,
            ReactionContent::Rocket => Self::Rocket,
            ReactionContent::Eyes => Self::Eyes,
        }
    }
}

impl From<oxide_core::ReactionGroup> for ReactionGroup {
    fn from(g: oxide_core::ReactionGroup) -> Self {
        Self {
            content: g.content.into(),
            count: g.count,
            viewer_has_reacted: g.viewer_has_reacted,
        }
    }
}

impl From<oxide_core::TimelineCommit> for TimelineCommit {
    fn from(x: oxide_core::TimelineCommit) -> Self {
        Self {
            oid: x.oid,
            abbreviated_oid: x.abbreviated_oid,
            headline: x.headline,
            author: x.author,
            committed_at: x.committed_at,
            verified: x.verified,
            status: x.status.map(Into::into),
            url: x.url,
        }
    }
}

impl From<oxide_core::TimelineForcePush> for TimelineForcePush {
    fn from(x: oxide_core::TimelineForcePush) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            branch: x.branch,
            before: x.before,
            after: x.after,
            compare_url: x.compare_url,
        }
    }
}

impl From<oxide_core::TimelinePerson> for TimelinePerson {
    fn from(x: oxide_core::TimelinePerson) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            login: x.login,
        }
    }
}

impl From<oxide_core::TimelineLabel> for TimelineLabel {
    fn from(x: oxide_core::TimelineLabel) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            label: x.label.into(),
        }
    }
}

impl From<oxide_core::TimelineClosed> for TimelineClosed {
    fn from(x: oxide_core::TimelineClosed) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            state_reason: x.state_reason,
        }
    }
}

impl From<oxide_core::TimelineAction> for TimelineAction {
    fn from(x: oxide_core::TimelineAction) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
        }
    }
}

impl From<oxide_core::TimelineMerge> for TimelineMerge {
    fn from(x: oxide_core::TimelineMerge) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            commit: x.commit,
            base: x.base,
        }
    }
}

impl From<oxide_core::TimelineRename> for TimelineRename {
    fn from(x: oxide_core::TimelineRename) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            from: x.from,
            to: x.to,
        }
    }
}

impl From<oxide_core::TimelineReference> for TimelineReference {
    fn from(x: oxide_core::TimelineReference) -> Self {
        Self {
            actor: x.actor,
            created_at: x.created_at,
            number: x.number,
            title: x.title,
            url: x.url,
            state: x.state,
            pull_request: x.pull_request,
            repository: x.repository,
            cross_repository: x.cross_repository,
        }
    }
}

impl From<oxide_core::TimelineItem> for TimelineItem {
    fn from(item: oxide_core::TimelineItem) -> Self {
        use oxide_core::TimelineItem as Core;
        match item {
            Core::Comment(x) => Self::Comment(x.into()),
            Core::Review(x) => Self::Review(x.into()),
            Core::Commit(x) => Self::Commit(x.into()),
            Core::ForcePush(x) => Self::ForcePush(x.into()),
            Core::Assigned(x) => Self::Assigned(x.into()),
            Core::Unassigned(x) => Self::Unassigned(x.into()),
            Core::Labeled(x) => Self::Labeled(x.into()),
            Core::Unlabeled(x) => Self::Unlabeled(x.into()),
            Core::ReviewRequested(x) => Self::ReviewRequested(x.into()),
            Core::ReviewRequestRemoved(x) => Self::ReviewRequestRemoved(x.into()),
            Core::Closed(x) => Self::Closed(x.into()),
            Core::Reopened(x) => Self::Reopened(x.into()),
            Core::Merged(x) => Self::Merged(x.into()),
            Core::ConvertedToDraft(x) => Self::ConvertedToDraft(x.into()),
            Core::ReadyForReview(x) => Self::ReadyForReview(x.into()),
            Core::Renamed(x) => Self::Renamed(x.into()),
            Core::HeadRefDeleted(x) => Self::HeadRefDeleted(x.into()),
            Core::HeadRefRestored(x) => Self::HeadRefRestored(x.into()),
            Core::CrossReferenced(x) => Self::CrossReferenced(x.into()),
        }
    }
}

impl From<oxide_core::PullRequestCandidates> for PullRequestCandidates {
    fn from(c: oxide_core::PullRequestCandidates) -> Self {
        Self {
            users: c.users,
            labels: c.labels.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PullRequestEdit> for oxide_core::PullRequestEdit {
    fn from(e: PullRequestEdit) -> Self {
        Self {
            add_reviewers: e.add_reviewers,
            remove_reviewers: e.remove_reviewers,
            add_assignees: e.add_assignees,
            remove_assignees: e.remove_assignees,
            add_labels: e.add_labels,
            remove_labels: e.remove_labels,
        }
    }
}

impl From<oxide_core::PullRequestDetail> for PullRequestDetail {
    fn from(d: oxide_core::PullRequestDetail) -> Self {
        Self {
            pull_request: d.pull_request.into(),
            phase: d.phase.into(),
            body: d.body,
            head_sha: d.head_sha,
            checks: d.checks.into_iter().map(Into::into).collect(),
            merge_state: d.merge_state.into(),
            review_decision: d.review_decision.map(Into::into),
            reviewers: d.reviewers.into_iter().map(Into::into).collect(),
            assignees: d.assignees,
            labels: d.labels.into_iter().map(Into::into).collect(),
            additions: d.additions,
            deletions: d.deletions,
            viewer: d.viewer,
            merge_methods: d.merge_methods.into_iter().map(Into::into).collect(),
            default_merge_method: d.default_merge_method.map(Into::into),
            delete_branch_on_merge: d.delete_branch_on_merge,
            changed_files: d.changed_files,
            node_id: d.node_id,
            participants: d.participants,
            timeline: d.timeline.into_iter().map(Into::into).collect(),
            timeline_truncated: d.timeline_truncated,
            reactions: d.reactions.into_iter().map(Into::into).collect(),
            signed_images: d.signed_images.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::SignedImage> for SignedImage {
    fn from(i: oxide_core::SignedImage) -> Self {
        Self {
            asset_id: i.asset_id,
            signed_url: i.signed_url,
        }
    }
}

impl From<oxide_core::LinkedIssue> for LinkedIssue {
    fn from(i: oxide_core::LinkedIssue) -> Self {
        Self {
            number: i.number,
            title: i.title,
            state: i.state,
            state_reason: i.state_reason,
            url: i.url,
            repository: i.repository,
            cross_repository: i.cross_repository,
        }
    }
}

impl From<oxide_core::IssueSummary> for IssueSummary {
    fn from(s: oxide_core::IssueSummary) -> Self {
        Self {
            number: s.number,
            title: s.title,
            state: s.state,
            state_reason: s.state_reason,
            author: s.author,
            url: s.url,
            comments_count: s.comments_count,
            created_at: s.created_at,
            labels: s.labels.into_iter().map(Into::into).collect(),
            assignees: s.assignees,
            parent: s.parent.map(Into::into),
            sub_issues_total: s.sub_issues_total,
            sub_issues_completed: s.sub_issues_completed,
            blocked_by_count: s.blocked_by_count,
        }
    }
}

impl From<oxide_core::IssueDetail> for IssueDetail {
    fn from(d: oxide_core::IssueDetail) -> Self {
        Self {
            number: d.number,
            title: d.title,
            body: d.body,
            state: d.state,
            state_reason: d.state_reason,
            author: d.author,
            url: d.url,
            created_at: d.created_at,
            labels: d.labels.into_iter().map(Into::into).collect(),
            assignees: d.assignees,
            viewer: d.viewer,
            node_id: d.node_id,
            participants: d.participants,
            timeline: d.timeline.into_iter().map(Into::into).collect(),
            timeline_truncated: d.timeline_truncated,
            reactions: d.reactions.into_iter().map(Into::into).collect(),
            signed_images: d.signed_images.into_iter().map(Into::into).collect(),
            parent: d.parent.map(Into::into),
            sub_issues_total: d.sub_issues_total,
            sub_issues_completed: d.sub_issues_completed,
            sub_issues: d.sub_issues.into_iter().map(Into::into).collect(),
            blocked_by_count: d.blocked_by_count,
            blocked_by: d.blocked_by.into_iter().map(Into::into).collect(),
            blocking: d.blocking.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<IssueCloseReason> for oxide_core::IssueCloseReason {
    fn from(r: IssueCloseReason) -> Self {
        match r {
            IssueCloseReason::Completed => Self::Completed,
            IssueCloseReason::NotPlanned => Self::NotPlanned,
        }
    }
}

impl From<IssueEdit> for oxide_core::IssueEdit {
    fn from(e: IssueEdit) -> Self {
        Self {
            title: e.title,
            body: e.body,
            add_assignees: e.add_assignees,
            remove_assignees: e.remove_assignees,
            add_labels: e.add_labels,
            remove_labels: e.remove_labels,
        }
    }
}

impl From<oxide_core::IssueTemplateFile> for IssueTemplateFile {
    fn from(f: oxide_core::IssueTemplateFile) -> Self {
        Self {
            name: f.name,
            content: f.content,
        }
    }
}

impl From<oxide_core::IssuesState> for IssuesState {
    fn from(s: oxide_core::IssuesState) -> Self {
        Self {
            availability: s.availability.into(),
            guidance: s.guidance,
        }
    }
}

impl From<oxide_core::PullRequestDraft> for PullRequestDraft {
    fn from(d: oxide_core::PullRequestDraft) -> Self {
        Self {
            title: d.title,
            body: d.body,
            base: d.base,
            head: d.head,
            commits_beyond: d.commits_beyond,
            protected: d.protected,
            heads: d.heads,
        }
    }
}

impl From<oxide_core::LanguageServerConfig> for LanguageServerConfig {
    fn from(c: oxide_core::LanguageServerConfig) -> Self {
        Self {
            command: c.command,
            args: c.args,
            interpreter: c.interpreter,
        }
    }
}
