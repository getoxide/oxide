//! Oxide Core: all application logic, with no dependency on Tauri.
//! The App shell exposes [`Core`] to the webview; tests drive it headless.

mod clock;
mod db;
pub mod desktop_tools;
mod discovery;
mod error;
mod files;
mod git;
mod git_command;
mod github;
mod language_install;
mod language_pins;
mod language_server;
mod private;
mod project_setup;
mod redact;
mod system;
mod terminal;
mod terminal_completion;
/// `best_effort` and `SenderExt::tell`: the only way to discard a Result on purpose.
pub use oxide_platform::diag;
/// Poison-recovering lock acquisition: the only way to take a `Mutex` or `RwLock` (see `clippy.toml`).
pub use oxide_platform::sync::{LockExt, RwLockExt};
pub use terminal_completion::{TerminalCompletion, TerminalMatch};

pub use clock::{Clock, ManualClock, SystemClock};
pub use db::MIGRATIONS;
pub use error::{Error, Result};
pub use files::{FileContent, FileEntry};
pub use git::FETCH_INTERVAL;
pub use github::{
    CheckState, GithubAvailability, GithubRepository, IssueCloseReason, IssueComment, IssueDetail,
    IssueEdit, IssueSummary, IssueTemplateFile, IssuesState, MergeMethod, MergeState, PullRequest,
    PullRequestCandidates, PullRequestCheck, PullRequestComment, PullRequestDetail,
    PullRequestDraft, PullRequestEdit, PullRequestInput, PullRequestLabel, PullRequestPhase,
    PullRequestReviewer, ReviewDecision, ReviewState,
};
pub use language_server::{LanguageServerConfig, LanguageServerSummary, LanguageTool};
pub use system::System;
pub use terminal::TerminalSummary;

use oxide_platform::registry::ProcessRegistry;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use system::NoSystem;
use terminal::{TerminalSession, next_id};

const DB_FILE: &str = "oxide.db";
const PROCESSES_FILE: &str = "processes.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectSummary {
    pub id: u32,
    pub name: String,
    pub path: String,
    /// Left out of the sidebar and the Project palette; stays hidden across rescans.
    pub hidden: bool,
    /// Opened by the user, so listed in the sidebar. Scanned Projects start closed.
    pub open: bool,
    /// The folder no longer exists; the record and its data are kept.
    pub missing: bool,
}

type ProjectRow = (u32, String, String, bool, bool);

fn parse_project_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn build_project_summary((id, name, path, hidden, open): ProjectRow) -> ProjectSummary {
    ProjectSummary {
        id,
        name,
        missing: !Path::new(&path).exists(),
        path,
        hidden,
        open,
    }
}

pub struct Core {
    home: PathBuf,
    user_home: PathBuf,
    db: Mutex<Connection>,
    processes: Arc<ProcessRegistry>,
    terminals: Mutex<HashMap<u32, Arc<TerminalSession>>>,
    next_terminal_id: AtomicU32,
    /// The Project each open terminal belongs to, to mark it acted upon on its first command
    /// and to end it with the Project.
    terminal_projects: Mutex<HashMap<u32, u32>>,
    /// Terminals whose Project has already been marked acted upon, so a keystroke does not
    /// write the database again.
    acted_terminals: Mutex<HashSet<u32>>,
    language_servers: language_server::LanguageServers,
    dirty_editors: Mutex<HashSet<String>>,
    git: git::GitState,
    gh: Arc<github::Gh>,
    system: Mutex<Arc<dyn System>>,
}

impl Core {
    /// Opens Oxide's home directory (creating it if needed) and its database.
    pub fn open(home: impl Into<PathBuf>) -> Result<Self> {
        Self::open_home(home, None)
    }

    /// Like [`Core::open`], with project discovery and `~` paths relative to `user_home`
    /// instead of `$HOME`.
    pub fn open_with_user_home(
        home: impl Into<PathBuf>,
        user_home: impl Into<PathBuf>,
    ) -> Result<Self> {
        let mut core = Self::open(home)?;
        core.user_home = user_home.into();
        Ok(core)
    }

    pub fn open_with_migrations(home: impl Into<PathBuf>, migrations: &[&str]) -> Result<Self> {
        Self::open_home(home, Some(migrations))
    }

    /// `migrations` is `None` for the app's own schema, which also adopts databases written by
    /// older versions.
    fn open_home(home: impl Into<PathBuf>, migrations: Option<&[&str]>) -> Result<Self> {
        let home = home.into();
        private::prepare_home(&home).map_err(|source| Error::Io {
            path: home.clone(),
            source,
        })?;
        git_command::set_home(&home);
        let db_path = home.join(DB_FILE);
        let db = match migrations {
            Some(migrations) => db::open(&db_path, migrations)?,
            None => db::open_app(&db_path)?,
        };
        // A crashed run leaves its shell groups behind.
        let processes = Arc::new(ProcessRegistry::open(home.join(PROCESSES_FILE)));
        processes.reap_stale();
        // The pieces above created their own files (database sidecars, the process list):
        // make sure none of them is looser than the rest of the home.
        private::prepare_home(&home).map_err(|source| Error::Io {
            path: home.clone(),
            source,
        })?;
        Ok(Self {
            home,
            user_home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_default(),
            db: Mutex::new(db),
            processes,
            terminals: Mutex::new(HashMap::new()),
            next_terminal_id: AtomicU32::new(1),
            terminal_projects: Mutex::new(HashMap::new()),
            acted_terminals: Mutex::new(HashSet::new()),
            language_servers: language_server::LanguageServers::default(),
            dirty_editors: Mutex::new(HashSet::new()),
            git: git::GitState::default(),
            gh: Arc::new(github::Gh::default()),
            system: Mutex::new(Arc::new(NoSystem)),
        })
    }

    /// Ends every shell and language server, escalating SIGTERM to SIGKILL, and returns once
    /// their processes are gone. Safe to call more than once; also runs when Core is dropped.
    pub fn shutdown(&self) {
        self.language_servers.shutdown();
        let terminals: Vec<_> = self
            .terminals
            .lock_recover()
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in terminals {
            session.close();
        }
        self.terminal_projects.lock_recover().clear();
    }

    /// Installs the operating-system side of Core: opening links and revealing folders.
    pub fn set_system(&self, system: Arc<dyn System>) {
        *self.system.lock_recover() = system;
    }

    fn system(&self) -> Arc<dyn System> {
        Arc::clone(&self.system.lock_recover())
    }

    /// Ends every shell, then returns.
    pub fn quit(&self) {
        self.shutdown();
    }

    /// Remembers the Project the user is looking at, to reopen on next launch.
    /// Opening a Project this way also lists it in the sidebar.
    pub fn remember_selection(&self, project_id: u32) -> Result<()> {
        self.set_project_open(project_id, true)?;
        let db = self.db.lock_recover();
        db.execute(
            "INSERT INTO app_state (key, value) VALUES ('selection', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [serde_json::to_string(&(project_id, None::<u32>)).unwrap_or_default()],
        )?;
        Ok(())
    }

    /// The Project last remembered, if it still exists. The stored value may carry a Thread id
    /// from an older Oxide; it is ignored.
    pub fn last_selection(&self) -> Result<Option<u32>> {
        let db = self.db.lock_recover();
        let stored: Option<String> = db
            .query_row(
                "SELECT value FROM app_state WHERE key = 'selection'",
                [],
                |r| r.get(0),
            )
            .ok();
        let Some((project_id, _)) =
            stored.and_then(|v| serde_json::from_str::<(u32, Option<u32>)>(&v).ok())
        else {
            return Ok(None);
        };
        let project_exists: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        Ok(project_exists.then_some(project_id))
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Shows the Project's folder in Finder.
    pub fn reveal_in_finder(&self, project_id: u32) -> Result<()> {
        let path = self.checkout_path(project_id)?;
        self.system().reveal_in_finder(Path::new(&path));
        Ok(())
    }

    /// Lists the Project in the sidebar, or takes it out and ends its terminals; it stays known
    /// either way, so the Project palette still finds it. Opening keeps the time it was first
    /// opened.
    pub fn set_project_open(&self, id: u32, open: bool) -> Result<()> {
        {
            let db = self.db.lock_recover();
            if open {
                db.execute(
                    "UPDATE projects SET hidden = 0,
                         opened_at = COALESCE(opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                     WHERE id = ?1",
                    [id],
                )?;
            } else {
                db.execute("UPDATE projects SET opened_at = NULL WHERE id = ?1", [id])?;
            }
        }
        if !open {
            self.close_project_terminals(id);
        }
        Ok(())
    }

    fn close_project_terminals(&self, project_id: u32) {
        let ids: Vec<u32> = self
            .terminal_projects
            .lock_recover()
            .iter()
            .filter(|(_, project)| **project == project_id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            diag::best_effort("close project terminal", self.close_terminal(id));
        }
    }

    /// Starts a shell with Command blocks in the Project's folder. Core owns the PTY process
    /// until it is explicitly closed, its Project closes or Core shuts down.
    pub fn start_block_terminal(&self, project_id: u32) -> Result<TerminalSummary> {
        let cwd = self.checkout_path(project_id)?;
        let id = next_id(&self.next_terminal_id);
        let session = Arc::new(TerminalSession::start(
            id,
            &self.home,
            Path::new(&cwd),
            Arc::clone(&self.processes),
            true,
        )?);
        let summary = session.summary.clone();
        self.terminals.lock_recover().insert(id, session);
        self.terminal_projects.lock_recover().insert(id, project_id);
        Ok(summary)
    }

    /// Runs a command that changes the Project's files, serialized per checkout.
    pub fn checkout_path(&self, project_id: u32) -> Result<String> {
        let db = self.db.lock_recover();
        Ok(db.query_row(
            "SELECT path FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )?)
    }

    /// Every folder of an open Project.
    fn open_checkouts(&self) -> Result<Vec<PathBuf>> {
        let db = self.db.lock_recover();
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut projects = db.prepare("SELECT path FROM projects WHERE opened_at IS NOT NULL")?;
        for path in projects.query_map([], |r| r.get::<_, String>(0))? {
            paths.push(PathBuf::from(path?));
        }
        Ok(paths)
    }

    /// Title, body and base prefilled for a new pull request of the Project's current branch.
    pub fn pull_request_draft(&self, project_id: u32) -> Result<PullRequestDraft> {
        let cwd = self.main_checkout(project_id)?;
        github::pull_request_draft(&self.gh, &cwd)
    }

    /// Pushes the current branch of the Project's folder if needed, then opens a pull request
    /// for it.
    pub fn create_pull_request(
        &self,
        project_id: u32,
        input: &PullRequestInput,
    ) -> Result<PullRequest> {
        let cwd = self.main_checkout(project_id)?;
        self.git
            .mutate(&cwd, || github::create_pull_request(&self.gh, &cwd, input))
    }

    pub fn close_terminal(&self, terminal_id: u32) -> Result<()> {
        let session = self
            .terminals
            .lock_recover()
            .remove(&terminal_id)
            .ok_or_else(|| Error::Terminal(format!("unknown terminal {terminal_id}")))?;
        self.terminal_projects.lock_recover().remove(&terminal_id);
        self.acted_terminals.lock_recover().remove(&terminal_id);
        session.close();
        Ok(())
    }

    /// Merges a pull request with one of the methods its repository allows,
    /// optionally deleting the branch. With `auto`, GitHub merges it later,
    /// once the checks pass.
    pub fn merge_pull_request(
        &self,
        project_id: u32,
        number: u32,
        method: MergeMethod,
        delete_branch: bool,
        auto: bool,
    ) -> Result<()> {
        let cwd = self.main_checkout(project_id)?;
        self.git.mutate(&cwd, || {
            github::merge_pull_request(&self.gh, &cwd, number, method, delete_branch, auto)
        })
    }

    /// All Projects known to Oxide, hidden and missing ones included, most
    /// recently added first.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let rows: Vec<ProjectRow> = {
            let db = self.db.lock_recover();
            let mut stmt = db.prepare(
                "SELECT id, name, path, hidden, opened_at IS NOT NULL FROM projects ORDER BY id DESC",
            )?;
            let rows = stmt.query_map([], parse_project_row)?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        Ok(rows.into_iter().map(build_project_summary).collect())
    }

    /// Scans conventional folders in the user home for Git repositories, records new ones
    /// as Projects (keyed by canonical path) and returns all Projects.
    /// Existing records, hidden or missing, are left untouched.
    pub fn rescan_projects(&self) -> Result<Vec<ProjectSummary>> {
        let roots = discovery::default_roots(&self.user_home);
        let found = discovery::find_repositories(&roots);
        {
            let db = self.db.lock_recover();
            let tx = db::write_transaction(&db)?;
            for path in &found {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                tx.execute(
                    "INSERT OR IGNORE INTO projects (name, path) VALUES (?1, ?2)",
                    (name, path.to_string_lossy()),
                )?;
            }
            tx.commit()?;
        }
        self.list_projects()
    }

    /// Registers an existing folder as a Project and opens it (showing it again if it was hidden).
    /// Opening the same folder twice yields the same Project.
    pub fn add_project(&self, path: &str) -> Result<ProjectSummary> {
        let expanded = self.expand_home(path.trim());
        let canonical = expanded.canonicalize().map_err(|source| Error::Io {
            path: expanded.clone(),
            source,
        })?;
        if !canonical.is_dir() {
            return Err(Error::InvalidPath(format!(
                "{} is not a folder",
                canonical.display()
            )));
        }
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| canonical.to_string_lossy().into_owned());
        let path = canonical.to_string_lossy();
        let id = {
            let db = self.db.lock_recover();
            db.execute(
                "INSERT OR IGNORE INTO projects (name, path) VALUES (?1, ?2)",
                (&name, &path),
            )?;
            db.execute(
                "UPDATE projects SET hidden = 0,
                     opened_at = COALESCE(opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 WHERE path = ?1",
                [&path],
            )?;
            db.query_row("SELECT id FROM projects WHERE path = ?1", [&path], |r| {
                r.get::<_, u32>(0)
            })?
        };
        self.project(id)
    }

    /// Creates `parent/name` with `git init` and registers it as a Project.
    pub fn create_project(&self, parent: &str, name: &str) -> Result<ProjectSummary> {
        let dest = project_setup::create(&self.expand_home(parent.trim()), name)?;
        self.add_created_project(&dest)
    }

    /// Clones a Git URL into `parent/<repository name>` and registers it as a Project.
    pub fn clone_project(&self, url: &str, parent: &str) -> Result<ProjectSummary> {
        let dest = project_setup::clone_url(&self.expand_home(parent.trim()), url)?;
        self.add_created_project(&dest)
    }

    /// The user's GitHub repositories matching `query`, found through `gh`.
    pub fn search_github_repositories(&self, query: &str) -> Result<Vec<GithubRepository>> {
        github::search_repositories(&self.gh, &self.home, query)
    }

    /// Clones one of the user's GitHub repositories (`owner/name`) into `parent/name`
    /// through `gh` and registers it as a Project.
    pub fn clone_github_repository(
        &self,
        name_with_owner: &str,
        parent: &str,
    ) -> Result<ProjectSummary> {
        let dest =
            project_setup::github_clone_target(&self.expand_home(parent.trim()), name_with_owner)?;
        github::clone_repository(&self.gh, name_with_owner, &dest)?;
        self.add_created_project(&dest)
    }

    /// Registers a folder Oxide itself created or cloned: the user chose its content, so it
    /// counts as acted upon from the start.
    fn add_created_project(&self, dest: &Path) -> Result<ProjectSummary> {
        let project = self.add_project(&dest.to_string_lossy())?;
        self.mark_project_acted_upon(project.id)?;
        Ok(project)
    }

    /// Records that the user did something in the Project (a prompt, a terminal command, Pull or
    /// Push), which lets Oxide fetch its remote on its own from then on.
    pub fn mark_project_acted_upon(&self, project_id: u32) -> Result<()> {
        let db = self.db.lock_recover();
        db.execute(
            "UPDATE projects SET acted_upon = 1 WHERE id = ?1 AND acted_upon = 0",
            [project_id],
        )?;
        Ok(())
    }

    /// Whether the user has acted in the Project, so that automatic fetch is on.
    pub fn project_acted_upon(&self, project_id: u32) -> Result<bool> {
        let db = self.db.lock_recover();
        Ok(db.query_row(
            "SELECT acted_upon FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )?)
    }

    fn project(&self, id: u32) -> Result<ProjectSummary> {
        let row = {
            let db = self.db.lock_recover();
            db.query_row(
                "SELECT id, name, path, hidden, opened_at IS NOT NULL FROM projects WHERE id = ?1",
                [id],
                parse_project_row,
            )?
        };
        Ok(build_project_summary(row))
    }

    /// The children of one directory of the Project's folder (`""` is the
    /// root), without `.git` or gitignored entries.
    pub fn list_dir(&self, project_id: u32, path: &str) -> Result<Vec<FileEntry>> {
        files::list_dir(Path::new(&self.checkout_path(project_id)?), path)
    }

    /// A file of the Project's folder, read by Core so the webview never
    /// touches the filesystem. Capped at 1 MiB.
    pub fn read_file(&self, project_id: u32, path: &str) -> Result<FileContent> {
        files::read_file(Path::new(&self.checkout_path(project_id)?), path)
    }

    pub fn write_file(
        &self,
        project_id: u32,
        path: &str,
        expected: &str,
        content: &str,
    ) -> Result<()> {
        let root = PathBuf::from(self.checkout_path(project_id)?);
        self.git
            .mutate(&root, || files::write_file(&root, path, expected, content))
    }

    pub fn language_tools(&self) -> Vec<LanguageTool> {
        language_server::tools(&self.home)
    }

    pub fn install_language_support(
        &self,
        language: &str,
        progress: impl Fn(&str),
    ) -> Result<LanguageTool> {
        self.language_servers
            .install(&self.home, language, progress)
    }

    pub fn create_file(&self, project_id: u32, path: &str) -> Result<()> {
        files::create_file(Path::new(&self.checkout_path(project_id)?), path)
    }

    pub fn find_files(&self, project_id: u32, query: &str) -> Result<Vec<String>> {
        Ok(files::find_files(
            Path::new(&self.checkout_path(project_id)?),
            query,
        ))
    }

    pub fn set_editor_dirty(&self, id: String, dirty: bool) {
        let mut editors = self.dirty_editors.lock_recover();
        if dirty {
            editors.insert(id);
        } else {
            editors.remove(&id);
        }
    }

    pub fn dirty_editor_count(&self) -> u32 {
        self.dirty_editors.lock_recover().len() as u32
    }

    pub fn start_language_server(
        &self,
        project_id: u32,
        language: &str,
    ) -> Result<(LanguageServerSummary, crossbeam_channel::Receiver<String>)> {
        let root = PathBuf::from(self.checkout_path(project_id)?);
        self.language_servers
            .start(&self.home, &root, language, Arc::clone(&self.processes))
    }

    pub fn language_server_message(&self, id: u32, message: &str) -> Result<()> {
        self.language_servers.send(id, message)
    }

    pub fn stop_language_server(&self, id: u32) {
        self.language_servers.stop(id);
    }

    /// `git fetch`, skipped when the last one was under [`FETCH_INTERVAL`] ago.
    /// Returns whether it fetched.
    pub fn fetch_project(&self, project_id: u32) -> Result<bool> {
        self.fetch_project_at(project_id, std::time::Instant::now())
    }

    /// Like [`Core::fetch_project`], with the current time injected.
    pub fn fetch_project_at(&self, project_id: u32, now: std::time::Instant) -> Result<bool> {
        // A folder the user has not acted in yet is not contacted: its own configuration may
        // name what a fetch would run.
        if !self.project_acted_upon(project_id)? {
            return Ok(false);
        }
        let checkout = self.main_checkout(project_id)?;
        self.git.fetch(&checkout, now)
    }

    /// Replaces the directories `gh` is looked up in (default: the process PATH
    /// plus Homebrew's). Tests put a fake `gh` alone on it.
    pub fn set_gh_search_path(&self, dirs: Option<Vec<PathBuf>>) {
        self.gh.set_search_path(dirs);
    }

    /// Branches on GitHub that can be selected as a pull request's base.
    pub fn pull_request_base_branches(&self, project_id: u32) -> Result<Vec<String>> {
        github::pull_request_base_branches(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Availability of GitHub CLI for issues, and guidance if missing/logged out.
    pub fn issues_state(&self, project_id: u32) -> Result<IssuesState> {
        Ok(github::issues_state(
            &self.gh,
            &self.main_checkout(project_id)?,
        ))
    }

    /// Open or closed issues of the repository, optionally only the user's own and
    /// narrowed by a search query.
    pub fn list_issues(
        &self,
        project_id: u32,
        closed: bool,
        mine: bool,
        search: &str,
    ) -> Result<Vec<IssueSummary>> {
        github::list_issues(
            &self.gh,
            &self.main_checkout(project_id)?,
            closed,
            mine,
            search,
        )
    }

    /// Detailed issue with its description, status and comments.
    pub fn issue_detail(&self, project_id: u32, number: u32) -> Result<IssueDetail> {
        github::issue_detail(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// The files of the repository's issue templates directory on GitHub.
    pub fn issue_templates(&self, project_id: u32) -> Result<Vec<IssueTemplateFile>> {
        github::issue_templates(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Creates an issue with title, body, assignees and labels.
    pub fn create_issue(
        &self,
        project_id: u32,
        title: &str,
        body: &str,
        assignees: &[String],
        labels: &[String],
    ) -> Result<IssueSummary> {
        github::create_issue(
            &self.gh,
            &self.main_checkout(project_id)?,
            title,
            body,
            assignees,
            labels,
        )
    }

    /// Rewrites a comment of a pull request or an issue.
    pub fn edit_comment(&self, project_id: u32, id: &str, body: &str) -> Result<()> {
        github::edit_comment(&self.gh, &self.main_checkout(project_id)?, id, body)
    }

    /// Deletes a comment of a pull request or an issue.
    pub fn delete_comment(&self, project_id: u32, id: &str) -> Result<()> {
        github::delete_comment(&self.gh, &self.main_checkout(project_id)?, id)
    }

    /// Adds a comment to an issue.
    pub fn comment_issue(&self, project_id: u32, number: u32, body: &str) -> Result<()> {
        github::comment_issue(&self.gh, &self.main_checkout(project_id)?, number, body)
    }

    /// Closes an issue with a reason, and a comment when given.
    pub fn close_issue(
        &self,
        project_id: u32,
        number: u32,
        reason: IssueCloseReason,
        comment: &str,
    ) -> Result<()> {
        github::close_issue(
            &self.gh,
            &self.main_checkout(project_id)?,
            number,
            reason,
            comment,
        )
    }

    /// Reopens a closed issue.
    pub fn reopen_issue(&self, project_id: u32, number: u32) -> Result<()> {
        github::reopen_issue(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// Changes an issue's title, description, assignees and labels.
    pub fn edit_issue(&self, project_id: u32, number: u32, edit: &IssueEdit) -> Result<()> {
        github::edit_issue(&self.gh, &self.main_checkout(project_id)?, number, edit)
    }

    /// Opens a GitHub link, such as a check's run, in the system browser.
    pub fn open_link(&self, url: &str) -> Result<()> {
        self.system().open_url(github::checked_url(url)?);
        Ok(())
    }

    /// Opens a link on a host outside the allowlist, after the user confirmed the host.
    pub fn open_confirmed_link(&self, url: &str) -> Result<()> {
        self.system().open_url(github::confirmed_url(url)?);
        Ok(())
    }

    /// Open pull requests of the Project's repository: only the user's own, if
    /// `mine`, and matching the GitHub search query, if not empty.
    pub fn list_pull_requests(
        &self,
        project_id: u32,
        mine: bool,
        search: &str,
    ) -> Result<Vec<PullRequest>> {
        github::list_pull_requests(&self.gh, &self.main_checkout(project_id)?, mine, search)
    }

    /// A pull request's description, checks, conversation, allowed merge
    /// methods and changed files.
    pub fn pull_request_detail(&self, project_id: u32, number: u32) -> Result<PullRequestDetail> {
        github::pull_request_detail(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// Adds a conversation comment to a pull request.
    pub fn comment_pull_request(&self, project_id: u32, number: u32, body: &str) -> Result<()> {
        github::comment_pull_request(&self.gh, &self.main_checkout(project_id)?, number, body)
    }

    /// Moves a pull request out of draft (`draft` false), or back into it.
    pub fn set_pull_request_draft(&self, project_id: u32, number: u32, draft: bool) -> Result<()> {
        github::set_pull_request_draft(&self.gh, &self.main_checkout(project_id)?, number, draft)
    }

    /// Brings a pull request's branch up to date with its base.
    pub fn update_pull_request_branch(&self, project_id: u32, number: u32) -> Result<()> {
        github::update_pull_request_branch(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// The people and labels a pull request's settings can pick from.
    pub fn pull_request_candidates(&self, project_id: u32) -> Result<PullRequestCandidates> {
        github::pull_request_candidates(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Changes a pull request's reviewers, assignees and labels.
    pub fn edit_pull_request(
        &self,
        project_id: u32,
        number: u32,
        edit: &PullRequestEdit,
    ) -> Result<()> {
        github::edit_pull_request(&self.gh, &self.main_checkout(project_id)?, number, edit)
    }

    /// Closes a pull request on GitHub without merging it.
    pub fn close_pull_request(&self, project_id: u32, number: u32) -> Result<()> {
        github::close_pull_request(&self.gh, &self.main_checkout(project_id)?, number)
    }

    fn main_checkout(&self, project_id: u32) -> Result<PathBuf> {
        Ok(PathBuf::from(self.checkout_path(project_id)?))
    }

    pub fn subscribe_terminal(
        &self,
        terminal_id: u32,
    ) -> Result<crossbeam_channel::Receiver<Vec<u8>>> {
        Ok(self.terminal(terminal_id)?.subscribe())
    }

    pub fn write_terminal(&self, terminal_id: u32, bytes: &[u8]) -> Result<()> {
        let session = self.terminal(terminal_id)?;
        self.mark_terminal_project_acted_upon(terminal_id)?;
        session.write(bytes)
    }

    pub fn run_terminal_block(&self, terminal_id: u32, command: &str, token: &str) -> Result<()> {
        let session = self.terminal(terminal_id)?;
        self.mark_terminal_project_acted_upon(terminal_id)?;
        session.run_block(command, token)
    }

    fn mark_terminal_project_acted_upon(&self, terminal_id: u32) -> Result<()> {
        let first = self.acted_terminals.lock_recover().insert(terminal_id);
        if !first {
            return Ok(());
        }
        let result = self.mark_terminal_project_in_db(terminal_id);
        if result.is_err() {
            // Not written: the next keystroke tries again.
            self.acted_terminals.lock_recover().remove(&terminal_id);
        }
        result
    }

    fn mark_terminal_project_in_db(&self, terminal_id: u32) -> Result<()> {
        let project = self
            .terminal_projects
            .lock_recover()
            .get(&terminal_id)
            .copied();
        match project {
            Some(project) => self.mark_project_acted_upon(project),
            None => Ok(()),
        }
    }

    pub fn complete_terminal(
        &self,
        terminal_id: u32,
        line: &str,
        cursor: usize,
        cwd: &str,
    ) -> Result<TerminalCompletion> {
        let session = self.terminal(terminal_id)?;
        let cwd =
            terminal_completion::trusted_cwd(cwd, &self.open_checkouts()?, &session.summary.cwd);
        terminal_completion::complete(&session, line, cursor, &cwd)
    }

    pub fn resize_terminal(&self, terminal_id: u32, rows: u16, cols: u16) -> Result<()> {
        self.terminal(terminal_id)?.resize(rows, cols)
    }

    fn terminal(&self, id: u32) -> Result<Arc<TerminalSession>> {
        self.terminals
            .lock_recover()
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::Terminal(format!("unknown terminal {id}")))
    }

    fn expand_home(&self, root: &str) -> PathBuf {
        match root.strip_prefix("~") {
            Some("") => self.user_home.clone(),
            Some(rest) if rest.starts_with('/') => self.user_home.join(&rest[1..]),
            _ => PathBuf::from(root),
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.shutdown();
    }
}
