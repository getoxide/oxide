//! The App shell: a thin Tauri layer that exposes [`oxide_core::Core`] to the webview.
//! The webview talks only to the TypeScript bindings generated from here.

mod conversions;
mod shell_path;
mod system;
use oxide_core::diag;

use std::sync::Arc;

use oxide_core::{Core, ProjectSummary};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
use tauri_specta::{Builder, collect_commands};

#[derive(Debug, Serialize, Type)]
pub struct AppError {
    message: String,
}

impl From<oxide_core::Error> for AppError {
    fn from(e: oxide_core::Error) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Serialize, Type)]
pub struct Project {
    id: u32,
    name: String,
    path: String,
    hidden: bool,
    /// Listed in the sidebar; scanned Projects stay closed until the user opens one.
    open: bool,
    missing: bool,
}

impl From<ProjectSummary> for Project {
    fn from(p: ProjectSummary) -> Self {
        Self {
            id: p.id,
            name: p.name,
            path: p.path,
            hidden: p.hidden,
            open: p.open,
            missing: p.missing,
        }
    }
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn list_projects(core: State<'_, Arc<Core>>) -> Result<Vec<Project>, AppError> {
    Ok(core
        .list_projects()?
        .into_iter()
        .map(Project::from)
        .collect())
}

/// Scans the scan roots for new repositories, then lists all Projects.
/// The walk runs on a blocking thread, off the main thread and the async runtime.
#[tauri::command]
#[specta::specta]
async fn rescan_projects(core: State<'_, Arc<Core>>) -> Result<Vec<Project>, AppError> {
    let core = Arc::clone(&core);
    let projects = tauri::async_runtime::spawn_blocking(move || core.rescan_projects())
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })??;
    Ok(projects.into_iter().map(Project::from).collect())
}

/// Registers an existing folder as a Project.
#[tauri::command]
#[specta::specta]
async fn add_project(core: State<'_, Arc<Core>>, path: String) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.add_project(&path))
        .await
        .map(Project::from)
}

/// Creates `parent/name` with `git init` and registers it as a Project.
#[tauri::command]
#[specta::specta]
async fn create_project(
    core: State<'_, Arc<Core>>,
    parent: String,
    name: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.create_project(&parent, &name))
        .await
        .map(Project::from)
}

/// Clones a Git URL into `parent` and registers the clone as a Project.
#[tauri::command]
#[specta::specta]
async fn clone_project(
    core: State<'_, Arc<Core>>,
    url: String,
    parent: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.clone_project(&url, &parent))
        .await
        .map(Project::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    name_with_owner: String,
    description: String,
    is_private: bool,
}

#[tauri::command]
#[specta::specta]
async fn search_github_repositories(
    core: State<'_, Arc<Core>>,
    query: String,
) -> Result<Vec<GithubRepository>, AppError> {
    git_blocking(&core, move |core| core.search_github_repositories(&query))
        .await
        .map(|list| list.into_iter().map(GithubRepository::from).collect())
}

/// Clones one of the user's GitHub repositories into `parent` and registers it as a Project.
#[tauri::command]
#[specta::specta]
async fn clone_github_repository(
    core: State<'_, Arc<Core>>,
    name_with_owner: String,
    parent: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| {
        core.clone_github_repository(&name_with_owner, &parent)
    })
    .await
    .map(Project::from)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn reveal_in_finder(core: State<'_, Arc<Core>>, project_id: u32) -> Result<(), AppError> {
    Ok(core.reveal_in_finder(project_id)?)
}

/// Lists the Project in the sidebar, or takes it out (it stays in the Project palette).
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn set_project_open(core: State<'_, Arc<Core>>, id: u32, open: bool) -> Result<(), AppError> {
    Ok(core.set_project_open(id, open)?)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestPhase {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    Default,
    Zsh,
    Bash,
    #[serde(rename = "powershell")]
    PowerShell,
    Pwsh,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableShell {
    pub kind: ShellKind,
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub shell: ShellKind,
    pub load_user_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
    /// The shell it runs, as the Terminal header names it: `zsh`, `bash` or `PowerShell`.
    pub shell: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCompletion {
    pub replacement_index: u32,
    pub replacement_length: u32,
    pub matches: Vec<TerminalMatch>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMatch {
    pub text: String,
    pub label: String,
    pub detail: String,
}
#[tauri::command]
#[specta::specta]
async fn complete_terminal(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    line: String,
    cursor: u32,
) -> Result<TerminalCompletion, AppError> {
    let core = Arc::clone(core.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let result = core.complete_terminal(terminal_id, &line, cursor as usize)?;
        Ok(TerminalCompletion {
            replacement_index: result.replacement_index as u32,
            replacement_length: result.replacement_length as u32,
            matches: result
                .matches
                .into_iter()
                .map(|item| TerminalMatch {
                    text: item.text,
                    label: item.label,
                    detail: item.detail,
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| AppError {
        message: error.to_string(),
    })?
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn available_shells(core: State<'_, Arc<Core>>) -> Vec<AvailableShell> {
    core.available_shells()
        .into_iter()
        .map(Into::into)
        .collect()
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn terminal_settings(core: State<'_, Arc<Core>>) -> Result<TerminalSettings, AppError> {
    Ok(core.terminal_settings()?.into())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn set_terminal_settings(
    core: State<'_, Arc<Core>>,
    settings: TerminalSettings,
) -> Result<TerminalSettings, AppError> {
    Ok(core.set_terminal_settings(settings.into())?.into())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn start_block_terminal(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    on_output: tauri::ipc::Channel<Vec<u8>>,
) -> Result<Terminal, AppError> {
    let terminal = core.start_block_terminal(project_id)?;
    let rx = core.subscribe_terminal(terminal.id)?;
    std::thread::spawn(move || {
        while let Ok(chunk) = rx.recv() {
            if on_output.send(chunk).is_err() {
                break;
            }
        }
    });
    Ok(terminal.into())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn write_terminal(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    input: Vec<u8>,
) -> Result<(), AppError> {
    Ok(core.write_terminal(terminal_id, &input)?)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn resize_terminal(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    Ok(core.resize_terminal(terminal_id, rows, cols)?)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn close_terminal(core: State<'_, Arc<Core>>, terminal_id: u32) -> Result<(), AppError> {
    Ok(core.close_terminal(terminal_id)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    /// Saturates at 4 GiB.
    pub size: u32,
    pub truncated: bool,
    pub binary: bool,
}

/// Lists one directory of a Project (`""` is the root), minus
/// `.git` and gitignored entries.
#[tauri::command]
#[specta::specta]
async fn list_dir(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.list_dir(project_id, &path))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map(|entries| entries.into_iter().map(FileEntry::from).collect())
        .map_err(AppError::from)
}

/// Reads a file of a Project, capped at 1 MiB.
#[tauri::command]
#[specta::specta]
async fn read_file(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    path: String,
) -> Result<FileContent, AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.read_file(project_id, &path))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map(|file| FileContent {
            size: u32::try_from(file.size).unwrap_or(u32::MAX),
            content: file.content,
            truncated: file.truncated,
            binary: file.binary,
        })
        .map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
async fn write_file(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    path: String,
    expected: String,
    content: String,
) -> Result<(), AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || {
        core.write_file(project_id, &path, &expected, &content)
    })
    .await
    .map_err(|e| AppError {
        message: e.to_string(),
    })?
    .map_err(AppError::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfig {
    command: String,
    args: Vec<String>,
    interpreter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTool {
    language: String,
    name: String,
    config: LanguageServerConfig,
    installed: bool,
    resolved_path: Option<String>,
    install_command: String,
    documentation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServer {
    id: u32,
    root: String,
    language: String,
    initialization_options: String,
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn language_tools(core: State<'_, Arc<Core>>) -> Vec<LanguageTool> {
    core.language_tools()
        .into_iter()
        .map(LanguageTool::from)
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperTool {
    id: String,
    name: String,
    installed: bool,
    path: Option<String>,
    can_install: bool,
    documentation: String,
}

/// Enumerates installed system font family names on a blocking thread.
///
/// Starts an OS font-enumeration process (`atsutil` on macOS, `fc-list` on Linux;
/// DirectWrite via Win32 on Windows) through `oxide-platform`.
#[tauri::command]
#[specta::specta]
async fn system_fonts() -> Result<Vec<String>, AppError> {
    tauri::async_runtime::spawn_blocking(oxide_core::system_fonts)
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })
}

#[tauri::command]
#[specta::specta]
async fn developer_tools() -> Result<Vec<DeveloperTool>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        oxide_core::desktop_tools::developer_tools()
            .into_iter()
            .map(DeveloperTool::from)
            .collect()
    })
    .await
    .map_err(|e| AppError {
        message: e.to_string(),
    })
}

#[tauri::command]
#[specta::specta]
async fn install_developer_tool(tool: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        oxide_core::desktop_tools::install_developer_tool(&tool)
    })
    .await
    .map_err(|e| AppError {
        message: e.to_string(),
    })?
    .map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
async fn install_language_support(
    core: State<'_, Arc<Core>>,
    language: String,
    on_progress: tauri::ipc::Channel<String>,
) -> Result<LanguageTool, AppError> {
    let core = Arc::clone(&core);
    let tool = tauri::async_runtime::spawn_blocking(move || {
        core.install_language_support(&language, |message| {
            diag::best_effort("progress", on_progress.send(message.to_owned()));
        })
    })
    .await
    .map_err(|e| AppError {
        message: e.to_string(),
    })??;
    Ok(tool.into())
}

#[tauri::command]
#[specta::specta]
async fn create_file(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    path: String,
) -> Result<(), AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.create_file(project_id, &path))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map_err(AppError::from)
}
#[tauri::command]
#[specta::specta]
async fn find_files(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    query: String,
) -> Result<Vec<String>, AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.find_files(project_id, &query))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map_err(AppError::from)
}
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn set_editor_dirty(core: State<'_, Arc<Core>>, id: String, dirty: bool) {
    core.set_editor_dirty(id, dirty);
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn run_terminal_block(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    command: String,
    token: String,
) -> Result<(), AppError> {
    core.run_terminal_block(terminal_id, &command, &token)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
async fn start_language_server(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    language: String,
    on_message: tauri::ipc::Channel<String>,
) -> Result<LanguageServer, AppError> {
    let core = Arc::clone(&core);
    let (summary, rx) = tauri::async_runtime::spawn_blocking(move || {
        core.start_language_server(project_id, &language)
    })
    .await
    .map_err(|e| AppError {
        message: e.to_string(),
    })??;
    std::thread::spawn(move || {
        while let Ok(message) = rx.recv() {
            if on_message.send(message).is_err() {
                break;
            }
        }
    });
    Ok(summary.into())
}
#[tauri::command]
#[specta::specta]
async fn language_server_message(
    core: State<'_, Arc<Core>>,
    id: u32,
    message: String,
) -> Result<(), AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.language_server_message(id, &message))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map_err(AppError::from)
}
#[tauri::command]
#[specta::specta]
async fn stop_language_server(core: State<'_, Arc<Core>>, id: u32) -> Result<(), AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.stop_language_server(id))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GithubAvailability {
    Ready,
    Missing,
    LoggedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub draft: bool,
    pub base: String,
    pub head: String,
    pub cross_repository: bool,
    pub author: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Neutral,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub state: CheckState,
    /// Where GitHub shows the run, to find out why it failed.
    pub url: Option<String>,
    /// Whether branch protection requires it: only these hold the merge up.
    pub required: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeState {
    Clean,
    Conflicting,
    Behind,
    Blocked,
    Unstable,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewer {
    pub login: String,
    pub state: ReviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    /// Set on a plain comment, which can be edited or deleted; reviews have none.
    pub id: Option<String>,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Set when the entry is a review rather than a plain comment.
    pub review: Option<ReviewState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCandidates {
    pub users: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestEdit {
    pub add_reviewers: Vec<String>,
    pub remove_reviewers: Vec<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub pull_request: PullRequest,
    pub phase: PullRequestPhase,
    pub body: String,
    /// The commit the pull request's head points at.
    pub head_sha: String,
    pub checks: Vec<PullRequestCheck>,
    pub comments: Vec<PullRequestComment>,
    pub merge_state: MergeState,
    pub review_decision: Option<ReviewDecision>,
    pub reviewers: Vec<PullRequestReviewer>,
    pub assignees: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
    pub additions: u32,
    pub deletions: u32,
    /// The signed-in GitHub user.
    pub viewer: String,
    /// The merge methods the repository allows.
    pub merge_methods: Vec<MergeMethod>,
    /// The method GitHub's own merge box would preselect for the user.
    pub default_merge_method: Option<MergeMethod>,
    /// Whether the repository deletes merged branches on its own.
    pub delete_branch_on_merge: bool,
    /// The number of changed files.
    pub changed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub comments_count: u32,
    pub created_at: String,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub comments: Vec<IssueComment>,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
    pub viewer: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IssueCloseReason {
    Completed,
    NotPlanned,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplateFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssuesState {
    pub availability: GithubAvailability,
    pub guidance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDraft {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
    /// How many commits `head` has beyond `base`; null when that cannot be told locally.
    pub commits_beyond: Option<u32>,
    /// Whether `head` is a main branch, which a pull request cannot be opened from.
    pub protected: bool,
}

/// What the author chose for a new pull request.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequest {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
}

/// The repository's branches on GitHub, for choosing a pull request's base.
#[tauri::command]
#[specta::specta]
async fn pull_request_base_branches(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Vec<String>, AppError> {
    git_blocking(&core, move |core| {
        core.pull_request_base_branches(project_id)
    })
    .await
}

/// Title, body and base prefilled from the branch's commits.
#[tauri::command]
#[specta::specta]
async fn pull_request_draft(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<PullRequestDraft, AppError> {
    git_blocking(&core, move |core| core.pull_request_draft(project_id))
        .await
        .map(PullRequestDraft::from)
}

/// How many commits the checked-out branch has beyond `base`, from local Git only; null when
/// `base` is unknown locally. Core validates `base` as a branch name. Starts `git`.
#[tauri::command]
#[specta::specta]
async fn pull_request_commits_beyond(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    base: String,
) -> Result<Option<u32>, AppError> {
    git_blocking(&core, move |core| {
        core.pull_request_commits_beyond(project_id, &base)
    })
    .await
}

/// Pushes the branch if needed, then opens a pull request for it.
#[tauri::command]
#[specta::specta]
async fn create_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    pull_request: NewPullRequest,
) -> Result<PullRequest, AppError> {
    git_blocking(&core, move |core| {
        core.create_pull_request(
            project_id,
            &oxide_core::PullRequestInput {
                title: pull_request.title,
                body: pull_request.body,
                base: pull_request.base,
                draft: pull_request.draft,
            },
        )
    })
    .await
    .map(PullRequest::from)
}

/// Availability of GitHub CLI for issues, and guidance if missing/logged out.
#[tauri::command]
#[specta::specta]
async fn issues_state(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<IssuesState, AppError> {
    git_blocking(&core, move |core| core.issues_state(project_id))
        .await
        .map(IssuesState::from)
}

/// The repository's issue templates (`.github/ISSUE_TEMPLATE`) as raw files; empty when it has none.
#[tauri::command]
#[specta::specta]
async fn issue_templates(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Vec<IssueTemplateFile>, AppError> {
    git_blocking(&core, move |core| core.issue_templates(project_id))
        .await
        .map(|files| files.into_iter().map(IssueTemplateFile::from).collect())
}

#[tauri::command]
#[specta::specta]
async fn list_issues(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    closed: bool,
    mine: bool,
    search: String,
) -> Result<Vec<IssueSummary>, AppError> {
    git_blocking(&core, move |core| {
        core.list_issues(project_id, closed, mine, &search)
    })
    .await
    .map(|list| list.into_iter().map(IssueSummary::from).collect())
}

#[tauri::command]
#[specta::specta]
async fn issue_detail(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<IssueDetail, AppError> {
    git_blocking(&core, move |core| core.issue_detail(project_id, number))
        .await
        .map(IssueDetail::from)
}

#[tauri::command]
#[specta::specta]
async fn create_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    title: String,
    body: String,
    assignees: Vec<String>,
    labels: Vec<String>,
) -> Result<IssueSummary, AppError> {
    git_blocking(&core, move |core| {
        core.create_issue(project_id, &title, &body, &assignees, &labels)
    })
    .await
    .map(IssueSummary::from)
}

/// Rewrites a comment of a pull request or an issue.
#[tauri::command]
#[specta::specta]
async fn edit_comment(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    id: String,
    body: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.edit_comment(project_id, &id, &body)).await
}

/// Deletes a comment of a pull request or an issue.
#[tauri::command]
#[specta::specta]
async fn delete_comment(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    id: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.delete_comment(project_id, &id)).await
}

#[tauri::command]
#[specta::specta]
async fn comment_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    body: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.comment_issue(project_id, number, &body)
    })
    .await
}

/// Closes an issue with a reason, leaving `comment` first when it is not empty.
#[tauri::command]
#[specta::specta]
async fn close_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    reason: IssueCloseReason,
    comment: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.close_issue(project_id, number, reason.into(), &comment)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn reopen_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.reopen_issue(project_id, number)).await
}

/// Changes an issue's title, description, assignees and labels.
#[tauri::command]
#[specta::specta]
async fn edit_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    edit: IssueEdit,
) -> Result<(), AppError> {
    let edit: oxide_core::IssueEdit = edit.into();
    git_blocking(&core, move |core| {
        core.edit_issue(project_id, number, &edit)
    })
    .await
}

/// Open pull requests; `mine` keeps the user's own, `search` is a GitHub query.
#[tauri::command]
#[specta::specta]
async fn list_pull_requests(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    mine: bool,
    search: String,
) -> Result<Vec<PullRequest>, AppError> {
    git_blocking(&core, move |core| {
        core.list_pull_requests(project_id, mine, &search)
    })
    .await
    .map(|prs| prs.into_iter().map(PullRequest::from).collect())
}

/// One pull request's description, checks, conversation and changed files.
#[tauri::command]
#[specta::specta]
async fn pull_request_detail(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<PullRequestDetail, AppError> {
    git_blocking(&core, move |core| {
        core.pull_request_detail(project_id, number)
    })
    .await
    .map(PullRequestDetail::from)
}

#[tauri::command]
#[specta::specta]
async fn comment_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    body: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.comment_pull_request(project_id, number, &body)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn merge_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    method: MergeMethod,
    delete_branch: bool,
    auto: bool,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.merge_pull_request(project_id, number, method.into(), delete_branch, auto)
    })
    .await
}

/// Closes a pull request without merging it.
#[tauri::command]
#[specta::specta]
async fn close_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.close_pull_request(project_id, number)
    })
    .await
}

/// Opens a GitHub link, such as a check's run, in the system browser. A well-formed link
/// outside GitHub and the fixed documentation is not opened: the answer is `Some(host)` (with
/// the port, if any) for the webview to confirm with the user, then `open_confirmed_link`.
/// `None` means the link was opened.
#[tauri::command]
#[specta::specta]
async fn open_link(core: State<'_, Arc<Core>>, url: String) -> Result<Option<String>, AppError> {
    git_blocking(&core, move |core| match core.open_link(&url) {
        Ok(()) => Ok(None),
        Err(oxide_core::Error::UnlistedLinkHost { host }) => Ok(Some(host)),
        Err(error) => Err(error),
    })
    .await
}

/// Opens a link whose host the user confirmed after `open_link` refused it as unlisted.
#[tauri::command]
#[specta::specta]
async fn open_confirmed_link(core: State<'_, Arc<Core>>, url: String) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.open_confirmed_link(&url)).await
}

/// Moves a pull request out of draft (`draft` false), or back into it.
#[tauri::command]
#[specta::specta]
async fn set_pull_request_draft(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    draft: bool,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.set_pull_request_draft(project_id, number, draft)
    })
    .await
}

/// Brings a pull request's branch up to date with its base.
#[tauri::command]
#[specta::specta]
async fn update_pull_request_branch(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.update_pull_request_branch(project_id, number)
    })
    .await
}

/// The people and labels a pull request's settings can pick from.
#[tauri::command]
#[specta::specta]
async fn pull_request_candidates(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<PullRequestCandidates, AppError> {
    git_blocking(&core, move |core| core.pull_request_candidates(project_id))
        .await
        .map(PullRequestCandidates::from)
}

/// Changes a pull request's reviewers, assignees and labels.
#[tauri::command]
#[specta::specta]
async fn edit_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    edit: PullRequestEdit,
) -> Result<(), AppError> {
    let edit: oxide_core::PullRequestEdit = edit.into();
    git_blocking(&core, move |core| {
        core.edit_pull_request(project_id, number, &edit)
    })
    .await
}

const MAIN_WINDOW: &str = "main";

/// Runs blocking Git work off the async runtime.
async fn git_blocking<T: Send + 'static>(
    core: &State<'_, Arc<Core>>,
    f: impl FnOnce(&Core) -> oxide_core::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    let core = Arc::clone(core);
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map_err(AppError::from)
}

/// The Project to reopen on launch.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn last_selection(core: State<'_, Arc<Core>>) -> Result<Option<u32>, AppError> {
    Ok(core.last_selection()?)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn remember_selection(core: State<'_, Arc<Core>>, project_id: u32) -> Result<(), AppError> {
    Ok(core.remember_selection(project_id)?)
}

/// The user confirmed quitting with unsaved editors (saved or discarded): exit.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)]
fn confirm_quit(app: tauri::AppHandle) -> Result<(), AppError> {
    app.exit(0);
    Ok(())
}

/// Brings the window back from hidden (Dock icon, ⌘N) and focuses it.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        diag::best_effort("show", window.show());
        diag::best_effort("unminimize", window.unminimize());
        diag::best_effort("set_focus", window.set_focus());
    }
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    Menu::with_items(
        app,
        &[
            &Submenu::with_id_and_items(
                app,
                "oxide",
                "Oxide",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                "edit",
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                "window",
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        list_projects,
        rescan_projects,
        add_project,
        create_project,
        clone_project,
        search_github_repositories,
        clone_github_repository,
        reveal_in_finder,
        set_project_open,
        start_block_terminal,
        available_shells,
        terminal_settings,
        set_terminal_settings,
        write_terminal,
        resize_terminal,
        close_terminal,
        complete_terminal,
        run_terminal_block,
        list_dir,
        read_file,
        write_file,
        language_tools,
        developer_tools,
        system_fonts,
        install_developer_tool,
        install_language_support,
        create_file,
        find_files,
        set_editor_dirty,
        start_language_server,
        language_server_message,
        stop_language_server,
        pull_request_base_branches,
        pull_request_draft,
        pull_request_commits_beyond,
        create_pull_request,
        list_pull_requests,
        pull_request_detail,
        comment_pull_request,
        edit_comment,
        delete_comment,
        merge_pull_request,
        close_pull_request,
        open_link,
        open_confirmed_link,
        set_pull_request_draft,
        update_pull_request_branch,
        pull_request_candidates,
        edit_pull_request,
        issues_state,
        issue_templates,
        list_issues,
        issue_detail,
        create_issue,
        comment_issue,
        close_issue,
        reopen_issue,
        edit_issue,
        last_selection,
        remember_selection,
        confirm_quit
    ])
}

/// Path of the generated TypeScript bindings, anchored to this crate.
pub const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/bindings.ts");

pub fn export_bindings() -> Result<(), String> {
    builder()
        .export(
            specta_typescript::Typescript::default().header("// @ts-nocheck\n/* eslint-disable */"),
            BINDINGS_PATH,
        )
        .map_err(|e| format!("failed to export TypeScript bindings: {e}"))
}

pub fn run() {
    // Before anything spawns a thread or a shell: a Dock launch has a bare PATH.
    if cfg!(target_os = "macos") {
        shell_path::inherit_login_shell_path();
    }

    let builder = builder();

    #[cfg(debug_assertions)]
    if let Err(error) = export_bindings() {
        eprintln!("{error}");
    }

    let built = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .menu(build_menu)
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle();
            match main_window_close_action(cfg!(target_os = "macos")) {
                // macOS keeps running when the window closes because the Dock icon can reopen it.
                CloseAction::Hide => {
                    api.prevent_close();
                    diag::best_effort("hide", window.hide());
                }
                // Windows and Linux have no Dock or tray icon, so closing the main window quits Oxide.
                CloseAction::Quit => {
                    if let Some(prompt) = app
                        .try_state::<Arc<Core>>()
                        .and_then(|core| quit_prompt_for_core(&core))
                    {
                        api.prevent_close();
                        emit_quit_prompt(app, prompt);
                    }
                }
            }
        })
        .setup(|app| {
            // Only the dev config names the app "Oxide Dev": a release never takes this path.
            if cfg!(debug_assertions) && app.config().product_name.as_deref() == Some("Oxide Dev") {
                oxide_platform::system::set_dev_dock_icon(include_bytes!("../icons-dev/icon.png"));
            }

            let home = app
                .path()
                .home_dir()
                .map_err(|e| format!("no home directory: {e}"))?
                .join(".oxide");
            let core = Core::open(home)?;
            core.set_system(Arc::new(system::HostSystem::new(app.handle().clone())));
            if cfg!(windows)
                && let Some(window) = app.get_webview_window(MAIN_WINDOW)
            {
                window.hide_menu()?;
                window.set_decorations(false)?;
            }
            app.manage(Arc::new(core));
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            eprintln!("error while building Oxide: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        // The Dock icon was clicked while the window was hidden.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app),
        // ⌘Q / close-before-destroy: ask first when dirty editors or running Terminals exist,
        // but never prevent exit after the main window has already been destroyed.
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            if !should_prompt_on_exit_request(app.get_webview_window(MAIN_WINDOW).is_some()) {
                return;
            }
            let core = app.state::<Arc<Core>>();
            if let Some(prompt) = quit_prompt_for_core(&core) {
                api.prevent_exit();
                emit_quit_prompt(app, prompt);
            }
        }
        // Managed state is not dropped on exit: stop every shell by hand.
        tauri::RunEvent::Exit => app.state::<Arc<Core>>().quit(),
        _ => {}
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    Hide,
    Quit,
}

const fn main_window_close_action(is_macos: bool) -> CloseAction {
    if is_macos {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

const fn should_prompt_on_exit_request(has_main_window: bool) -> bool {
    has_main_window
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuitPrompt {
    DirtyEditors(u32),
}

fn quit_prompt_for_core(core: &Core) -> Option<QuitPrompt> {
    let dirty = core.dirty_editor_count();
    (dirty > 0).then_some(QuitPrompt::DirtyEditors(dirty))
}

fn emit_quit_prompt(app: &tauri::AppHandle, prompt: QuitPrompt) {
    show_main_window(app);
    match prompt {
        QuitPrompt::DirtyEditors(count) => {
            diag::best_effort("emit", app.emit("editor-quit-requested", count));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_main_window_hides_only_on_macos() {
        assert_eq!(main_window_close_action(true), CloseAction::Hide);
        assert_eq!(main_window_close_action(false), CloseAction::Quit);
    }

    #[test]
    fn exit_request_only_prompts_while_main_window_exists() {
        assert!(should_prompt_on_exit_request(true));
        assert!(!should_prompt_on_exit_request(false));
    }

    #[test]
    fn quit_prompt_prioritizes_dirty_editors_over_idle_core() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(quit_prompt_for_core(&core), None);

        core.set_editor_dirty("tab-1".into(), true);
        assert_eq!(
            quit_prompt_for_core(&core),
            Some(QuitPrompt::DirtyEditors(1))
        );
        core.quit();
    }
}
