use super::types::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// The database is the sole persistent owner of conversations. Updates never
/// insert: an old callback cannot recreate a conversation after deletion.
pub struct ConversationStore {
    db: Connection,
    path: PathBuf,
}
impl ConversationStore {
    pub fn open(path: PathBuf) -> Result<Self, AiError> {
        if !path.is_absolute() {
            return Err(AiError::storage("absolute path required"));
        }
        if !path.exists() {
            crate::private_storage::write_atomic(&path, &[]).map_err(AiError::storage)?;
        }
        // macOS commonly exposes its temporary/application path through an
        // ancestor symlink (for example /var). Resolve only the parent; SQLite
        // still refuses a symlink substituted for the database itself.
        let path = fs::canonicalize(
            path.parent()
                .ok_or_else(|| AiError::storage("missing database parent"))?,
        )
        .map_err(AiError::storage)?
        .join(
            path.file_name()
                .ok_or_else(|| AiError::storage("missing database filename"))?,
        );
        for candidate in [path.clone(), suffix(&path, "-wal"), suffix(&path, "-shm")] {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) if !metadata.file_type().is_file() => {
                    return Err(AiError::storage("non-regular database"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(AiError::storage(error)),
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = fs::symlink_metadata(&path).map_err(AiError::storage)?;
            if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(AiError::storage(
                    "database ownership or link count is unsafe",
                ));
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(AiError::storage)?;
        }
        let db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(AiError::storage)?;
        db.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(AiError::storage)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS ai_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_sessions(id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS ai_sessions_updated ON ai_sessions(updated_at DESC,id);
            CREATE TABLE IF NOT EXISTS ai_runs(submission_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ai_runs_session ON ai_runs(session_id);
            DROP TABLE IF EXISTS ai_daily;
            DELETE FROM ai_meta WHERE key='grants';
            DELETE FROM ai_runs WHERE session_id IN (SELECT id FROM ai_sessions WHERE deleted=1);
            DELETE FROM ai_sessions WHERE deleted=1;").map_err(AiError::storage)?;
        let has_summary = {
            let mut columns = db
                .prepare("PRAGMA table_info(ai_sessions)")
                .map_err(AiError::storage)?;
            let names = columns
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(AiError::storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(AiError::storage)?;
            names.iter().any(|name| name == "summary")
        };
        if !has_summary {
            db.execute(
                "ALTER TABLE ai_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(AiError::storage)?;
        }
        let mut store = Self { db, path };
        store.recover()?;
        Ok(store)
    }
    fn recover(&mut self) -> Result<(), AiError> {
        let sessions: Vec<String> = {
            let mut statement = self
                .db
                .prepare("SELECT id FROM ai_sessions WHERE deleted=0")
                .map_err(AiError::storage)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(AiError::storage)?;
            rows.map(|row| row.map_err(AiError::storage))
                .collect::<Result<_, _>>()?
        };
        for id in sessions {
            let mut session = self.get(&id)?;
            let mut changed = false;
            for message in &mut session.messages {
                if matches!(message.status.as_str(), "pending" | "streaming") {
                    message.status = "interrupted".into();
                    message.reusable_in_context = false;
                    for step in &mut message.tool_steps {
                        if matches!(step.state.as_str(), "running" | "awaiting_confirmation") {
                            step.state = "interrupted".into();
                            step.finished_at = Some(super::service::now());
                        }
                    }
                    changed = true;
                }
            }
            if changed {
                session.summary.revision += 1;
                self.update(&session)?;
            }
        }
        let runs: Vec<AnalysisRun> = {
            let mut statement = self
                .db
                .prepare("SELECT data FROM ai_runs")
                .map_err(AiError::storage)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(AiError::storage)?;
            rows.map(|row| decode(&row.map_err(AiError::storage)?))
                .collect::<Result<_, _>>()?
        };
        for mut run in runs {
            if matches!(run.state.as_str(), "pending" | "streaming") {
                run.state = "interrupted".into();
                run.finished_at = Some(super::service::now());
                self.update_run(&run)?;
            }
        }
        Ok(())
    }
    pub fn read_meta<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, AiError> {
        let value: Option<String> = self
            .db
            .query_row("SELECT value FROM ai_meta WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(AiError::storage)?;
        value.map(|value| decode(&value)).transpose()
    }
    pub fn write_meta(&self, key: &str, value: &impl Serialize) -> Result<(), AiError> {
        self.db.execute("INSERT INTO ai_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,encode(value)?]).map_err(AiError::storage)?;
        Ok(())
    }
    pub fn storage_bytes(&self) -> u64 {
        [
            self.path.clone(),
            suffix(&self.path, "-wal"),
            suffix(&self.path, "-shm"),
        ]
        .iter()
        .map(|path| fs::metadata(path).map(|m| m.len()).unwrap_or(0))
        .sum()
    }
    pub fn check_capacity(&self, additional: usize, budget: u64) -> Result<(), AiError> {
        // Keep space for WAL checkpoints and final status writes. Existing data
        // is never evicted to make a new request fit.
        if self
            .storage_bytes()
            .saturating_add((additional as u64).saturating_mul(2))
            .saturating_add(128 * 1024)
            > budget
        {
            Err(AiError::new(
                "storage_full",
                "Conversation storage is full. Delete conversations, increase the storage budget, or explicitly start a temporary conversation.",
            ))
        } else {
            Ok(())
        }
    }
    pub fn insert(&self, session: &AiSession, budget: u64) -> Result<(), AiError> {
        let data = encode(session)?;
        self.check_capacity(data.len(), budget)?;
        self.db
            .execute(
                "INSERT INTO ai_sessions(id,updated_at,data,summary) VALUES(?1,?2,?3,?4)",
                params![
                    session.summary.id,
                    sql_timestamp(session.summary.updated_at)?,
                    data,
                    encode(&session.summary)?
                ],
            )
            .map_err(AiError::storage)?;
        Ok(())
    }
    pub fn update(&self, session: &AiSession) -> Result<(), AiError> {
        let changed = self
            .db
            .execute(
                "UPDATE ai_sessions SET data=?2,updated_at=?3,summary=?4 WHERE id=?1 AND deleted=0",
                params![
                    session.summary.id,
                    encode(session)?,
                    sql_timestamp(session.summary.updated_at)?,
                    encode(&session.summary)?
                ],
            )
            .map_err(AiError::storage)?;
        if changed == 0 {
            return Err(AiError::new(
                "session_deleted",
                "This conversation has been deleted.",
            ));
        }
        Ok(())
    }
    pub fn get(&self, id: &str) -> Result<AiSession, AiError> {
        let value: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM ai_sessions WHERE id=?1 AND deleted=0",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(AiError::storage)?;
        value
            .map(|value| decode(&value))
            .transpose()?
            .ok_or_else(|| {
                AiError::new(
                    "session_not_found",
                    "This conversation is no longer available.",
                )
            })
    }
    pub fn exists(&self, id: &str) -> Result<bool, AiError> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_sessions WHERE id=?1 AND deleted=0)",
                [id],
                |row| row.get(0),
            )
            .map_err(AiError::storage)
    }
    pub fn list(&self, offset: u32, limit: u32) -> Result<Vec<AiSessionSummary>, AiError> {
        let mut statement=self.db.prepare("SELECT CASE WHEN summary='' THEN data ELSE summary END FROM ai_sessions WHERE deleted=0 ORDER BY updated_at DESC,id LIMIT ?1 OFFSET ?2").map_err(AiError::storage)?;
        let rows = statement
            .query_map(params![limit, offset], |row| row.get::<_, String>(0))
            .map_err(AiError::storage)?;
        rows.map(|row| decode::<AiSessionSummary>(&row.map_err(AiError::storage)?))
            .collect()
    }
    pub fn submission(&self, id: &str) -> Result<Option<AnalysisRun>, AiError> {
        let value: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM ai_runs WHERE submission_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(AiError::storage)?;
        value.map(|value| decode(&value)).transpose()
    }
    /// Register the user message, empty assistant and idempotency receipt
    /// before any model bytes can leave this process.
    pub fn begin_run(
        &mut self,
        session: &AiSession,
        run: &AnalysisRun,
        budget: u64,
    ) -> Result<(), AiError> {
        let payload = encode(session)?;
        if !session.summary.temporary {
            self.check_capacity(
                payload.len() + MAX_OUTPUT_BYTES + MAX_TASK_METADATA_BYTES,
                budget,
            )?;
        }
        let transaction = self.db.transaction().map_err(AiError::storage)?;
        if !session.summary.temporary {
            let changed = transaction
                .execute(
                    "UPDATE ai_sessions SET data=?2,updated_at=?3,summary=?4 WHERE id=?1 AND deleted=0",
                    params![session.summary.id, payload, sql_timestamp(session.summary.updated_at)?,encode(&session.summary)?],
                )
                .map_err(AiError::storage)?;
            if changed == 0 {
                return Err(AiError::new(
                    "session_deleted",
                    "This conversation has been deleted.",
                ));
            }
            transaction
                .execute(
                    "INSERT INTO ai_runs(submission_id,session_id,data) VALUES(?1,?2,?3)",
                    params![run.submission_id, run.session_id, encode(run)?],
                )
                .map_err(AiError::storage)?;
        }
        transaction.commit().map_err(AiError::storage)
    }
    pub fn update_run(&self, run: &AnalysisRun) -> Result<(), AiError> {
        self.db
            .execute(
                "UPDATE ai_runs SET data=?2 WHERE submission_id=?1",
                params![run.submission_id, encode(run)?],
            )
            .map_err(AiError::storage)?;
        Ok(())
    }
    pub fn complete_run(&mut self, session: &AiSession, run: &AnalysisRun) -> Result<(), AiError> {
        let transaction = self.db.transaction().map_err(AiError::storage)?;
        let changed = transaction
            .execute(
                "UPDATE ai_sessions SET data=?2,updated_at=?3,summary=?4 WHERE id=?1 AND deleted=0",
                params![
                    session.summary.id,
                    encode(session)?,
                    sql_timestamp(session.summary.updated_at)?,
                    encode(&session.summary)?
                ],
            )
            .map_err(AiError::storage)?;
        if changed != 1 {
            return Err(AiError::new(
                "session_deleted",
                "This conversation has been deleted.",
            ));
        }
        transaction
            .execute(
                "UPDATE ai_runs SET data=?2 WHERE submission_id=?1",
                params![run.submission_id, encode(run)?],
            )
            .map_err(AiError::storage)?;
        transaction.commit().map_err(AiError::storage)
    }
    #[cfg(test)]
    pub fn fail_writes(&self, fail: bool) {
        self.db.pragma_update(None, "query_only", fail).unwrap();
    }
    pub fn delete(&mut self, id: &str) -> Result<(), AiError> {
        self.delete_many(&[id.to_owned()])
    }
    fn delete_many(&mut self, ids: &[String]) -> Result<(), AiError> {
        if ids.is_empty() {
            return Ok(());
        }
        let transaction = self.db.transaction().map_err(AiError::storage)?;
        for id in ids {
            transaction
                .execute(
                    "UPDATE ai_sessions SET deleted=1,data='',summary='' WHERE id=?1",
                    [id],
                )
                .map_err(AiError::storage)?;
        }
        transaction.commit().map_err(AiError::storage)?;
        // Commit all tombstones first, then purge records and compact once.
        let transaction = self.db.transaction().map_err(AiError::storage)?;
        for id in ids {
            transaction
                .execute("DELETE FROM ai_runs WHERE session_id=?1", [id])
                .map_err(AiError::storage)?;
            transaction
                .execute("DELETE FROM ai_sessions WHERE id=?1 AND deleted=1", [id])
                .map_err(AiError::storage)?;
        }
        transaction.commit().map_err(AiError::storage)?;
        self.compact()
    }
    pub fn clear_conversations(&mut self) -> Result<(), AiError> {
        self.db
            .execute("UPDATE ai_sessions SET deleted=1,data='',summary=''", [])
            .map_err(AiError::storage)?;
        self.db
            .execute_batch("DELETE FROM ai_runs; DELETE FROM ai_sessions;")
            .map_err(AiError::storage)?;
        self.compact()
    }
    pub fn invalidate_source(
        &mut self,
        category: &str,
        delete_related: bool,
    ) -> Result<Vec<String>, AiError> {
        let mut offset = 0;
        let mut affected = Vec::new();
        loop {
            let summaries = self.list(offset, 64)?;
            if summaries.is_empty() {
                break;
            }
            offset += summaries.len() as u32;
            for summary in summaries {
                if !summary
                    .source_categories
                    .iter()
                    .any(|source| source == category)
                {
                    continue;
                }
                if delete_related {
                    affected.push(summary.id);
                    continue;
                }
                let mut session = self.get(&summary.id)?;
                // Propagated assistant summaries can quote older inputs. Block
                // the entire old conversation, not just its evidence attachment.
                for message in &mut session.messages {
                    message.reusable_in_context = false;
                }
                session.summary.revision += 1;
                self.update(&session)?;
                affected.push(summary.id);
            }
        }
        if delete_related {
            self.delete_many(&affected)?;
        }
        Ok(affected)
    }
    pub fn clear_meta(&self) -> Result<(), AiError> {
        self.db
            .execute_batch("DELETE FROM ai_meta;")
            .map_err(AiError::storage)
    }
    fn compact(&self) -> Result<(), AiError> {
        self.db
            .execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .map_err(AiError::storage)
    }
}
fn suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    value.into()
}
fn encode(value: &impl Serialize) -> Result<String, AiError> {
    serde_json::to_string(value).map_err(AiError::storage)
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T, AiError> {
    serde_json::from_str(value).map_err(AiError::storage)
}
fn sql_timestamp(value: u64) -> Result<i64, AiError> {
    i64::try_from(value).map_err(AiError::storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn private_database_rejects_symlink_and_hardlink_targets() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let victim = directory.path().join("victim");
        fs::write(&victim, b"not an AI database").unwrap();
        let linked = directory.path().join("linked.sqlite");
        symlink(&victim, &linked).unwrap();
        assert!(ConversationStore::open(linked).is_err());
        let hard = directory.path().join("hard.sqlite");
        fs::hard_link(&victim, &hard).unwrap();
        assert!(ConversationStore::open(hard).is_err());
        assert_eq!(fs::read(victim).unwrap(), b"not an AI database");
    }
}
