use crate::*;

impl From<oxide_core::Provider> for Provider {
    fn from(p: oxide_core::Provider) -> Self {
        match p {
            oxide_core::Provider::Claude => Self::Claude,
            oxide_core::Provider::Codex => Self::Codex,
            oxide_core::Provider::Antigravity => Self::Antigravity,
        }
    }
}

impl From<Provider> for oxide_core::Provider {
    fn from(p: Provider) -> Self {
        match p {
            Provider::Claude => Self::Claude,
            Provider::Codex => Self::Codex,
            Provider::Antigravity => Self::Antigravity,
        }
    }
}

impl From<oxide_core::PermissionMode> for PermissionMode {
    fn from(m: oxide_core::PermissionMode) -> Self {
        match m {
            oxide_core::PermissionMode::Ask => Self::Ask,
            oxide_core::PermissionMode::AutoEdit => Self::AutoEdit,
            oxide_core::PermissionMode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<PermissionMode> for oxide_core::PermissionMode {
    fn from(m: PermissionMode) -> Self {
        match m {
            PermissionMode::Ask => Self::Ask,
            PermissionMode::AutoEdit => Self::AutoEdit,
            PermissionMode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<oxide_core::ProviderSettings> for ProviderSettings {
    fn from(p: oxide_core::ProviderSettings) -> Self {
        Self {
            model: p.model,
            effort: p.effort,
            permission_mode: p.permission_mode.into(),
        }
    }
}

impl From<&oxide_core::ProviderSettings> for ProviderSettings {
    fn from(p: &oxide_core::ProviderSettings) -> Self {
        Self {
            model: p.model.clone(),
            effort: p.effort.clone(),
            permission_mode: p.permission_mode.into(),
        }
    }
}

impl From<ProviderSettings> for oxide_core::ProviderSettings {
    fn from(p: ProviderSettings) -> Self {
        Self {
            model: p.model,
            effort: p.effort,
            permission_mode: p.permission_mode.into(),
        }
    }
}

impl From<oxide_core::Providers> for Providers {
    fn from(p: oxide_core::Providers) -> Self {
        Self {
            claude: p.claude.into(),
            codex: p.codex.into(),
            antigravity: p.antigravity.into(),
        }
    }
}

impl From<&oxide_core::Providers> for Providers {
    fn from(p: &oxide_core::Providers) -> Self {
        Self {
            claude: (&p.claude).into(),
            codex: (&p.codex).into(),
            antigravity: (&p.antigravity).into(),
        }
    }
}

impl From<Providers> for oxide_core::Providers {
    fn from(p: Providers) -> Self {
        Self {
            claude: p.claude.into(),
            codex: p.codex.into(),
            antigravity: p.antigravity.into(),
        }
    }
}

impl From<oxide_core::ClaudeCustomizations> for ClaudeCustomizations {
    fn from(c: oxide_core::ClaudeCustomizations) -> Self {
        Self {
            claude_md: c.claude_md,
            skills: c.skills,
            plugins: c.plugins,
            mcp_servers: c.mcp_servers,
            hooks: c.hooks,
        }
    }
}

impl From<ClaudeCustomizations> for oxide_core::ClaudeCustomizations {
    fn from(c: ClaudeCustomizations) -> Self {
        Self {
            claude_md: c.claude_md,
            skills: c.skills,
            plugins: c.plugins,
            mcp_servers: c.mcp_servers,
            hooks: c.hooks,
        }
    }
}

impl From<oxide_core::Shortcuts> for Shortcuts {
    fn from(s: oxide_core::Shortcuts) -> Self {
        Self {
            new_thread: s.new_thread,
            open_project: s.open_project,
            model_picker: s.model_picker,
            pull_requests: s.pull_requests,
            issues: s.issues,
            terminal: s.terminal,
            files: s.files,
            previous_thread: s.previous_thread,
            next_thread: s.next_thread,
            close_thread: s.close_thread,
            toggle_tools: s.toggle_tools,
            open_settings: s.open_settings,
            toggle_sidebar: s.toggle_sidebar,
            maximize_surface: s.maximize_surface,
        }
    }
}

impl From<&oxide_core::Shortcuts> for Shortcuts {
    fn from(s: &oxide_core::Shortcuts) -> Self {
        Self {
            new_thread: s.new_thread.clone(),
            open_project: s.open_project.clone(),
            model_picker: s.model_picker.clone(),
            pull_requests: s.pull_requests.clone(),
            issues: s.issues.clone(),
            terminal: s.terminal.clone(),
            files: s.files.clone(),
            previous_thread: s.previous_thread.clone(),
            next_thread: s.next_thread.clone(),
            close_thread: s.close_thread.clone(),
            toggle_tools: s.toggle_tools.clone(),
            open_settings: s.open_settings.clone(),
            toggle_sidebar: s.toggle_sidebar.clone(),
            maximize_surface: s.maximize_surface.clone(),
        }
    }
}

impl From<Shortcuts> for oxide_core::Shortcuts {
    fn from(s: Shortcuts) -> Self {
        Self {
            new_thread: s.new_thread,
            open_project: s.open_project,
            model_picker: s.model_picker,
            pull_requests: s.pull_requests,
            issues: s.issues,
            terminal: s.terminal,
            files: s.files,
            previous_thread: s.previous_thread,
            next_thread: s.next_thread,
            close_thread: s.close_thread,
            toggle_tools: s.toggle_tools,
            open_settings: s.open_settings,
            toggle_sidebar: s.toggle_sidebar,
            maximize_surface: s.maximize_surface,
        }
    }
}

impl From<oxide_core::Settings> for Settings {
    fn from(s: oxide_core::Settings) -> Self {
        Self {
            default_provider: s.default_provider.into(),
            providers: s.providers.into(),
            confirm_quit: s.confirm_quit,
            delete_merged_branches: s.delete_merged_branches,
            claude_customizations: s.claude_customizations.into(),
            shortcuts: s.shortcuts.into(),
        }
    }
}

impl From<&oxide_core::Settings> for Settings {
    fn from(s: &oxide_core::Settings) -> Self {
        Self {
            default_provider: s.default_provider.into(),
            providers: (&s.providers).into(),
            confirm_quit: s.confirm_quit,
            delete_merged_branches: s.delete_merged_branches,
            claude_customizations: s.claude_customizations.into(),
            shortcuts: (&s.shortcuts).into(),
        }
    }
}

impl From<Settings> for oxide_core::Settings {
    fn from(s: Settings) -> Self {
        Self {
            default_provider: s.default_provider.into(),
            providers: s.providers.into(),
            confirm_quit: s.confirm_quit,
            delete_merged_branches: s.delete_merged_branches,
            claude_customizations: s.claude_customizations.into(),
            shortcuts: s.shortcuts.into(),
        }
    }
}

impl From<oxide_core::FieldError> for FieldError {
    fn from(e: oxide_core::FieldError) -> Self {
        Self {
            path: e.path,
            message: e.message,
        }
    }
}

impl From<&oxide_core::FieldError> for FieldError {
    fn from(e: &oxide_core::FieldError) -> Self {
        Self {
            path: e.path.clone(),
            message: e.message.clone(),
        }
    }
}

impl From<oxide_core::SettingsState> for SettingsState {
    fn from(s: oxide_core::SettingsState) -> Self {
        Self {
            settings: s.settings.into(),
            errors: s.errors.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<&oxide_core::SettingsState> for SettingsState {
    fn from(s: &oxide_core::SettingsState) -> Self {
        Self {
            settings: (&s.settings).into(),
            errors: s.errors.iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::AttachmentKind> for AttachmentKind {
    fn from(k: oxide_core::AttachmentKind) -> Self {
        match k {
            oxide_core::AttachmentKind::Image => Self::Image,
            oxide_core::AttachmentKind::Pdf => Self::Pdf,
            oxide_core::AttachmentKind::Text => Self::Text,
            oxide_core::AttachmentKind::Other => Self::Other,
        }
    }
}

impl From<oxide_core::ModelInfo> for ModelInfo {
    fn from(m: oxide_core::ModelInfo) -> Self {
        Self {
            id: m.id,
            name: m.name,
            description: m.description,
            supported_efforts: m.supported_efforts,
            default_effort: m.default_effort,
            is_legacy: m.is_legacy,
        }
    }
}

impl From<oxide_core::ProviderCapabilities> for ProviderCapabilities {
    fn from(c: oxide_core::ProviderCapabilities) -> Self {
        Self {
            supported_permission_modes: c
                .supported_permission_modes
                .into_iter()
                .map(Into::into)
                .collect(),
            interactive_approvals: c.interactive_approvals,
            supports_reasoning: c.supports_reasoning,
            native_attachment_kinds: c
                .native_attachment_kinds
                .into_iter()
                .map(Into::into)
                .collect(),
            mid_thread_model_switch: c.mid_thread_model_switch,
            reports_usage_limits: c.reports_usage_limits,
        }
    }
}

impl From<oxide_core::Detection> for Detection {
    fn from(d: oxide_core::Detection) -> Self {
        Self {
            available: d.available,
            installed: d.installed,
            version: d.version,
            authenticated: d.authenticated,
            warning: d.warning,
        }
    }
}

impl From<oxide_core::ApprovalDecision> for ApprovalDecision {
    fn from(d: oxide_core::ApprovalDecision) -> Self {
        match d {
            oxide_core::ApprovalDecision::Allow => Self::Allow,
            oxide_core::ApprovalDecision::Deny => Self::Deny,
        }
    }
}

impl From<ApprovalDecision> for oxide_core::ApprovalDecision {
    fn from(d: ApprovalDecision) -> Self {
        match d {
            ApprovalDecision::Allow => Self::Allow,
            ApprovalDecision::Deny => Self::Deny,
        }
    }
}

impl From<oxide_core::ApprovalKind> for ApprovalKind {
    fn from(k: oxide_core::ApprovalKind) -> Self {
        match k {
            oxide_core::ApprovalKind::Command => Self::Command,
            oxide_core::ApprovalKind::FileChange => Self::FileChange,
            oxide_core::ApprovalKind::Tool => Self::Tool,
            oxide_core::ApprovalKind::Other => Self::Other,
        }
    }
}

impl From<oxide_core::UsageStatus> for UsageStatus {
    fn from(s: oxide_core::UsageStatus) -> Self {
        match s {
            oxide_core::UsageStatus::Ok => Self::Ok,
            oxide_core::UsageStatus::Warning => Self::Warning,
            oxide_core::UsageStatus::Limited => Self::Limited,
        }
    }
}

impl From<oxide_core::UsageLimitWindow> for UsageLimitWindow {
    fn from(w: oxide_core::UsageLimitWindow) -> Self {
        Self {
            percent_used: w.percent_used,
            resets_at: w.resets_at.map(|v| v as f64),
            status: w.status.into(),
            reported_at: w.reported_at as f64,
        }
    }
}

impl From<oxide_core::UsagePoolLimits> for UsagePoolLimits {
    fn from(p: oxide_core::UsagePoolLimits) -> Self {
        Self {
            label: p.label,
            five_hour: p.five_hour.map(Into::into),
            weekly: p.weekly.map(Into::into),
        }
    }
}

impl From<oxide_core::UsageLimits> for UsageLimits {
    fn from(u: oxide_core::UsageLimits) -> Self {
        Self {
            five_hour: u.five_hour.map(Into::into),
            weekly: u.weekly.map(Into::into),
            pools: u.pools.into_iter().map(|(k, v)| (k, v.into())).collect(),
        }
    }
}

impl From<oxide_core::ThreadStatus> for ThreadStatus {
    fn from(s: oxide_core::ThreadStatus) -> Self {
        match s {
            oxide_core::ThreadStatus::Working => Self::Working,
            oxide_core::ThreadStatus::NeedsInput => Self::NeedsInput,
            oxide_core::ThreadStatus::Completed => Self::Completed,
            oxide_core::ThreadStatus::Error => Self::Error,
            oxide_core::ThreadStatus::Interrupted => Self::Interrupted,
        }
    }
}

impl From<oxide_core::ItemKind> for ItemKind {
    fn from(k: oxide_core::ItemKind) -> Self {
        match k {
            oxide_core::ItemKind::AgentMessage => Self::AgentMessage,
            oxide_core::ItemKind::Reasoning => Self::Reasoning,
            oxide_core::ItemKind::ToolCall => Self::ToolCall,
            oxide_core::ItemKind::FileChange => Self::FileChange,
            oxide_core::ItemKind::Subagent => Self::Subagent,
            oxide_core::ItemKind::SlashCommandOutput => Self::SlashCommandOutput,
            oxide_core::ItemKind::RestoreMarker => Self::RestoreMarker,
        }
    }
}

impl From<oxide_core::ActivityCategory> for ActivityCategory {
    fn from(c: oxide_core::ActivityCategory) -> Self {
        match c {
            oxide_core::ActivityCategory::Explore => Self::Explore,
            oxide_core::ActivityCategory::Edit => Self::Edit,
            oxide_core::ActivityCategory::Run => Self::Run,
            oxide_core::ActivityCategory::Delegate => Self::Delegate,
            oxide_core::ActivityCategory::Other => Self::Other,
        }
    }
}

impl From<oxide_core::TurnStatus> for TurnStatus {
    fn from(s: oxide_core::TurnStatus) -> Self {
        match s {
            oxide_core::TurnStatus::Running => Self::Running,
            oxide_core::TurnStatus::Completed => Self::Completed,
            oxide_core::TurnStatus::Interrupted => Self::Interrupted,
            oxide_core::TurnStatus::Error => Self::Error,
        }
    }
}

impl From<oxide_core::ThreadSummary> for Thread {
    fn from(t: oxide_core::ThreadSummary) -> Self {
        Self {
            id: t.id,
            project_id: t.project_id,
            provider: t.provider,
            model: t.model,
            effort: t.effort,
            permission_mode: t.permission_mode.into(),
            status: t.status.into(),
            created_at: t.created_at,
            updated_at: t.updated_at,
            title: t.title,
            session_lost: t.session_lost,
            continued_from: t.continued_from,
            continued_in: t.continued_in,
            branch: t.branch,
            worktree_path: t.worktree_path,
            setup_output: t.setup_output,
            issue_number: t.issue_number,
            blind_review: t.blind_review,
        }
    }
}

impl From<oxide_core::PendingApproval> for PendingApproval {
    fn from(a: oxide_core::PendingApproval) -> Self {
        Self {
            approval_id: a.approval_id,
            kind: a.kind.into(),
            summary: a.summary,
            options: a.options,
        }
    }
}

impl From<oxide_core::BoardCard> for BoardCard {
    fn from(c: oxide_core::BoardCard) -> Self {
        Self {
            thread: c.thread.into(),
            pending_approvals: c.pending_approvals.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::BoardEvent> for BoardEvent {
    fn from(e: oxide_core::BoardEvent) -> Self {
        match e {
            oxide_core::BoardEvent::ThreadChanged(card) => {
                Self::ThreadChanged(Box::new((*card).into()))
            }
            oxide_core::BoardEvent::ThreadDeleted(id) => Self::ThreadDeleted(id),
        }
    }
}

impl From<oxide_core::ContinuedThread> for ContinuedThread {
    fn from(c: oxide_core::ContinuedThread) -> Self {
        Self {
            thread: c.thread.into(),
            recap: c.recap,
        }
    }
}

impl From<oxide_core::CommandOutcome> for CommandOutcome {
    fn from(o: oxide_core::CommandOutcome) -> Self {
        match o {
            oxide_core::CommandOutcome::Succeeded => Self::Succeeded,
            oxide_core::CommandOutcome::Failed => Self::Failed,
            oxide_core::CommandOutcome::Unknown => Self::Unknown,
        }
    }
}

impl From<oxide_core::CommandRecord> for CommandRecord {
    fn from(c: oxide_core::CommandRecord) -> Self {
        Self {
            line: c.line,
            outcome: c.outcome.into(),
            exit_code: c.exit_code,
        }
    }
}

impl From<oxide_core::ItemSnapshot> for ItemSnapshot {
    fn from(i: oxide_core::ItemSnapshot) -> Self {
        Self {
            id: i.id,
            item_index: i.item_index,
            kind: i.kind.into(),
            content: i.content,
            parent_item_index: i.parent_item_index,
            category: i.category.map(Into::into),
            command: i.command.into(),
            created_at: i.created_at,
        }
    }
}

impl From<oxide_core::ApprovalSnapshot> for ApprovalSnapshot {
    fn from(a: oxide_core::ApprovalSnapshot) -> Self {
        Self {
            id: a.id,
            turn_id: a.turn_id,
            approval_id: a.approval_id,
            kind: a.kind.into(),
            summary: a.summary,
            options: a.options,
            decision: a.decision.map(Into::into),
            created_at: a.created_at,
            decided_at: a.decided_at,
        }
    }
}

impl From<oxide_core::Attachment> for Attachment {
    fn from(a: oxide_core::Attachment) -> Self {
        Self {
            id: a.id,
            name: a.name,
            kind: a.kind.into(),
            media_type: a.media_type,
            size_bytes: u32::try_from(a.size_bytes).unwrap_or(u32::MAX),
            path: a.path.to_string_lossy().into_owned(),
        }
    }
}

impl From<oxide_core::PromptSegment> for PromptSegment {
    fn from(s: oxide_core::PromptSegment) -> Self {
        match s {
            oxide_core::PromptSegment::Text { text } => Self::Text { text },
            oxide_core::PromptSegment::Attachment(a) => Self::Attachment {
                id: a.id,
                name: a.name,
                kind: a.kind.into(),
                media_type: a.media_type,
                size_bytes: u32::try_from(a.size_bytes).unwrap_or(u32::MAX),
                path: a.path.to_string_lossy().into_owned(),
            },
        }
    }
}

impl From<PromptInput> for oxide_core::PromptInput {
    fn from(i: PromptInput) -> Self {
        match i {
            PromptInput::Text { text } => Self::Text { text },
            PromptInput::Attachment { id } => Self::Attachment { id },
        }
    }
}

impl From<oxide_core::TurnError> for TurnError {
    fn from(e: oxide_core::TurnError) -> Self {
        Self {
            message: e.message,
            stderr_tail: e.stderr_tail,
        }
    }
}

impl From<oxide_core::UnknownEventSnapshot> for UnknownEventSnapshot {
    fn from(u: oxide_core::UnknownEventSnapshot) -> Self {
        Self {
            id: u.id,
            raw: u.raw,
            created_at: u.created_at,
        }
    }
}

impl From<oxide_core::TurnSnapshot> for TurnSnapshot {
    fn from(t: oxide_core::TurnSnapshot) -> Self {
        Self {
            id: t.id,
            turn_index: t.turn_index,
            prompt: t.prompt,
            model: t.model,
            effort: t.effort,
            permission_mode: t.permission_mode.map(Into::into),
            segments: t.segments.into_iter().map(Into::into).collect(),
            status: t.status.into(),
            started_at: t.started_at,
            completed_at: t.completed_at,
            items: t.items.into_iter().map(Into::into).collect(),
            error: t.error.map(Into::into),
            approvals: t.approvals.into_iter().map(Into::into).collect(),
            unknown_events: t.unknown_events.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::ThreadCapabilities> for ThreadCapabilities {
    fn from(c: oxide_core::ThreadCapabilities) -> Self {
        Self {
            reasoning_text: c.reasoning_text,
        }
    }
}

impl From<oxide_core::ThreadSnapshot> for ThreadSnapshot {
    fn from(s: oxide_core::ThreadSnapshot) -> Self {
        Self {
            thread: s.thread.into(),
            capabilities: s.capabilities.into(),
            turns: s.turns.into_iter().map(Into::into).collect(),
            turn_offset: s.turn_offset,
            turn_count: s.turn_count,
            last_seq: s.last_seq,
            supported_permission_modes: s
                .supported_permission_modes
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

impl From<oxide_core::TurnPage> for TurnPage {
    fn from(p: oxide_core::TurnPage) -> Self {
        Self {
            offset: p.offset,
            turns: p.turns.into_iter().map(Into::into).collect(),
            turn_count: p.turn_count,
        }
    }
}

impl From<oxide_core::ThreadEvent> for ThreadEvent {
    fn from(e: oxide_core::ThreadEvent) -> Self {
        match e {
            oxide_core::ThreadEvent::TurnStarted {
                turn_index,
                prompt,
                model,
                effort,
                permission_mode,
                segments,
            } => Self::TurnStarted {
                turn_index,
                prompt,
                model,
                effort,
                permission_mode: permission_mode.map(Into::into),
                segments: segments.into_iter().map(Into::into).collect(),
            },
            oxide_core::ThreadEvent::ItemStarted {
                item_index,
                kind,
                parent_item_index,
                category,
            } => Self::ItemStarted {
                item_index,
                kind: kind.into(),
                parent_item_index,
                category: category.map(Into::into),
            },
            oxide_core::ThreadEvent::ItemDeltaBatch { item_index, delta } => {
                Self::ItemDeltaBatch { item_index, delta }
            }
            oxide_core::ThreadEvent::ItemCompleted {
                item_index,
                kind,
                content,
                parent_item_index,
                category,
                command,
            } => Self::ItemCompleted {
                item_index,
                kind: kind.into(),
                content,
                parent_item_index,
                category: category.map(Into::into),
                command: command.map(Into::into),
            },
            oxide_core::ThreadEvent::TurnCompleted {
                turn_index,
                status,
                error,
            } => Self::TurnCompleted {
                turn_index,
                status: status.into(),
                error: error.map(Into::into),
            },
            oxide_core::ThreadEvent::ThreadStatusChanged { status } => Self::ThreadStatusChanged {
                status: status.into(),
            },
            oxide_core::ThreadEvent::ThreadRenamed { title } => Self::ThreadRenamed { title },
            oxide_core::ThreadEvent::ApprovalRequested {
                id,
                kind,
                summary,
                options,
            } => Self::ApprovalRequested {
                id,
                kind: kind.into(),
                summary,
                options,
            },
            oxide_core::ThreadEvent::ApprovalResponded {
                id,
                decision,
                decided_at,
            } => Self::ApprovalResponded {
                id,
                decision: decision.into(),
                decided_at,
            },
            oxide_core::ThreadEvent::ProviderRetrying { message } => {
                Self::ProviderRetrying { message }
            }
            oxide_core::ThreadEvent::SlashCommandsChanged => Self::SlashCommandsChanged,
            oxide_core::ThreadEvent::Error { message } => Self::Error { message },
            oxide_core::ThreadEvent::Unknown => Self::Unknown,
        }
    }
}

impl From<oxide_core::SequencedThreadEvent> for SequencedThreadEvent {
    fn from(e: oxide_core::SequencedThreadEvent) -> Self {
        Self {
            seq: e.seq,
            event: e.event.into(),
        }
    }
}

impl From<DispatchRequest> for oxide_core::DispatchRequest {
    fn from(r: DispatchRequest) -> Self {
        Self {
            project_id: r.project_id,
            prompt: r.prompt,
            provider: r.provider,
            model: r.model,
            effort: r.effort,
            permission_mode: r.permission_mode.map(Into::into),
            base_branch: r.base_branch,
            issue_number: r.issue_number,
            issue_title: r.issue_title,
            issue_url: r.issue_url,
            issue_labels: r.issue_labels,
        }
    }
}

impl From<BlindReviewRequest> for oxide_core::BlindReviewRequest {
    fn from(r: BlindReviewRequest) -> Self {
        Self {
            project_id: r.project_id,
            thread_id: r.thread_id,
            provider: r.provider,
            model: r.model,
            effort: r.effort,
            scope: r.scope,
            turn_index: r.turn_index,
            issue: r.issue,
        }
    }
}

impl From<oxide_core::CommentScope> for CommentScope {
    fn from(s: oxide_core::CommentScope) -> Self {
        match s {
            oxide_core::CommentScope::Turn => Self::Turn,
            oxide_core::CommentScope::Uncommitted => Self::Uncommitted,
            oxide_core::CommentScope::Branch => Self::Branch,
        }
    }
}

impl From<oxide_core::CommentSide> for CommentSide {
    fn from(s: oxide_core::CommentSide) -> Self {
        match s {
            oxide_core::CommentSide::Old => Self::Old,
            oxide_core::CommentSide::New => Self::New,
        }
    }
}

impl From<oxide_core::LineComment> for LineComment {
    fn from(c: oxide_core::LineComment) -> Self {
        Self {
            id: c.id,
            thread_id: c.thread_id,
            scope: c.scope.into(),
            path: c.path,
            side: c.side.into(),
            line: c.line,
            code: c.code,
            body: c.body,
            outdated: c.outdated,
            provider: c.provider,
        }
    }
}

impl From<oxide_core::FindingDecision> for FindingDecision {
    fn from(d: oxide_core::FindingDecision) -> Self {
        match d {
            oxide_core::FindingDecision::Pending => Self::Pending,
            oxide_core::FindingDecision::Kept => Self::Kept,
            oxide_core::FindingDecision::Dismissed => Self::Dismissed,
        }
    }
}

impl From<oxide_core::BlindReviewFinding> for BlindReviewFinding {
    fn from(f: oxide_core::BlindReviewFinding) -> Self {
        Self {
            id: f.id,
            review_thread_id: f.review_thread_id,
            provider: f.provider,
            path: f.path,
            side: f.side.map(Into::into),
            line: f.line,
            code: f.code,
            body: f.body,
            plain: f.plain,
            decision: f.decision.into(),
        }
    }
}

impl From<oxide_core::SlashRoute> for SlashRoute {
    fn from(r: oxide_core::SlashRoute) -> Self {
        match r {
            oxide_core::SlashRoute::Oxide => Self::Oxide,
            oxide_core::SlashRoute::Passthrough => Self::Passthrough,
            oxide_core::SlashRoute::Native => Self::Native,
        }
    }
}

impl From<oxide_core::SlashCommandInfo> for SlashCommand {
    fn from(c: oxide_core::SlashCommandInfo) -> Self {
        Self {
            name: c.name,
            description: c.description,
            argument_hint: c.argument_hint,
            aliases: c.aliases,
            route: c.route.into(),
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
        }
    }
}

impl From<oxide_core::ProjectServiceStatus> for ProjectServiceStatus {
    fn from(s: oxide_core::ProjectServiceStatus) -> Self {
        match s {
            oxide_core::ProjectServiceStatus::Running => Self::Running,
            oxide_core::ProjectServiceStatus::Stopped => Self::Stopped,
            oxide_core::ProjectServiceStatus::Failed => Self::Failed,
        }
    }
}

impl From<oxide_core::ProjectServiceStream> for ProjectServiceStream {
    fn from(s: oxide_core::ProjectServiceStream) -> Self {
        match s {
            oxide_core::ProjectServiceStream::Stdout => Self::Stdout,
            oxide_core::ProjectServiceStream::Stderr => Self::Stderr,
        }
    }
}

impl From<oxide_core::ProjectService> for ProjectService {
    fn from(s: oxide_core::ProjectService) -> Self {
        Self {
            id: s.id,
            project_id: s.project_id,
            thread_id: s.thread_id,
            command: s.command,
            checkout: s.checkout,
            status: s.status.into(),
            pid: s.pid,
            port: s.port,
            url: s.url,
            started_at: s.started_at,
            exit_code: s.exit_code,
        }
    }
}

impl From<oxide_core::ProjectServiceLogLine> for ProjectServiceLogLine {
    fn from(l: oxide_core::ProjectServiceLogLine) -> Self {
        Self {
            seq: l.seq,
            stream: l.stream.into(),
            text: l.text,
            at: l.at,
        }
    }
}

impl From<oxide_core::ProjectServiceConflict> for ProjectServiceConflict {
    fn from(c: oxide_core::ProjectServiceConflict) -> Self {
        Self {
            port: c.port,
            existing: c.existing.map(Into::into),
            message: c.message,
        }
    }
}

impl From<oxide_core::ProjectServiceStartOutcome> for ProjectServiceStartOutcome {
    fn from(o: oxide_core::ProjectServiceStartOutcome) -> Self {
        match o {
            oxide_core::ProjectServiceStartOutcome::Started(s) => Self::Started(s.into()),
            oxide_core::ProjectServiceStartOutcome::Conflict(c) => Self::Conflict(c.into()),
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

impl From<oxide_core::LanguageServerConfig> for LanguageServerConfig {
    fn from(c: oxide_core::LanguageServerConfig) -> Self {
        Self {
            command: c.command,
            args: c.args,
            interpreter: c.interpreter,
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

impl From<oxide_core::GitStatus> for GitStatus {
    fn from(s: oxide_core::GitStatus) -> Self {
        Self {
            branch: s.branch,
            upstream: s.upstream,
            ahead: s.ahead,
            behind: s.behind,
            added: s.added,
            removed: s.removed,
            changed_files: s.changed_files,
            picker_disabled_reason: s.picker_disabled_reason,
            protected: s.protected,
            unpublished: s.unpublished,
        }
    }
}

impl From<oxide_core::GitBranch> for GitBranch {
    fn from(b: oxide_core::GitBranch) -> Self {
        Self {
            name: b.name,
            remote: b.remote,
            current: b.current,
        }
    }
}

impl From<DiffScope> for oxide_core::DiffScope {
    fn from(s: DiffScope) -> Self {
        match s {
            DiffScope::Uncommitted => Self::Uncommitted,
            DiffScope::Branch => Self::Branch,
        }
    }
}

impl From<oxide_core::DiffStatus> for DiffStatus {
    fn from(s: oxide_core::DiffStatus) -> Self {
        match s {
            oxide_core::DiffStatus::Added => Self::Added,
            oxide_core::DiffStatus::Modified => Self::Modified,
            oxide_core::DiffStatus::Deleted => Self::Deleted,
            oxide_core::DiffStatus::Renamed => Self::Renamed,
            oxide_core::DiffStatus::Untracked => Self::Untracked,
        }
    }
}

impl From<oxide_core::DiffKind> for DiffKind {
    fn from(k: oxide_core::DiffKind) -> Self {
        match k {
            oxide_core::DiffKind::Context => Self::Context,
            oxide_core::DiffKind::Added => Self::Added,
            oxide_core::DiffKind::Removed => Self::Removed,
        }
    }
}

impl From<oxide_core::DiffLine> for DiffLine {
    fn from(l: oxide_core::DiffLine) -> Self {
        Self {
            kind: l.kind.into(),
            text: l.text,
        }
    }
}

impl From<oxide_core::DiffHunk> for DiffHunk {
    fn from(h: oxide_core::DiffHunk) -> Self {
        Self {
            header: h.header,
            lines: h.lines.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::DiffFile> for DiffFile {
    fn from(f: oxide_core::DiffFile) -> Self {
        Self {
            path: f.path,
            old_path: f.old_path,
            status: f.status.into(),
            added: f.added,
            removed: f.removed,
            binary: f.binary,
            hunks: f.hunks.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::Diff> for Diff {
    fn from(d: oxide_core::Diff) -> Self {
        Self {
            base: d.base,
            files: d.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::RestoreChange> for RestoreChange {
    fn from(c: oxide_core::RestoreChange) -> Self {
        match c {
            oxide_core::RestoreChange::Rewritten => Self::Rewritten,
            oxide_core::RestoreChange::Reinstated => Self::Reinstated,
            oxide_core::RestoreChange::Removed => Self::Removed,
        }
    }
}

impl From<oxide_core::RestoreFile> for RestoreFile {
    fn from(f: oxide_core::RestoreFile) -> Self {
        Self {
            path: f.path,
            change: f.change.into(),
        }
    }
}

impl From<oxide_core::RestorePreview> for RestorePreview {
    fn from(p: oxide_core::RestorePreview) -> Self {
        Self {
            turn_index: p.turn_index,
            files: p.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::RestoreOutcome> for RestoreOutcome {
    fn from(o: oxide_core::RestoreOutcome) -> Self {
        Self {
            turn_index: o.turn_index,
            files: o.files.into_iter().map(Into::into).collect(),
            undone: o.undone,
        }
    }
}

impl From<oxide_core::PendingRestore> for PendingRestore {
    fn from(p: oxide_core::PendingRestore) -> Self {
        Self {
            turn_index: p.turn_index,
            files: p.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::ReviewLedgerEntry> for ReviewLedgerEntry {
    fn from(e: oxide_core::ReviewLedgerEntry) -> Self {
        Self {
            project_id: e.project_id,
            thread_id: e.thread_id,
            pull_request: e.pull_request,
            provider: e.provider,
            model: e.model,
            turn_completed_at: e.turn_completed_at as f64,
            merged_at: e.merged_at as f64,
        }
    }
}

impl From<oxide_core::FollowUpStatus> for FollowUpStatus {
    fn from(s: oxide_core::FollowUpStatus) -> Self {
        match s {
            oxide_core::FollowUpStatus::Candidate => Self::Candidate,
            oxide_core::FollowUpStatus::Confirmed => Self::Confirmed,
            oxide_core::FollowUpStatus::Dismissed => Self::Dismissed,
        }
    }
}

impl From<oxide_core::ReviewRevert> for ReviewRevert {
    fn from(r: oxide_core::ReviewRevert) -> Self {
        Self {
            pull_request: r.pull_request,
            commit_sha: r.commit_sha,
            commit_subject: r.commit_subject,
            committed_at: r.committed_at as f64,
        }
    }
}

impl From<oxide_core::ReviewFollowUp> for ReviewFollowUp {
    fn from(f: oxide_core::ReviewFollowUp) -> Self {
        Self {
            pull_request: f.pull_request,
            commit_sha: f.commit_sha,
            commit_subject: f.commit_subject,
            committed_at: f.committed_at as f64,
            co_modified_files: f.co_modified_files,
            status: f.status.into(),
        }
    }
}

impl From<oxide_core::ReviewSizeBand> for ReviewSizeBand {
    fn from(b: oxide_core::ReviewSizeBand) -> Self {
        match b {
            oxide_core::ReviewSizeBand::Small => Self::Small,
            oxide_core::ReviewSizeBand::Medium => Self::Medium,
            oxide_core::ReviewSizeBand::Large => Self::Large,
        }
    }
}

impl From<oxide_core::ReviewWorkKind> for ReviewWorkKind {
    fn from(k: oxide_core::ReviewWorkKind) -> Self {
        Self {
            languages: k.languages,
            size_band: k.size_band.into(),
            issue_labels: k.issue_labels,
        }
    }
}

impl From<oxide_core::ReviewRoundGroup> for ReviewRoundGroup {
    fn from(g: oxide_core::ReviewRoundGroup) -> Self {
        Self {
            provider: g.provider,
            model: g.model,
            kind: g.kind.into(),
            sample_size: g.sample_size,
        }
    }
}

impl From<oxide_core::ReviewLedger> for ReviewLedger {
    fn from(l: oxide_core::ReviewLedger) -> Self {
        Self {
            median_secs: l.median_secs.map(|v| v as f64),
            count: l.count,
            entries: l.entries.into_iter().map(Into::into).collect(),
            rounds: l.rounds.into_iter().map(Into::into).collect(),
            reverts: l.reverts.into_iter().map(Into::into).collect(),
            follow_ups: l.follow_ups.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<oxide_core::RuleSuggestion> for RuleSuggestion {
    fn from(s: oxide_core::RuleSuggestion) -> Self {
        Self {
            id: s.id,
            project_id: s.project_id,
            comments: s.comments,
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

impl From<oxide_core::PullRequestComment> for PullRequestComment {
    fn from(c: oxide_core::PullRequestComment) -> Self {
        Self {
            author: c.author,
            body: c.body,
            created_at: c.created_at,
            review: c.review.map(Into::into),
        }
    }
}

impl From<oxide_core::ReviewThreadComment> for ReviewThreadComment {
    fn from(c: oxide_core::ReviewThreadComment) -> Self {
        Self {
            author: c.author,
            body: c.body,
            created_at: c.created_at,
        }
    }
}

impl From<oxide_core::PullRequestReviewThread> for PullRequestReviewThread {
    fn from(t: oxide_core::PullRequestReviewThread) -> Self {
        Self {
            id: t.id,
            path: t.path,
            line: t.line,
            original_line: t.original_line,
            side: t.side.map(Into::into),
            resolved: t.resolved,
            outdated: t.outdated,
            diff_hunk: t.diff_hunk,
            comments: t.comments.into_iter().map(Into::into).collect(),
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
            comments: d.comments.into_iter().map(Into::into).collect(),
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
        }
    }
}

impl From<oxide_core::IssueComment> for IssueComment {
    fn from(c: oxide_core::IssueComment) -> Self {
        Self {
            author: c.author,
            body: c.body,
            created_at: c.created_at,
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
            comments: d.comments.into_iter().map(Into::into).collect(),
            labels: d.labels.into_iter().map(Into::into).collect(),
            assignees: d.assignees,
            viewer: d.viewer,
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_and_provider_types_convert_wire_compatibly() {
        let core_settings = oxide_core::Settings {
            default_provider: oxide_core::Provider::Codex,
            providers: oxide_core::Providers {
                claude: oxide_core::ProviderSettings {
                    model: Some("claude-sonnet-4".into()),
                    effort: Some("high".into()),
                    permission_mode: oxide_core::PermissionMode::AutoEdit,
                },
                codex: oxide_core::ProviderSettings {
                    model: None,
                    effort: None,
                    permission_mode: oxide_core::PermissionMode::Ask,
                },
                antigravity: oxide_core::ProviderSettings {
                    model: Some("gemini-pro".into()),
                    effort: Some("medium".into()),
                    permission_mode: oxide_core::PermissionMode::FullAccess,
                },
            },
            confirm_quit: false,
            delete_merged_branches: true,
            claude_customizations: oxide_core::ClaudeCustomizations {
                claude_md: true,
                skills: false,
                plugins: true,
                mcp_servers: true,
                hooks: false,
            },
            shortcuts: oxide_core::Shortcuts::default(),
        };
        let core_state = oxide_core::SettingsState {
            settings: core_settings.clone(),
            errors: vec![oxide_core::FieldError {
                path: "providers.claude.model".into(),
                message: "invalid".into(),
            }],
        };

        let app_state = SettingsState::from(&core_state);
        let owned_app_state = SettingsState::from(core_state);
        assert_eq!(
            serde_json::to_value(&owned_app_state).unwrap(),
            serde_json::to_value(&app_state).unwrap()
        );
        let json = serde_json::to_value(&app_state).unwrap();
        assert_eq!(json["settings"]["defaultProvider"], json!("codex"));
        assert_eq!(
            json["settings"]["providers"]["claude"]["permissionMode"],
            json!("auto-edit")
        );
        assert_eq!(
            json["settings"]["providers"]["antigravity"]["permissionMode"],
            json!("full-access")
        );
        assert_eq!(json["settings"]["deleteMergedBranches"], json!(true));
        assert_eq!(
            json["settings"]["claudeCustomizations"],
            json!({
                "claudeMd": true,
                "skills": false,
                "plugins": true,
                "mcpServers": true,
                "hooks": false
            })
        );
        assert_eq!(
            json["errors"],
            json!([{ "path": "providers.claude.model", "message": "invalid" }])
        );

        let round_trip_core: oxide_core::Settings = app_state.settings.into();
        assert_eq!(round_trip_core, core_settings);

        let caps = ProviderCapabilities::from(oxide_core::ProviderCapabilities {
            supported_permission_modes: vec![
                oxide_core::PermissionMode::Ask,
                oxide_core::PermissionMode::AutoEdit,
            ],
            interactive_approvals: true,
            supports_reasoning: false,
            native_attachment_kinds: vec![
                oxide_core::AttachmentKind::Image,
                oxide_core::AttachmentKind::Pdf,
            ],
            mid_thread_model_switch: true,
            reports_usage_limits: true,
        });
        assert_eq!(
            serde_json::to_value(&caps).unwrap(),
            json!({
                "supportedPermissionModes": ["ask", "auto-edit"],
                "interactiveApprovals": true,
                "supportsReasoning": false,
                "nativeAttachmentKinds": ["image", "pdf"],
                "midThreadModelSwitch": true,
                "reportsUsageLimits": true
            })
        );

        let model = ModelInfo::from(oxide_core::ModelInfo {
            id: "m1".into(),
            name: "Model 1".into(),
            description: Some("desc".into()),
            supported_efforts: vec!["low".into(), "high".into()],
            default_effort: Some("high".into()),
            is_legacy: true,
        });
        assert_eq!(
            serde_json::to_value(&model).unwrap(),
            json!({
                "id": "m1",
                "name": "Model 1",
                "description": "desc",
                "supportedEfforts": ["low", "high"],
                "defaultEffort": "high",
                "isLegacy": true
            })
        );

        let det = Detection::from(oxide_core::Detection {
            available: true,
            installed: true,
            version: Some("1.2.3".into()),
            authenticated: false,
            warning: Some("warn".into()),
        });
        assert_eq!(
            serde_json::to_value(&det).unwrap(),
            json!({
                "available": true,
                "installed": true,
                "version": "1.2.3",
                "authenticated": false,
                "warning": "warn"
            })
        );
    }

    #[test]
    fn thread_turn_board_slash_and_usage_types_convert_wire_compatibly() {
        let attachment = oxide_core::Attachment {
            id: "att-1".into(),
            name: "shot.png".into(),
            kind: oxide_core::AttachmentKind::Image,
            media_type: "image/png".into(),
            size_bytes: 4096,
            path: std::path::PathBuf::from("/tmp/shot.png"),
        };
        let app_att = Attachment::from(attachment.clone());
        assert_eq!(
            serde_json::to_value(&app_att).unwrap(),
            json!({
                "id": "att-1",
                "name": "shot.png",
                "attachmentKind": "image",
                "mediaType": "image/png",
                "sizeBytes": 4096,
                "path": "/tmp/shot.png"
            })
        );

        let core_inputs: Vec<oxide_core::PromptInput> = vec![
            PromptInput::Text { text: "hi".into() }.into(),
            PromptInput::Attachment { id: "att-1".into() }.into(),
        ];
        assert_eq!(
            core_inputs,
            vec![
                oxide_core::PromptInput::Text { text: "hi".into() },
                oxide_core::PromptInput::Attachment { id: "att-1".into() },
            ]
        );

        let turn = oxide_core::TurnSnapshot {
            id: 10,
            turn_index: 1,
            prompt: "look".into(),
            model: Some("opus".into()),
            effort: Some("max".into()),
            permission_mode: Some(oxide_core::PermissionMode::FullAccess),
            segments: vec![
                oxide_core::PromptSegment::text("look"),
                oxide_core::PromptSegment::Attachment(attachment),
            ],
            status: oxide_core::TurnStatus::Completed,
            started_at: "t0".into(),
            completed_at: Some("t1".into()),
            items: vec![oxide_core::ItemSnapshot {
                id: 11,
                item_index: 0,
                kind: oxide_core::ItemKind::ToolCall,
                content: "ran".into(),
                parent_item_index: Some(0),
                category: Some(oxide_core::ActivityCategory::Run),
                command: oxide_core::CommandRecord {
                    line: Some("cargo test".into()),
                    outcome: oxide_core::CommandOutcome::Succeeded,
                    exit_code: Some(0),
                },
                created_at: "t0".into(),
            }],
            error: Some(oxide_core::TurnError {
                message: "boom".into(),
                stderr_tail: Some("tail".into()),
            }),
            approvals: vec![oxide_core::ApprovalSnapshot {
                id: 12,
                turn_id: 10,
                approval_id: "ap-1".into(),
                kind: oxide_core::ApprovalKind::FileChange,
                summary: "edit".into(),
                options: vec!["allow".into()],
                decision: Some(oxide_core::ApprovalDecision::Allow),
                created_at: "t0".into(),
                decided_at: Some("t1".into()),
            }],
            unknown_events: vec![oxide_core::UnknownEventSnapshot {
                id: 13,
                raw: "{}".into(),
                created_at: "t0".into(),
            }],
        };
        let page = TurnPage::from(oxide_core::TurnPage {
            offset: 0,
            turns: vec![turn],
            turn_count: 5,
        });
        let page_json = serde_json::to_value(&page).unwrap();
        assert_eq!(page_json["turnCount"], json!(5));
        assert_eq!(
            page_json["turns"][0]["unknownEvents"][0],
            json!({ "id": 13, "raw": "{}", "createdAt": "t0" })
        );
        assert_eq!(
            page_json["turns"][0]["segments"][1],
            json!({
                "kind": "attachment",
                "id": "att-1",
                "name": "shot.png",
                "attachmentKind": "image",
                "mediaType": "image/png",
                "sizeBytes": 4096,
                "path": "/tmp/shot.png"
            })
        );
        assert_eq!(
            page_json["turns"][0]["approvals"][0]["kind"],
            json!("file-change")
        );
        assert_eq!(
            page_json["turns"][0]["approvals"][0]["decision"],
            json!("allow")
        );

        let slash = SlashCommand::from(oxide_core::SlashCommandInfo {
            name: "review".into(),
            description: Some("Review".into()),
            argument_hint: Some("[pr]".into()),
            aliases: vec!["r".into()],
            route: oxide_core::SlashRoute::Native,
        });
        assert_eq!(
            serde_json::to_value(&slash).unwrap(),
            json!({
                "name": "review",
                "description": "Review",
                "argumentHint": "[pr]",
                "aliases": ["r"],
                "route": "native"
            })
        );

        let mut pools = std::collections::HashMap::new();
        pools.insert(
            "opus".into(),
            oxide_core::UsagePoolLimits {
                label: "Claude Opus".into(),
                five_hour: Some(oxide_core::UsageLimitWindow {
                    percent_used: Some(42.5),
                    resets_at: Some(1_700_000_000),
                    status: oxide_core::UsageStatus::Warning,
                    reported_at: 1_699_999_000,
                }),
                weekly: None,
            },
        );
        let usage = UsageLimits::from(oxide_core::UsageLimits {
            five_hour: None,
            weekly: None,
            pools,
        });
        let usage_json = serde_json::to_value(&usage).unwrap();
        assert_eq!(
            usage_json["pools"]["opus"]["fiveHour"],
            json!({
                "percentUsed": 42.5,
                "resetsAt": 1700000000.0,
                "status": "warning",
                "reportedAt": 1699999000.0
            })
        );

        let board_evt = BoardEvent::from(oxide_core::BoardEvent::ThreadDeleted(42));
        assert_eq!(
            serde_json::to_value(&board_evt).unwrap(),
            json!({ "type": "ThreadDeleted", "payload": 42 })
        );
    }

    #[test]
    fn services_git_diff_restore_ledger_and_github_types_convert_wire_compatibly() {
        let outcome = ProjectServiceStartOutcome::from(
            oxide_core::ProjectServiceStartOutcome::Started(oxide_core::ProjectService {
                id: 1,
                project_id: 2,
                thread_id: Some(3),
                command: "pnpm dev".into(),
                checkout: "/repo".into(),
                status: oxide_core::ProjectServiceStatus::Running,
                pid: 99,
                port: Some(3000),
                url: Some("http://localhost:3000".into()),
                started_at: "t0".into(),
                exit_code: None,
            }),
        );
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            json!({
                "outcome": "started",
                "payload": {
                    "id": 1,
                    "projectId": 2,
                    "threadId": 3,
                    "command": "pnpm dev",
                    "checkout": "/repo",
                    "status": "running",
                    "pid": 99,
                    "port": 3000,
                    "url": "http://localhost:3000",
                    "startedAt": "t0",
                    "exitCode": null
                }
            })
        );

        let core_scope: oxide_core::DiffScope = DiffScope::Uncommitted.into();
        assert_eq!(core_scope, oxide_core::DiffScope::Uncommitted);

        let diff = Diff::from(oxide_core::Diff {
            base: Some("main".into()),
            files: vec![oxide_core::DiffFile {
                path: "a.rs".into(),
                old_path: None,
                status: oxide_core::DiffStatus::Modified,
                added: 1,
                removed: 0,
                binary: false,
                hunks: vec![oxide_core::DiffHunk {
                    header: "@@ -1 +1 @@".into(),
                    lines: vec![oxide_core::DiffLine {
                        kind: oxide_core::DiffKind::Added,
                        text: "fn main() {}".into(),
                    }],
                }],
            }],
        });
        assert_eq!(
            serde_json::to_value(&diff).unwrap()["files"][0]["hunks"][0]["lines"][0],
            json!({ "kind": "added", "text": "fn main() {}" })
        );

        let ledger = ReviewLedger::from(oxide_core::ReviewLedger {
            median_secs: Some(120),
            count: 1,
            entries: vec![oxide_core::ReviewLedgerEntry {
                project_id: 1,
                thread_id: 2,
                pull_request: 10,
                provider: "claude".into(),
                model: Some("sonnet".into()),
                turn_completed_at: 1000,
                merged_at: 1120,
            }],
            rounds: vec![oxide_core::ReviewRoundGroup {
                provider: "claude".into(),
                model: None,
                kind: oxide_core::ReviewWorkKind {
                    languages: vec!["rust".into()],
                    size_band: oxide_core::ReviewSizeBand::Medium,
                    issue_labels: vec!["bug".into()],
                },
                sample_size: 3,
            }],
            reverts: vec![oxide_core::ReviewRevert {
                pull_request: 10,
                commit_sha: "abc".into(),
                commit_subject: "revert".into(),
                committed_at: 1200,
            }],
            follow_ups: vec![oxide_core::ReviewFollowUp {
                pull_request: 10,
                commit_sha: "def".into(),
                commit_subject: "fix".into(),
                committed_at: 1300,
                co_modified_files: vec!["src/lib.rs".into()],
                status: oxide_core::FollowUpStatus::Confirmed,
            }],
        });
        let ledger_json = serde_json::to_value(&ledger).unwrap();
        assert_eq!(ledger_json["medianSecs"], json!(120.0));
        assert_eq!(ledger_json["entries"][0]["turnCompletedAt"], json!(1000.0));
        assert_eq!(ledger_json["followUps"][0]["status"], json!("confirmed"));

        let pr_detail = PullRequestDetail::from(oxide_core::PullRequestDetail {
            pull_request: oxide_core::PullRequest {
                number: 7,
                title: "Fix".into(),
                url: "https://example.com".into(),
                draft: false,
                base: "main".into(),
                head: "fix".into(),
                author: "alice".into(),
                created_at: "t0".into(),
            },
            phase: oxide_core::PullRequestPhase::Open,
            body: "desc".into(),
            head_sha: "sha".into(),
            checks: vec![oxide_core::PullRequestCheck {
                name: "ci".into(),
                state: oxide_core::CheckState::Success,
                url: None,
                required: true,
            }],
            comments: vec![],
            merge_state: oxide_core::MergeState::Clean,
            review_decision: Some(oxide_core::ReviewDecision::Approved),
            reviewers: vec![oxide_core::PullRequestReviewer {
                login: "bob".into(),
                state: oxide_core::ReviewState::Approved,
            }],
            assignees: vec![],
            labels: vec![oxide_core::PullRequestLabel {
                name: "bug".into(),
                color: "ff0000".into(),
            }],
            additions: 10,
            deletions: 2,
            viewer: "alice".into(),
            merge_methods: vec![oxide_core::MergeMethod::Squash],
            default_merge_method: Some(oxide_core::MergeMethod::Squash),
            delete_branch_on_merge: true,
            changed_files: 3,
        });
        let pr_json = serde_json::to_value(&pr_detail).unwrap();
        assert_eq!(pr_json["changedFiles"], json!(3));
        assert_eq!(pr_json["reviewDecision"], json!("approved"));
        assert_eq!(pr_json["defaultMergeMethod"], json!("squash"));

        let core_close: oxide_core::IssueCloseReason = IssueCloseReason::NotPlanned.into();
        assert_eq!(core_close, oxide_core::IssueCloseReason::NotPlanned);

        let core_edit: oxide_core::IssueEdit = IssueEdit {
            title: Some("t".into()),
            body: None,
            add_assignees: vec!["a".into()],
            remove_assignees: vec![],
            add_labels: vec!["b".into()],
            remove_labels: vec![],
        }
        .into();
        assert_eq!(core_edit.title.as_deref(), Some("t"));
    }
}
