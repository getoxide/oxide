use std::fs;
use std::path::Path;

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{Error, Result};

/// Forward-only migrations. Index `i` upgrades `user_version` from `i` to `i + 1`.
///
/// The first one is the whole schema of a fresh install. Add a migration after it for every
/// later change; never edit one that has shipped.
///
/// It sets `application_id` to 1331185988 ("OXID"). A database written before the baseline
/// existed has 0 there, which is how [`open_app`] recognises it and calls [`adopt_legacy`].
pub const MIGRATIONS: &[&str] = &["
    PRAGMA application_id = 1331185988;
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        -- Hidden from the Project palette by the user.
        hidden INTEGER NOT NULL DEFAULT 0,
        -- When the user opened it into the sidebar; NULL for a Project a scan only found.
        opened_at TEXT,
        -- Whether the user has acted in it; Oxide fetches its remote in the background only then.
        acted_upon INTEGER NOT NULL DEFAULT 0
    );
    -- Small app-level facts, such as the Project last open (key `selection`).
    CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"];

/// Brings a database written before the baseline schema existed to the baseline, in place,
/// keeping its Projects and the remembered selection. Everything else it holds belonged to
/// features Oxide no longer has (ADR-0018). The caller has written a backup first.
///
/// Works for any older version: it copies the columns the old `projects` table has and uses the
/// column's default for the ones it lacks.
fn adopt_legacy(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let has_table = |name: &str| -> Result<bool> {
        Ok(tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )?)
    };
    let mut columns = Vec::new();
    {
        let mut statement = tx.prepare("SELECT name FROM pragma_table_info('projects')")?;
        for name in statement.query_map([], |row| row.get::<_, String>(0))? {
            columns.push(name?);
        }
    }
    let copy = |column: &str, fallback: &str| {
        if columns.iter().any(|c| c == column) {
            column.to_owned()
        } else {
            fallback.to_owned()
        }
    };
    // A Project listed before `opened_at` existed was already open.
    let (hidden, opened_at, acted_upon) = (
        copy("hidden", "0"),
        copy("opened_at", "created_at"),
        copy("acted_upon", "0"),
    );
    let had_state = has_table("app_state")?;
    let mut other_tables = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             AND name NOT IN ('projects', 'app_state')",
        )?;
        for name in statement.query_map([], |row| row.get::<_, String>(0))? {
            other_tables.push(name?);
        }
    }

    tx.execute_batch(
        "PRAGMA defer_foreign_keys = ON; ALTER TABLE projects RENAME TO legacy_projects;",
    )?;
    if had_state {
        tx.execute_batch("ALTER TABLE app_state RENAME TO legacy_app_state;")?;
    }
    for table in &other_tables {
        tx.execute_batch(&format!("DROP TABLE IF EXISTS \"{table}\";"))?;
    }
    tx.execute_batch(MIGRATIONS[0])?;
    tx.execute_batch(&format!(
        "INSERT INTO projects (id, name, path, created_at, hidden, opened_at, acted_upon)
             SELECT id, name, path, created_at, {hidden}, {opened_at}, {acted_upon}
             FROM legacy_projects;
         DROP TABLE legacy_projects;"
    ))?;
    if had_state {
        tx.execute_batch(
            "INSERT INTO app_state (key, value)
                 SELECT key, value FROM legacy_app_state WHERE key = 'selection';
             DROP TABLE legacy_app_state;",
        )?;
    }
    tx.pragma_update(None, "user_version", 1)?;
    tx.commit()?;
    Ok(())
}

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
    let conn = connect(path)?;
    migrate(&conn, path, migrations)?;
    Ok(conn)
}

/// Like [`open`] with [`MIGRATIONS`], and first brings a database written before the baseline
/// schema existed (any older Oxide, up to v0.0.4 and its successors) to the baseline.
pub fn open_app(path: &Path) -> Result<Connection> {
    let conn = connect(path)?;
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let application_id: u32 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if version > 0 && application_id == 0 {
        backup(&conn, path, version)?;
        adopt_legacy(&conn)?;
    }
    migrate(&conn, path, MIGRATIONS)?;
    Ok(conn)
}

fn connect(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
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

    /// A database as an older Oxide left it: Projects plus the tables of removed features.
    fn legacy_database(path: &Path, with_state: bool) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                 id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
                 created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
                 hidden INTEGER NOT NULL DEFAULT 0, opened_at TEXT,
                 acted_upon INTEGER NOT NULL DEFAULT 0, setup_command TEXT,
                 threads_in_main_checkout INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE threads (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id));
             CREATE TABLE turns (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id));
             INSERT INTO projects (id, name, path, hidden, opened_at, acted_upon, setup_command)
                 VALUES (1, 'p', '/p', 1, '2026-02-02T00:00:00.000Z', 1, 'make');
             INSERT INTO projects (id, name, path) VALUES (2, 'q', '/q');
             INSERT INTO threads (id, project_id) VALUES (1, 1);
             INSERT INTO turns (id, thread_id) VALUES (1, 1);",
        )
        .unwrap();
        if with_state {
            conn.execute_batch(
                "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO app_state VALUES ('selection', '1'), ('last_scan', 'x');",
            )
            .unwrap();
        }
        conn.pragma_update(None, "user_version", 41).unwrap();
    }

    fn schema(conn: &Connection) -> Vec<(String, String)> {
        let mut statement = conn
            .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
            .unwrap();
        statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    #[test]
    fn an_older_database_keeps_its_projects_and_ends_with_the_fresh_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oxide.db");
        legacy_database(&path, true);

        let migrated = open_app(&path).unwrap();

        let fresh_dir = tempfile::tempdir().unwrap();
        let fresh = open_app(&fresh_dir.path().join("oxide.db")).unwrap();
        let tables = |conn: &Connection| -> Vec<String> {
            schema(conn).into_iter().map(|(name, _)| name).collect()
        };
        assert_eq!(tables(&migrated), tables(&fresh));
        let columns = |conn: &Connection| -> Vec<String> {
            let mut statement = conn
                .prepare("SELECT name FROM pragma_table_info('projects')")
                .unwrap();
            statement
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        assert_eq!(columns(&migrated), columns(&fresh));
        let rows: Vec<(i64, String, i64, Option<String>, i64)> = {
            let mut statement = migrated
                .prepare("SELECT id, path, hidden, opened_at, acted_upon FROM projects ORDER BY id")
                .unwrap();
            statement
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                (
                    1,
                    "/p".into(),
                    1,
                    Some("2026-02-02T00:00:00.000Z".into()),
                    1
                ),
                (2, "/q".into(), 0, None, 0),
            ]
        );
        let state: Vec<String> = {
            let mut statement = migrated.prepare("SELECT key FROM app_state").unwrap();
            statement
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        assert_eq!(state, vec!["selection".to_owned()]);
        let version: u32 = migrated
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as u32);
        assert!(directory.path().join("oxide.db.bak-41").exists());
    }

    #[test]
    fn a_database_from_before_the_selection_table_still_opens() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oxide.db");
        legacy_database(&path, false);

        let migrated = open_app(&path).unwrap();

        let count: i64 = migrated
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        migrated
            .execute(
                "INSERT INTO app_state (key, value) VALUES ('selection', '2')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn reopening_an_adopted_database_changes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oxide.db");
        legacy_database(&path, true);
        drop(open_app(&path).unwrap());

        let again = open_app(&path).unwrap();

        let count: i64 = again
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        assert!(!directory.path().join("oxide.db.bak-1").exists());
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
