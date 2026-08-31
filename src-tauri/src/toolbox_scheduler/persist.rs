use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::scheduler_core::LocalCalendarKey;

pub(crate) const SCHEDULE_FILE_NAME: &str = "toolbox-schedules-v1.json";
const SCHEDULE_SCHEMA_VERSION: u16 = 1;
const MAX_SCHEDULE_STORAGE_BYTES: u64 = 256 * 1024;
const MAX_RETAINED_INTENTS: usize = 256;
const MAX_SCHEDULE_RULES: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SchedulerStoreState {
    schema_version: u16,
    pub(crate) revision: u64,
    pub(crate) epoch: u64,
    pub(crate) next_rule_sequence: u64,
    pub(crate) rules: Vec<PersistedSchedule>,
    pub(crate) intents: Vec<PersistedExecutionIntent>,
}
impl Default for SchedulerStoreState {
    fn default() -> Self {
        Self {
            schema_version: SCHEDULE_SCHEMA_VERSION,
            revision: 0,
            epoch: 0,
            next_rule_sequence: 0,
            rules: Vec::new(),
            intents: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedSchedule {
    pub(crate) schedule_id: String,
    pub(crate) revision: u64,
    pub(crate) title: Option<String>,
    pub(crate) time_zone: String,
    pub(crate) action: PersistedSchedulerAction,
    pub(crate) trigger: PersistedSchedulerTrigger,
    pub(crate) enabled: bool,
    pub(crate) next_scheduled_at_utc_ms: Option<u64>,
    pub(crate) last_processed_at_utc_ms: Option<u64>,
    pub(crate) last_processed_local_key: Option<LocalCalendarKey>,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum PersistedSchedulerAction {
    Reminder,
    KeepAwake { duration_minutes: u16 },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum PersistedSchedulerTrigger {
    Once { at_utc_ms: u64 },
    Daily { hour: u8, minute: u8 },
    Weekly { weekday: u8, hour: u8, minute: u8 },
    Cron { expression: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedExecutionIntent {
    pub(crate) schedule_id: String,
    pub(crate) schedule_revision: u64,
    pub(crate) scheduled_at_utc_ms: u64,
    pub(crate) local_key: Option<LocalCalendarKey>,
    pub(crate) epoch: u64,
    pub(crate) state: PersistedIntentState,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PersistedIntentState {
    Intended,
    Submitted,
    Skipped,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IntentWrite {
    Written,
    AlreadyRecorded,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SchedulerStoreError {
    InvalidAppDataDir,
    Io,
    Serialization,
    Corrupt,
    InvalidState,
}

impl fmt::Display for SchedulerStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidAppDataDir => "the scheduler application data directory must be absolute",
            Self::Io => "private scheduler storage I/O failed",
            Self::Serialization => "private scheduler storage serialization failed",
            Self::Corrupt => "the saved schedule rules are invalid",
            Self::InvalidState => "the scheduler state is invalid",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SchedulerStoreError {}

/// The schedule configuration is a separate, explicitly saved file. It never follows the
/// history preference, and every mutation writes a complete candidate before memory acknowledges
/// the new revision.
#[derive(Debug)]
pub(crate) struct SchedulerStore {
    path: PathBuf,
    state: SchedulerStoreState,
}

impl SchedulerStore {
    pub(crate) fn open(app_data_dir: impl Into<PathBuf>) -> Result<Self, SchedulerStoreError> {
        let app_data_dir = app_data_dir.into();
        if !app_data_dir.is_absolute() {
            return Err(SchedulerStoreError::InvalidAppDataDir);
        }
        let path = app_data_dir.join(SCHEDULE_FILE_NAME);
        let state = load_state(&path)?;
        Ok(Self { path, state })
    }

    pub(crate) fn state(&self) -> &SchedulerStoreState {
        &self.state
    }

    /// Run a mutation against a cloned candidate and atomically acknowledge it only after the
    /// complete v1 file is durable. `operation` must not dispatch an external action.
    pub(crate) fn transact<T>(
        &mut self,
        operation: impl FnOnce(&mut SchedulerStoreState) -> Result<T, SchedulerStoreError>,
    ) -> Result<T, SchedulerStoreError> {
        let mut candidate = self.state.clone();
        let result = operation(&mut candidate)?;
        validate_state(&candidate)?;
        write_state(&self.path, &candidate)?;
        self.state = candidate;
        Ok(result)
    }

    pub(crate) fn record_intent(
        &mut self,
        mut intent: PersistedExecutionIntent,
        now_ms: u64,
    ) -> Result<IntentWrite, SchedulerStoreError> {
        self.transact(|state| {
            if state.intents.iter().any(|existing| {
                existing.schedule_id == intent.schedule_id
                    && existing.schedule_revision == intent.schedule_revision
                    && existing.scheduled_at_utc_ms == intent.scheduled_at_utc_ms
                    && existing.epoch == intent.epoch
            }) {
                return Ok(IntentWrite::AlreadyRecorded);
            }
            intent.created_at_ms = now_ms;
            intent.updated_at_ms = now_ms;
            state.intents.push(intent);
            state.intents.sort_by(|left, right| {
                left.updated_at_ms
                    .cmp(&right.updated_at_ms)
                    .then_with(|| left.scheduled_at_utc_ms.cmp(&right.scheduled_at_utc_ms))
            });
            let retained_start = state.intents.len().saturating_sub(MAX_RETAINED_INTENTS);
            if retained_start > 0 {
                state.intents.drain(0..retained_start);
            }
            Ok(IntentWrite::Written)
        })
    }

    pub(crate) fn mark_intent(
        &mut self,
        schedule_id: &str,
        schedule_revision: u64,
        scheduled_at_utc_ms: u64,
        epoch: u64,
        state: PersistedIntentState,
        now_ms: u64,
    ) -> Result<(), SchedulerStoreError> {
        self.transact(|candidate| {
            let Some(intent) = candidate.intents.iter_mut().find(|intent| {
                intent.schedule_id == schedule_id
                    && intent.schedule_revision == schedule_revision
                    && intent.scheduled_at_utc_ms == scheduled_at_utc_ms
                    && intent.epoch == epoch
            }) else {
                return Err(SchedulerStoreError::InvalidState);
            };
            intent.state = state;
            intent.updated_at_ms = now_ms;
            Ok(())
        })
    }
}

fn load_state(path: &Path) -> Result<SchedulerStoreState, SchedulerStoreError> {
    let existed_before_read = path.exists();
    let Some(bytes) = crate::private_storage::read_limited(path, MAX_SCHEDULE_STORAGE_BYTES)
        .map_err(|_| SchedulerStoreError::Io)?
    else {
        return if existed_before_read {
            Err(SchedulerStoreError::Corrupt)
        } else {
            Ok(SchedulerStoreState::default())
        };
    };
    let state = serde_json::from_slice::<SchedulerStoreState>(&bytes)
        .map_err(|_| SchedulerStoreError::Corrupt)?;
    validate_state(&state).map_err(|_| SchedulerStoreError::Corrupt)?;
    Ok(state)
}

fn write_state(path: &Path, state: &SchedulerStoreState) -> Result<(), SchedulerStoreError> {
    let bytes = serde_json::to_vec(state).map_err(|_| SchedulerStoreError::Serialization)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SCHEDULE_STORAGE_BYTES {
        return Err(SchedulerStoreError::InvalidState);
    }
    crate::private_storage::write_atomic(path, &bytes).map_err(|_| SchedulerStoreError::Io)
}

fn validate_state(state: &SchedulerStoreState) -> Result<(), SchedulerStoreError> {
    if state.schema_version != SCHEDULE_SCHEMA_VERSION
        || state.rules.len() > MAX_SCHEDULE_RULES
        || state.intents.len() > MAX_RETAINED_INTENTS
    {
        return Err(SchedulerStoreError::InvalidState);
    }
    for rule in &state.rules {
        if rule.schedule_id.is_empty()
            || rule.schedule_id.len() > 64
            || rule.time_zone.is_empty()
            || rule.time_zone.len() > 128
            || rule
                .title
                .as_ref()
                .is_some_and(|title| title.chars().count() > 80)
        {
            return Err(SchedulerStoreError::InvalidState);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn intent() -> PersistedExecutionIntent {
        PersistedExecutionIntent {
            schedule_id: "schedule-1".to_owned(),
            schedule_revision: 3,
            scheduled_at_utc_ms: 1_000,
            local_key: None,
            epoch: 2,
            state: PersistedIntentState::Intended,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn records_execution_intent_before_any_action_and_survives_reopen() {
        let directory = tempdir().expect("private test directory");
        let mut store = SchedulerStore::open(directory.path()).expect("open empty store");
        assert_eq!(
            store
                .record_intent(intent(), 10)
                .expect("atomic intent write"),
            IntentWrite::Written
        );
        assert_eq!(
            store
                .record_intent(intent(), 11)
                .expect("deduplicated retry"),
            IntentWrite::AlreadyRecorded
        );
        drop(store);

        let reopened = SchedulerStore::open(directory.path()).expect("reopen durable state");
        assert_eq!(reopened.state().intents.len(), 1);
        assert_eq!(
            reopened.state().intents[0].state,
            PersistedIntentState::Intended
        );
    }

    #[test]
    fn rejects_corrupt_saved_configuration_instead_of_starting_old_rules() {
        let directory = tempdir().expect("private test directory");
        let path = directory.path().join(SCHEDULE_FILE_NAME);
        std::fs::write(&path, b"not-json").expect("own test fixture");
        assert_eq!(
            SchedulerStore::open(directory.path())
                .expect_err("corrupt state disables scheduling")
                .to_string(),
            "the saved schedule rules are invalid"
        );
    }

    #[test]
    fn failed_candidate_mutation_never_acknowledges_a_new_state() {
        let directory = tempdir().expect("private test directory");
        let mut store = SchedulerStore::open(directory.path()).expect("open empty store");
        let result = store.transact::<()>(|state| {
            state.revision = 1;
            Err(SchedulerStoreError::InvalidState)
        });
        assert_eq!(
            result.expect_err("candidate rejected"),
            SchedulerStoreError::InvalidState
        );
        assert_eq!(store.state().revision, 0);
    }
}
