use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::scheduler_core::{CronExpression, LocalCalendarKey, parse_time_zone};
use super::{
    MAX_KEEP_AWAKE_MINUTES, MIN_KEEP_AWAKE_MINUTES, SchedulerAction, SchedulerSnapshot,
    SchedulerTrigger,
};

pub(crate) const SCHEDULE_FILE_NAME: &str = "toolbox-schedules-v1.json";
const SCHEDULE_SCHEMA_VERSION: u16 = 1;
const MAX_SCHEDULE_STORAGE_BYTES: u64 = 256 * 1024;
const MAX_RETAINED_INTENTS: usize = 256;
const MAX_SCHEDULE_RULES: usize = 32;
pub(crate) const MAX_MUTATION_RECEIPTS: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SchedulerStoreState {
    schema_version: u16,
    pub(crate) revision: u64,
    pub(crate) epoch: u64,
    pub(crate) next_rule_sequence: u64,
    pub(crate) rules: Vec<PersistedSchedule>,
    pub(crate) intents: Vec<PersistedExecutionIntent>,
    /// This field is absent from files created before mutation retries were durable. Keeping a
    /// default makes those v1 files readable without changing their schema version.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) mutation_receipts: Vec<PersistedMutationReceipt>,
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
            mutation_receipts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SchedulerMutation {
    Create {
        time_zone: String,
        title: Option<String>,
        action: SchedulerAction,
        trigger: SchedulerTrigger,
    },
    Update {
        schedule_id: String,
        expected_revision: Option<u64>,
        time_zone: String,
        title: Option<String>,
        action: SchedulerAction,
        trigger: SchedulerTrigger,
    },
    Pause {
        schedule_id: String,
        expected_revision: Option<u64>,
    },
    Resume {
        schedule_id: String,
        expected_revision: Option<u64>,
    },
    Delete {
        schedule_id: String,
        expected_revision: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedMutationReceipt {
    pub(crate) request_id: String,
    pub(crate) mutation: SchedulerMutation,
    #[serde(default)]
    pub(crate) epoch: u64,
    pub(crate) acknowledged_revision: u64,
    pub(crate) acknowledged_at_ms: u64,
    pub(crate) acknowledged_snapshot: SchedulerSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MutationWrite<T> {
    Written(T),
    AlreadyAcknowledged { snapshot: SchedulerSnapshot },
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
    RevisionConflict,
    RequestIdConflict,
    StaleMutation,
}

impl fmt::Display for SchedulerStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidAppDataDir => "the scheduler application data directory must be absolute",
            Self::Io => "private scheduler storage I/O failed",
            Self::Serialization => "private scheduler storage serialization failed",
            Self::Corrupt => "the saved schedule rules are invalid",
            Self::InvalidState => "the scheduler state is invalid",
            Self::RevisionConflict => "the scheduler state changed before this update",
            Self::RequestIdConflict => {
                "requestId was already used for a different scheduler mutation"
            }
            Self::StaleMutation => "requestId belongs to a scheduler state that was reset",
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
        let mut state = load_state(&path)?;
        if quarantine_invalid_enabled_rules(&mut state, now_millis()) {
            validate_state(&state)?;
            write_state(&path, &state)?;
        }
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

    /// Return a prior mutation acknowledgement before validating time-sensitive input. A retry
    /// of an already-accepted request must remain safe even when its original occurrence is now
    /// in the past.
    pub(crate) fn mutation_acknowledged(
        &self,
        request_id: &str,
        mutation: &SchedulerMutation,
    ) -> Result<Option<SchedulerSnapshot>, SchedulerStoreError> {
        let Some(receipt) = self
            .state
            .mutation_receipts
            .iter()
            .find(|receipt| receipt.request_id == request_id)
        else {
            return Ok(None);
        };
        if receipt.epoch != self.state.epoch {
            return Err(SchedulerStoreError::StaleMutation);
        }
        if receipt.mutation != *mutation {
            return Err(SchedulerStoreError::RequestIdConflict);
        }
        Ok(Some(receipt.acknowledged_snapshot.clone()))
    }

    /// Apply a scheduler mutation and retain its acknowledgement in the same durable write. A
    /// matching requestId is a retry, while reusing the id for another mutation fails closed.
    pub(crate) fn apply_mutation<T>(
        &mut self,
        request_id: &str,
        mutation: SchedulerMutation,
        now_ms: u64,
        operation: impl FnOnce(&mut SchedulerStoreState) -> Result<T, SchedulerStoreError>,
        acknowledgement: impl FnOnce(
            &SchedulerStoreState,
        ) -> Result<SchedulerSnapshot, SchedulerStoreError>,
    ) -> Result<MutationWrite<T>, SchedulerStoreError> {
        self.transact(|state| {
            if let Some(receipt) = state
                .mutation_receipts
                .iter()
                .find(|receipt| receipt.request_id == request_id)
            {
                if receipt.epoch != state.epoch {
                    return Err(SchedulerStoreError::StaleMutation);
                }
                if receipt.mutation != mutation {
                    return Err(SchedulerStoreError::RequestIdConflict);
                }
                return Ok(MutationWrite::AlreadyAcknowledged {
                    snapshot: receipt.acknowledged_snapshot.clone(),
                });
            }

            let result = operation(state)?;
            let acknowledged_snapshot = acknowledgement(state)?;
            state.mutation_receipts.push(PersistedMutationReceipt {
                request_id: request_id.to_owned(),
                mutation,
                epoch: state.epoch,
                acknowledged_revision: state.revision,
                acknowledged_at_ms: now_ms,
                acknowledged_snapshot,
            });
            let retained_start = state
                .mutation_receipts
                .len()
                .saturating_sub(MAX_MUTATION_RECEIPTS);
            if retained_start > 0 {
                state.mutation_receipts.drain(0..retained_start);
            }
            Ok(MutationWrite::Written(result))
        })
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

    /// A rule whose calculation fails must be durable before the next rule is considered. Its
    /// existing deduplication watermarks remain untouched. If an intent was written before the
    /// failed recalculation, make that not-dispatched intent terminal instead of replayable.
    pub(crate) fn fail_closed_rule(
        &mut self,
        schedule_id: &str,
        intent: Option<(u64, u64, u64)>,
        now_ms: u64,
    ) -> Result<(), SchedulerStoreError> {
        self.transact(|state| {
            let Some(rule) = state
                .rules
                .iter_mut()
                .find(|rule| rule.schedule_id == schedule_id)
            else {
                return Err(SchedulerStoreError::InvalidState);
            };
            if rule.enabled {
                let revision = state.revision.saturating_add(1);
                rule.enabled = false;
                rule.revision = revision;
                rule.updated_at_ms = rule.updated_at_ms.max(now_ms);
                state.revision = revision;
            }

            if let Some((schedule_revision, scheduled_at_utc_ms, epoch)) = intent
                && let Some(intent) = state.intents.iter_mut().find(|intent| {
                    intent.schedule_id == schedule_id
                        && intent.schedule_revision == schedule_revision
                        && intent.scheduled_at_utc_ms == scheduled_at_utc_ms
                        && intent.epoch == epoch
                })
                && intent.state == PersistedIntentState::Intended
            {
                intent.state = PersistedIntentState::Failed;
                intent.updated_at_ms = now_ms;
            }
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
    validate_state_shape(&state).map_err(|_| SchedulerStoreError::Corrupt)?;
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
    validate_state_shape(state)?;
    for rule in state.rules.iter().filter(|rule| rule.enabled) {
        validate_rule_for_activation(rule)?;
    }
    Ok(())
}

/// Validate state that cannot be repaired by disabling a single rule. Definition and next-run
/// errors are intentionally handled separately so one persisted bad rule can be paused without
/// hiding the other rules from the user.
fn validate_state_shape(state: &SchedulerStoreState) -> Result<(), SchedulerStoreError> {
    if state.schema_version != SCHEDULE_SCHEMA_VERSION
        || state.rules.len() > MAX_SCHEDULE_RULES
        || state.intents.len() > MAX_RETAINED_INTENTS
        || state.mutation_receipts.len() > MAX_MUTATION_RECEIPTS
    {
        return Err(SchedulerStoreError::InvalidState);
    }
    let mut schedule_ids = HashSet::new();
    for rule in &state.rules {
        if rule.schedule_id.is_empty()
            || rule.schedule_id.len() > 64
            || rule.time_zone.len() > 128
            || rule
                .title
                .as_ref()
                .is_some_and(|title| title.chars().count() > 80)
            || rule.revision == 0
            || rule.revision > state.revision
            || rule.created_at_ms > rule.updated_at_ms
            || !schedule_ids.insert(&rule.schedule_id)
        {
            return Err(SchedulerStoreError::InvalidState);
        }
    }
    let mut intent_keys = HashSet::new();
    for intent in &state.intents {
        if intent.schedule_id.is_empty()
            || intent.schedule_id.len() > 64
            || !timestamp_is_supported(intent.scheduled_at_utc_ms)
            || intent.created_at_ms > intent.updated_at_ms
            || !intent_keys.insert((
                &intent.schedule_id,
                intent.schedule_revision,
                intent.scheduled_at_utc_ms,
                intent.epoch,
            ))
        {
            return Err(SchedulerStoreError::InvalidState);
        }
    }
    let mut request_ids = HashSet::new();
    if state.mutation_receipts.iter().any(|receipt| {
        receipt.request_id.trim().is_empty()
            || receipt.request_id.len() > 128
            || receipt.acknowledged_revision > state.revision
            || !request_ids.insert(&receipt.request_id)
    }) {
        return Err(SchedulerStoreError::InvalidState);
    }
    Ok(())
}

/// An enabled rule must be executable from its durable definition. A paused rule is allowed to
/// retain the bad definition so it is visible, editable, and fail-closed after recovery.
pub(crate) fn validate_rule_for_activation(
    rule: &PersistedSchedule,
) -> Result<(), SchedulerStoreError> {
    validate_rule_definition(rule)?;
    let Some(next_scheduled_at_utc_ms) = rule.next_scheduled_at_utc_ms else {
        return Err(SchedulerStoreError::InvalidState);
    };
    if !timestamp_is_supported(next_scheduled_at_utc_ms)
        || rule
            .last_processed_at_utc_ms
            .is_some_and(|at_ms| !timestamp_is_supported(at_ms))
        || (rule.last_processed_at_utc_ms.is_some() != rule.last_processed_local_key.is_some())
        || rule
            .last_processed_local_key
            .as_ref()
            .is_some_and(|key| !local_calendar_key_is_valid(key))
    {
        return Err(SchedulerStoreError::InvalidState);
    }
    if let PersistedSchedulerTrigger::Once { at_utc_ms } = rule.trigger
        && next_scheduled_at_utc_ms != at_utc_ms
    {
        return Err(SchedulerStoreError::InvalidState);
    }
    Ok(())
}

/// Resume reuses the definition checks but recomputes the next occurrence atomically, so a
/// paused one-time rule with no next run still reaches its existing `schedule_expired` outcome.
pub(crate) fn validate_rule_definition(
    rule: &PersistedSchedule,
) -> Result<(), SchedulerStoreError> {
    parse_time_zone(&rule.time_zone).map_err(|_| SchedulerStoreError::InvalidState)?;
    match rule.action {
        PersistedSchedulerAction::Reminder => {}
        PersistedSchedulerAction::KeepAwake { duration_minutes }
            if (MIN_KEEP_AWAKE_MINUTES..=MAX_KEEP_AWAKE_MINUTES).contains(&duration_minutes) => {}
        PersistedSchedulerAction::KeepAwake { .. } => {
            return Err(SchedulerStoreError::InvalidState);
        }
    }
    match &rule.trigger {
        PersistedSchedulerTrigger::Once { at_utc_ms } if timestamp_is_supported(*at_utc_ms) => {}
        PersistedSchedulerTrigger::Once { .. } => return Err(SchedulerStoreError::InvalidState),
        PersistedSchedulerTrigger::Daily { hour, minute } if *hour <= 23 && *minute <= 59 => {}
        PersistedSchedulerTrigger::Daily { .. } => return Err(SchedulerStoreError::InvalidState),
        PersistedSchedulerTrigger::Weekly {
            weekday,
            hour,
            minute,
        } if *weekday <= 6 && *hour <= 23 && *minute <= 59 => {}
        PersistedSchedulerTrigger::Weekly { .. } => return Err(SchedulerStoreError::InvalidState),
        PersistedSchedulerTrigger::Cron { expression } => {
            CronExpression::parse(expression).map_err(|_| SchedulerStoreError::InvalidState)?;
        }
    }
    Ok(())
}

fn quarantine_invalid_enabled_rules(state: &mut SchedulerStoreState, now_ms: u64) -> bool {
    let mut changed = false;
    for rule in &mut state.rules {
        if rule.enabled && validate_rule_for_activation(rule).is_err() {
            let revision = state.revision.saturating_add(1);
            rule.enabled = false;
            rule.revision = revision;
            rule.updated_at_ms = rule.updated_at_ms.max(now_ms);
            state.revision = revision;
            changed = true;
        }
    }
    changed
}

fn timestamp_is_supported(timestamp_ms: u64) -> bool {
    i64::try_from(timestamp_ms).is_ok()
}

fn local_calendar_key_is_valid(key: &LocalCalendarKey) -> bool {
    chrono::NaiveDate::from_ymd_opt(key.year, key.month, key.day)
        .is_some_and(|date| date.and_hms_opt(key.hour, key.minute, 0).is_some())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
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

    fn active_rule() -> PersistedSchedule {
        PersistedSchedule {
            schedule_id: "schedule-1".to_owned(),
            revision: 1,
            title: None,
            time_zone: "Etc/UTC".to_owned(),
            action: PersistedSchedulerAction::Reminder,
            trigger: PersistedSchedulerTrigger::Daily {
                hour: 9,
                minute: 30,
            },
            enabled: true,
            next_scheduled_at_utc_ms: Some(1_000),
            last_processed_at_utc_ms: None,
            last_processed_local_key: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn rejects_enabled_rules_with_invalid_execution_semantics() {
        let valid_state = || SchedulerStoreState {
            revision: 1,
            rules: vec![active_rule()],
            ..SchedulerStoreState::default()
        };

        let mut missing_next_run = valid_state();
        missing_next_run.rules[0].next_scheduled_at_utc_ms = None;
        assert_eq!(
            validate_state(&missing_next_run),
            Err(SchedulerStoreError::InvalidState)
        );

        let mut invalid_zone = valid_state();
        invalid_zone.rules[0].time_zone = "Not/AZone".to_owned();
        assert_eq!(
            validate_state(&invalid_zone),
            Err(SchedulerStoreError::InvalidState)
        );

        let mut invalid_cron = valid_state();
        invalid_cron.rules[0].trigger = PersistedSchedulerTrigger::Cron {
            expression: "not cron".to_owned(),
        };
        assert_eq!(
            validate_state(&invalid_cron),
            Err(SchedulerStoreError::InvalidState)
        );

        let mut invalid_action = valid_state();
        invalid_action.rules[0].action = PersistedSchedulerAction::KeepAwake {
            duration_minutes: 0,
        };
        assert_eq!(
            validate_state(&invalid_action),
            Err(SchedulerStoreError::InvalidState)
        );
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
    fn reads_existing_v1_state_without_mutation_receipts() {
        let directory = tempdir().expect("private test directory");
        let path = directory.path().join(SCHEDULE_FILE_NAME);
        let legacy = serde_json::to_value(SchedulerStoreState::default())
            .expect("serialize legacy v1 state");
        assert!(legacy.get("mutationReceipts").is_none());
        std::fs::write(
            &path,
            serde_json::to_vec(&legacy).expect("encode legacy v1 state"),
        )
        .expect("own test fixture");

        let store = SchedulerStore::open(directory.path()).expect("read legacy v1 state");
        assert!(store.state().mutation_receipts.is_empty());
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
