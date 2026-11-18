use std::fs;
use std::path::Path;

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{Error, Result};

/// Forward-only migrations. Index `i` upgrades `user_version` from `i` to `i + 1`.
pub const MIGRATIONS: &[&str] = &[
    "
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
",
    "
    CREATE TABLE threads (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        turn_index INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT
    );

    CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        item_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    CREATE TABLE approvals (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        approval_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        decision TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decided_at TEXT
    );
",
    "
    CREATE TABLE unknown_events (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        raw TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    ALTER TABLE items ADD COLUMN parent_item_index INTEGER;
    ALTER TABLE turns ADD COLUMN model TEXT;
    ALTER TABLE turns ADD COLUMN effort TEXT;
    ALTER TABLE turns ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
",
    "
    ALTER TABLE turns ADD COLUMN error_message TEXT;
    ALTER TABLE turns ADD COLUMN stderr_tail TEXT;
",
    // Transcript paging reads Turns by position and Items by Turn.
    "
    CREATE INDEX turns_by_thread ON turns(thread_id, id);
    CREATE INDEX items_by_turn ON items(turn_id, item_index);
",
    // Small app-level facts, such as the Project last open.
    "
    CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
",
    // A Thread whose Provider session is gone, and the Thread that continues it.
    "
    ALTER TABLE threads ADD COLUMN session_lost INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN continued_from INTEGER REFERENCES threads(id);
",
    "
    ALTER TABLE threads ADD COLUMN title TEXT;
",
    // Board Threads: a worktree of their own, and the output of the Project's Setup command
    // that ran in it. The Setup command itself lives with the Project, never in its repository.
    "
    ALTER TABLE threads ADD COLUMN branch TEXT;
    ALTER TABLE threads ADD COLUMN worktree_path TEXT;
    ALTER TABLE threads ADD COLUMN setup_output TEXT;
    ALTER TABLE projects ADD COLUMN setup_command TEXT;
",
    // The GitHub issue a Board Thread was started from.
    "
    ALTER TABLE threads ADD COLUMN issue_number INTEGER;
",
    // Open Projects: the ones the user opened, listed in the sidebar. A scan only makes
    // Projects known (findable in the Project palette); Projects with Threads start open.
    "
    ALTER TABLE projects ADD COLUMN opened_at TEXT;
    UPDATE projects SET opened_at = created_at
        WHERE id IN (SELECT DISTINCT project_id FROM threads);
",
    // Threads are deleted, not archived: a finished Thread leaves nothing behind in the sidebar
    // or the context of the next one. Threads archived before this reappear in the list.
    "
    ALTER TABLE threads DROP COLUMN archived;
",
    // The macro category of a tool-call Item; NULL for other Items and for Items stored before.
    "
    ALTER TABLE items ADD COLUMN category TEXT;
",
    // A Turn's prompt as segments: text and Attachments in order. NULL for Turns stored before,
    // whose Attachments are the paths in `attachments`.
    "
    ALTER TABLE turns ADD COLUMN segments TEXT;
",
    // The Review ledger (ADR-0010): one row per merged pull request of a Thread. Identifiers,
    // Provider, Model and timestamps only, no Transcript text and no foreign key, so a row
    // outlives its Thread.
    "
    CREATE TABLE review_ledger (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        turn_completed_at INTEGER NOT NULL,
        merged_at INTEGER NOT NULL,
        UNIQUE (project_id, pull_request)
    );
",
    // Line comments: drafts on a Diff line, kept per Thread until sent.
    "
    CREATE TABLE line_comments (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        scope TEXT NOT NULL,
        path TEXT NOT NULL,
        side TEXT NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX line_comments_by_thread ON line_comments(thread_id, id);
",
    // A per-Project choice: keep chat Threads in the main checkout instead of
    // giving each one its own worktree on its first prompt. Default off, so new
    // chat Threads work in their own worktree like Board Threads do.
    "
    ALTER TABLE projects ADD COLUMN threads_in_main_checkout INTEGER NOT NULL DEFAULT 0;
",
    // Line comments drafted on a pull request's Diff, kept per Project and pull request until one
    // review is submitted. They belong to no checkout, so reviewing never needs one.
    "
    CREATE TABLE pull_request_line_comments (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        path TEXT NOT NULL,
        side TEXT NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX pull_request_line_comments_by_pr
        ON pull_request_line_comments(project_id, pull_request, id);
",
    // What a Provider reported about a command an Item ran, and the permission mode a Turn
    // started in. NULL on Items and Turns stored before command evidence existed: their outcome
    // reads as unknown, and their Turn's permission mode as not recorded.
    "
    ALTER TABLE items ADD COLUMN command_line TEXT;
    ALTER TABLE items ADD COLUMN command_outcome TEXT;
    ALTER TABLE items ADD COLUMN command_exit_code INTEGER;
    ALTER TABLE turns ADD COLUMN permission_mode TEXT;
",
    // A restore: a Thread's files put back to before a Turn, and the Checkpoint
    // that undoes it (ADR-0011).
    "
    CREATE TABLE restores (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        turn_index INTEGER NOT NULL,
        safety_ref TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        undone_at TEXT
    );
    CREATE INDEX restores_by_thread ON restores(thread_id, id);
",
    // What the agent is told on the next prompt of a Thread whose files were restored.
    "
    ALTER TABLE threads ADD COLUMN restore_notice TEXT;
",
    // A Project's own Verification commands: a JSON array of command lines that count as checks
    // beside the built-in patterns. Kept with the Project, never in its repository.
    "
    ALTER TABLE projects ADD COLUMN verification_commands TEXT NOT NULL DEFAULT '[]';
",
    // The labels of the GitHub issue a Board Thread was started from, so a Review round can
    // describe its kind of work without asking GitHub again. Names only, never issue text.
    "
    ALTER TABLE threads ADD COLUMN issue_labels TEXT NOT NULL DEFAULT '[]';
",
    // The Review ledger's review rounds (ADR-0010): one row per send of Line comments or
    // reviewer comments, with Provider, Model, kind of work and counts, never Transcript text
    // and no foreign key, so a row outlives its Thread.
    "
    CREATE TABLE review_rounds (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        languages TEXT NOT NULL DEFAULT '[]',
        size_band TEXT NOT NULL,
        issue_labels TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX review_rounds_by_project ON review_rounds(project_id, id);
",
    // The title and link of the GitHub issue a Board Thread was started from, so its Dossier can
    // show what was asked without asking GitHub again.
    "
    ALTER TABLE threads ADD COLUMN issue_title TEXT;
    ALTER TABLE threads ADD COLUMN issue_url TEXT;
",
    // A Project's own sensitive paths for the Dossier's risk signals, as glob patterns. The
    // built-in CI, dependency manifest and migration patterns are matched beside these.
    "
    ALTER TABLE projects ADD COLUMN sensitive_paths TEXT NOT NULL DEFAULT '[]';
",
    // The branch HEAD when a Turn started and when it ended, so the Dossier can tell the commits
    // the Turn produced from those it did not. NULL for Turns stored before this.
    "
    ALTER TABLE turns ADD COLUMN head_before TEXT;
    ALTER TABLE turns ADD COLUMN head_after TEXT;
",
    // Reverts and candidate follow-up fixes for tracked merged pull requests (ADR-0010, #342).
    // Stored without Transcript text, outliving Threads.
    "
    CREATE TABLE review_reverts (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_subject TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (project_id, pull_request, commit_sha)
    );
    CREATE INDEX review_reverts_by_project ON review_reverts(project_id, id);

    CREATE TABLE review_follow_ups (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_subject TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        co_modified_files TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (project_id, pull_request, commit_sha)
    );
    CREATE INDEX review_follow_ups_by_project ON review_follow_ups(project_id, id);
",
    // Recurring feedback turned into rule suggestions (#343): the text of Line comments sent to a
    // Thread, grouped per Project by normalized word similarity. Kept apart from the Review
    // ledger, which still holds no comment text (ADR-0010).
    "
    CREATE TABLE rule_suggestions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decided_at TEXT
    );
    CREATE INDEX rule_suggestions_by_project ON rule_suggestions(project_id, id);

    CREATE TABLE rule_suggestion_comments (
        id INTEGER PRIMARY KEY,
        suggestion_id INTEGER NOT NULL REFERENCES rule_suggestions(id),
        thread_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX rule_suggestion_comments_by_suggestion
        ON rule_suggestion_comments(suggestion_id, id);
",
    // Blind review (#337): marks Threads created as Blind reviews.
    "
    ALTER TABLE threads ADD COLUMN blind_review INTEGER NOT NULL DEFAULT 0;
",
    // Blind review findings (#338): the review Thread, the Thread it reviewed, the reviewing
    // Provider and the Diff scope it saw; then each finding, anchored to a line of the reviewed
    // Diff or kept as plain text, with the reviewer's keep or dismiss decision. Kept findings
    // become Line comment drafts on the reviewed Thread.
    "
    ALTER TABLE threads ADD COLUMN blind_review_of INTEGER REFERENCES threads(id);

    CREATE TABLE blind_reviews (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER REFERENCES threads(id),
        review_thread_id INTEGER NOT NULL UNIQUE REFERENCES threads(id),
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX blind_reviews_by_thread ON blind_reviews(thread_id, id);

    CREATE TABLE blind_review_findings (
        id INTEGER PRIMARY KEY,
        review_id INTEGER NOT NULL REFERENCES blind_reviews(id),
        path TEXT,
        side TEXT,
        line INTEGER,
        code TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        anchored INTEGER NOT NULL DEFAULT 0,
        decision TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX blind_review_findings_by_review ON blind_review_findings(review_id, id);

    ALTER TABLE line_comments ADD COLUMN provider TEXT;
    ALTER TABLE line_comments ADD COLUMN finding_id INTEGER
        REFERENCES blind_review_findings(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX line_comments_by_finding ON line_comments(finding_id)
        WHERE finding_id IS NOT NULL;
",
    // The Verification Dossier and the Diff Surface's pull request review drafts are gone: drop
    // what only they used.
    "
    ALTER TABLE projects DROP COLUMN sensitive_paths;
    ALTER TABLE turns DROP COLUMN head_before;
    ALTER TABLE turns DROP COLUMN head_after;
    DROP INDEX pull_request_line_comments_by_pr;
    DROP TABLE pull_request_line_comments;
    DELETE FROM app_state WHERE key LIKE 'dossier_options:%';
",
    // Verification commands were only used by the removed Verification Dossier.
    "
    ALTER TABLE projects DROP COLUMN verification_commands;
",
    // Oxide fetches a Project's remote on its own only once the user has acted in it, so that
    // a folder obtained from elsewhere is not contacted before then. Existing Projects start
    // unacted: the first prompt, terminal command, Pull or Push sets it.
    "
    ALTER TABLE projects ADD COLUMN acted_upon INTEGER NOT NULL DEFAULT 0;
",
    // A Project that already has Threads was acted upon before the flag existed: keep its
    // background fetch running instead of silently stopping it for existing users.
    "
    UPDATE projects SET acted_upon = 1
    WHERE EXISTS (SELECT 1 FROM threads WHERE threads.project_id = projects.id);
",
    // Blind review is a one-shot headless run, not a Thread: a review has no review Thread any
    // more, and records whether it is running, finished or failed and where its throwaway
    // worktree is. The table is rebuilt to make `review_thread_id` optional (old reviews keep
    // theirs); foreign keys are deferred so the findings that point at it survive the rebuild.
    "
    PRAGMA defer_foreign_keys = ON;
    CREATE TABLE blind_reviews_old AS SELECT * FROM blind_reviews;
    DROP TABLE blind_reviews;
    CREATE TABLE blind_reviews (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER REFERENCES threads(id),
        review_thread_id INTEGER UNIQUE REFERENCES threads(id),
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        status TEXT NOT NULL DEFAULT 'finished',
        error TEXT,
        worktree TEXT
    );
    -- A row that already pointed at a missing Thread is dropped, not carried over: it would fail
    -- the foreign-key check and with it the whole database open.
    INSERT INTO blind_reviews (id, thread_id, review_thread_id, provider, scope, created_at)
        SELECT id, thread_id,
               CASE WHEN review_thread_id IN (SELECT id FROM threads) THEN review_thread_id END,
               provider, scope, created_at
        FROM blind_reviews_old
        WHERE thread_id IS NULL OR thread_id IN (SELECT id FROM threads);
    UPDATE line_comments SET finding_id = NULL
        WHERE finding_id IN (SELECT id FROM blind_review_findings
                             WHERE review_id NOT IN (SELECT id FROM blind_reviews));
    DELETE FROM blind_review_findings WHERE review_id NOT IN (SELECT id FROM blind_reviews);
    DROP TABLE blind_reviews_old;
    CREATE INDEX blind_reviews_by_thread ON blind_reviews(thread_id, id);
",
    // A Thread whose centre is an Agent terminal running the Provider's own CLI (ADR-0017).
    // Its Provider session id is `provider_session_id`, assigned by Oxide at launch.
    "
    ALTER TABLE threads ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0;
",
    // Oxide is Projects and plain terminals (ADR-0018): everything that only served Threads,
    // Providers, Checkpoints, worktrees, the Review ledger or Blind review goes. The backup
    // `oxide.db.bak-<version>` is written first by `migrate`. Worktree folders and branches on
    // disk are not touched.
    "
    DROP TABLE IF EXISTS blind_review_findings;
    DROP TABLE IF EXISTS blind_reviews;
    DROP TABLE IF EXISTS blind_reviews_old;
    DROP TABLE IF EXISTS rule_suggestion_comments;
    DROP TABLE IF EXISTS rule_suggestions;
    DROP TABLE IF EXISTS review_follow_ups;
    DROP TABLE IF EXISTS review_reverts;
    DROP TABLE IF EXISTS review_rounds;
    DROP TABLE IF EXISTS review_ledger;
    DROP TABLE IF EXISTS line_comments;
    DROP TABLE IF EXISTS restores;
    DROP TABLE IF EXISTS unknown_events;
    DROP TABLE IF EXISTS approvals;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS turns;
    DROP TABLE IF EXISTS threads;
    ALTER TABLE projects DROP COLUMN setup_command;
    ALTER TABLE projects DROP COLUMN threads_in_main_checkout;
    DELETE FROM app_state WHERE key <> 'selection';
",
];

/// Starts a transaction that will write. `IMMEDIATE` takes the write lock up front:
/// a deferred transaction that reads first and writes later reads a snapshot another
/// connection (the app's own, the board's, the review ledger's) is free to replace,
/// and then fails to upgrade with `SQLITE_BUSY_SNAPSHOT` — an error the busy timeout
/// does not retry, so the write is simply lost.
pub(crate) fn write_transaction(conn: &Connection) -> Result<Transaction<'_>> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(Into::into)
}

/// Opens the database at `path` (WAL) and applies pending `migrations`, writing
/// `<path>.bak-<version>` first, where `<version>` is the version being migrated away from.
pub fn open(path: &Path, migrations: &[&str]) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn, path, migrations)?;
    Ok(conn)
}

fn migrate(conn: &Connection, path: &Path, migrations: &[&str]) -> Result<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let target = migrations.len() as u32;
    if current > target {
        return Err(Error::DatabaseTooNew {
            found: current,
            supported: target,
        });
    }
    for version in current..target {
        if version > 0 {
            backup(conn, path, version)?;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(migrations[version as usize])?;
        tx.pragma_update(None, "user_version", version + 1)?;
        tx.commit()?;
    }
    Ok(())
}

fn backup(conn: &Connection, path: &Path, version: u32) -> Result<()> {
    // Fold the WAL into the main file so the copy is complete.
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-{version}"));
    let dest = std::path::PathBuf::from(name);
    fs::copy(path, &dest).map_err(|source| Error::Io { path: dest, source })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn migrating_keeps_fetch_on_for_projects_with_threads_and_off_for_the_rest() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oxide.db");
        let step = MIGRATIONS
            .iter()
            .position(|m| m.contains("UPDATE projects SET acted_upon = 1"))
            .unwrap();
        let before = &MIGRATIONS[..step];
        let old = open(&path, before).unwrap();
        old.execute("INSERT INTO projects (name, path) VALUES ('p', '/p')", [])
            .unwrap();
        old.execute("INSERT INTO projects (name, path) VALUES ('q', '/q')", [])
            .unwrap();
        old.execute(
            "INSERT INTO threads (project_id, provider, permission_mode, status) \
             SELECT id, 'fake', 'ask', 'idle' FROM projects WHERE path = '/p'",
            [],
        )
        .unwrap();
        drop(old);

        let migrated = open(&path, MIGRATIONS).unwrap();

        let acted = |project: &str| -> i64 {
            migrated
                .query_row(
                    "SELECT acted_upon FROM projects WHERE path = ?1",
                    [project],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(acted("/p"), 1, "a Project with a Thread was acted upon");
        assert_eq!(acted("/q"), 0, "an untouched Project stays unacted");
    }

    #[test]
    fn a_write_transaction_survives_another_connection_writing_meanwhile() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oxide.db");
        let mine = open(&path, &[]).unwrap();
        mine.execute_batch("CREATE TABLE probe (value TEXT)")
            .unwrap();
        let other = open(&path, &[]).unwrap();

        let transaction = write_transaction(&mine).unwrap();
        let _: i64 = transaction
            .query_row("SELECT COUNT(*) FROM probe", [], |r| r.get(0))
            .unwrap();
        // Another connection writes while this transaction is open and has already read.
        let writer = std::thread::spawn(move || {
            other.execute("INSERT INTO probe (value) VALUES ('other')", [])
        });
        std::thread::sleep(Duration::from_millis(300));
        transaction
            .execute("INSERT INTO probe (value) VALUES ('mine')", [])
            .unwrap();
        transaction.commit().unwrap();

        assert_eq!(
            writer.join().unwrap().unwrap(),
            1,
            "the other writer lost its write"
        );
        let written: i64 = mine
            .query_row("SELECT COUNT(*) FROM probe", [], |r| r.get(0))
            .unwrap();
        assert_eq!(written, 2);
    }
}
