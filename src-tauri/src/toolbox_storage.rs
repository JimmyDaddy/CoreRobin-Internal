//! Private policy and minimal completion history for the toolbox service.
//!
//! This module deliberately owns no Tauri commands and is not registered from
//! `lib.rs`.  The main service supplies the real application data directory
//! and is responsible for stopping/releasing work before calling reset APIs.
//! All persistence goes through `crate::private_storage`; there is no second
//! SQLite, browser storage, or input-derived authority here.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::private_storage;

pub const POLICY_SCHEMA_VERSION: u16 = 1;
pub const STATE_SCHEMA_VERSION: u16 = 1;
pub const POLICY_FILE_NAME: &str = "toolbox-policy-v1.json";
pub const STATE_FILE_NAME: &str = "toolbox-state-v1.json";
pub const MAX_HISTORY_ENTRIES: usize = 100;
pub const MAX_HISTORY_PAGE: usize = 50;
pub const MIN_RETENTION_DAYS: u8 = 1;
pub const MAX_RETENTION_DAYS: u8 = 7;
pub const DEFAULT_RETENTION_DAYS: u8 = MAX_RETENTION_DAYS;
pub const DEFAULT_LANGUAGE: &str = "zh-CN";

const MAX_STORAGE_BYTES: u64 = 256 * 1024;
const MAX_ACTIVE_ACTIVITY_IDS: usize = 128;
const DAY_MILLIS: u64 = 86_400_000;
const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh-CN", "en", "zh-Hant", "ja", "de", "fr", "es", "pt-BR", "ko", "ru",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolboxPolicy {
    pub schema_version: u16,
    pub policy_revision: u64,
    pub global_history_enabled: bool,
    pub toolbox_history_enabled: bool,
    pub retention_days: u8,
    pub notifications_enabled: bool,
    pub language: String,
}

impl Default for ToolboxPolicy {
    fn default() -> Self {
        Self {
            schema_version: POLICY_SCHEMA_VERSION,
            policy_revision: 0,
            global_history_enabled: false,
            toolbox_history_enabled: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            notifications_enabled: false,
            language: DEFAULT_LANGUAGE.to_owned(),
        }
    }
}

impl ToolboxPolicy {
    pub fn history_enabled(&self) -> bool {
        self.global_history_enabled && self.toolbox_history_enabled
    }

    fn validate(&self) -> Result<(), ToolboxStorageError> {
        if self.schema_version != POLICY_SCHEMA_VERSION {
            return Err(ToolboxStorageError::InvalidPolicy);
        }
        if !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&self.retention_days) {
            return Err(ToolboxStorageError::InvalidRetentionDays);
        }
        if !SUPPORTED_LANGUAGES.contains(&self.language.as_str()) {
            return Err(ToolboxStorageError::UnsupportedLanguage);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolboxPolicyConfigureRequest {
    pub expected_policy_revision: u64,
    pub global_history_enabled: bool,
    pub toolbox_history_enabled: bool,
    pub retention_days: u8,
    pub notifications_enabled: bool,
    pub language: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ToolboxSystemTool {
    KeepAwake,
    ProcessWatch,
    FileOccupancy,
    VolumeOccupancy,
    KeyboardCleaning,
    NetworkAddresses,
    IfconfigParser,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolboxTerminalStatus {
    Completed,
    Cancelled,
    Expired,
    Failed,
    Interrupted,
    Deadline,
    ProcessExited,
    LowBattery,
    ReleaseUnconfirmed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolboxNotificationStatus {
    Submitted,
    Failed,
    Unavailable,
}

/// The only completion data this provider accepts.  In particular, this
/// structure has no title, path, pid, hash, command line, or input field.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolboxCompletionRecord {
    pub record_id: String,
    pub tool: ToolboxSystemTool,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub terminal_status: ToolboxTerminalStatus,
    pub notification_status: ToolboxNotificationStatus,
}

impl ToolboxCompletionRecord {
    fn validate(&self) -> Result<(), ToolboxStorageError> {
        validate_opaque_id(&self.record_id)?;
        if self.completed_at_ms < self.started_at_ms {
            return Err(ToolboxStorageError::InvalidRecord);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedToolboxState {
    schema_version: u16,
    reset_epoch: u64,
    history_revision: u64,
    active_activity_ids: Vec<String>,
    history: Vec<ToolboxCompletionRecord>,
}

impl Default for PersistedToolboxState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            reset_epoch: 0,
            history_revision: 0,
            active_activity_ids: Vec::new(),
            history: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxStorageSnapshot {
    pub policy: ToolboxPolicy,
    pub reset_epoch: u64,
    pub history_revision: u64,
    pub active_activity_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RecordCompletionOutcome {
    Stored { history_revision: u64 },
    AlreadyPresent { history_revision: u64 },
    SkippedBecauseDisabled { history_revision: u64 },
    SkippedBecauseExpired { history_revision: u64 },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxHistoryPage {
    pub records: Vec<ToolboxCompletionRecord>,
    pub next_cursor: Option<String>,
    pub history_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolboxStorageError {
    InvalidAppDataDir,
    Io,
    Serialization,
    InvalidPolicy,
    InvalidRetentionDays,
    UnsupportedLanguage,
    PolicyRevisionConflict { expected: u64, actual: u64 },
    HistoryRevisionConflict { expected: u64, actual: u64 },
    InvalidCursor,
    InvalidRecord,
    DuplicateRecord,
    ResetEpochMismatch { expected: u64, actual: u64 },
    ResetEpochMustAdvance,
}

impl fmt::Display for ToolboxStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidAppDataDir => "the application data directory must be absolute",
            Self::Io => "private toolbox storage I/O failed",
            Self::Serialization => "private toolbox storage serialization failed",
            Self::InvalidPolicy => "the toolbox policy is invalid",
            Self::InvalidRetentionDays => "retention days must be between one and seven",
            Self::UnsupportedLanguage => "the toolbox language is not supported",
            Self::PolicyRevisionConflict { .. } => "the toolbox policy revision is stale",
            Self::HistoryRevisionConflict { .. } => "the toolbox history revision is stale",
            Self::InvalidCursor => "the toolbox history cursor is invalid",
            Self::InvalidRecord => "the toolbox completion record is invalid",
            Self::DuplicateRecord => "the toolbox completion record ID is already in use",
            Self::ResetEpochMismatch { .. } => "the toolbox reset epoch is stale",
            Self::ResetEpochMustAdvance => "the toolbox reset epoch must advance",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ToolboxStorageError {}

/// Private native storage owned by the main toolbox service.
#[allow(dead_code)]
pub struct ToolboxStorage {
    app_data_dir: PathBuf,
    policy_path: PathBuf,
    state_path: PathBuf,
    policy: ToolboxPolicy,
    state: PersistedToolboxState,
}

#[allow(dead_code)]
impl ToolboxStorage {
    /// Open storage rooted at the real native application data directory.
    /// Frontend-provided paths must not be passed here.
    pub fn open(app_data_dir: impl Into<PathBuf>) -> Result<Self, ToolboxStorageError> {
        let app_data_dir = app_data_dir.into();
        if !app_data_dir.is_absolute() {
            return Err(ToolboxStorageError::InvalidAppDataDir);
        }

        let policy_path = app_data_dir.join(POLICY_FILE_NAME);
        let state_path = app_data_dir.join(STATE_FILE_NAME);
        let policy = load_policy(&policy_path)?;
        let state = load_state(&state_path)?;

        Ok(Self {
            app_data_dir,
            policy_path,
            state_path,
            policy,
            state,
        })
    }

    pub fn new(app_data_dir: impl Into<PathBuf>) -> Result<Self, ToolboxStorageError> {
        Self::open(app_data_dir)
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn policy(&self) -> &ToolboxPolicy {
        &self.policy
    }

    pub fn reset_epoch(&self) -> u64 {
        self.state.reset_epoch
    }

    pub fn history_revision(&self) -> u64 {
        self.state.history_revision
    }

    pub fn active_activity_ids(&self) -> &[String] {
        &self.state.active_activity_ids
    }

    pub fn snapshot(&self) -> ToolboxStorageSnapshot {
        ToolboxStorageSnapshot {
            policy: self.policy.clone(),
            reset_epoch: self.state.reset_epoch,
            history_revision: self.state.history_revision,
            active_activity_ids: self.state.active_activity_ids.clone(),
        }
    }

    pub fn check_reset_epoch(&self, expected_reset_epoch: u64) -> Result<(), ToolboxStorageError> {
        if expected_reset_epoch == self.state.reset_epoch {
            Ok(())
        } else {
            Err(ToolboxStorageError::ResetEpochMismatch {
                expected: expected_reset_epoch,
                actual: self.state.reset_epoch,
            })
        }
    }

    /// Atomically persist a candidate policy before changing the in-memory
    /// effective policy.  A failed write therefore leaves the old policy and
    /// revision authoritative.
    pub fn configure_policy(
        &mut self,
        request: ToolboxPolicyConfigureRequest,
    ) -> Result<ToolboxPolicy, ToolboxStorageError> {
        if request.expected_policy_revision != self.policy.policy_revision {
            return Err(ToolboxStorageError::PolicyRevisionConflict {
                expected: request.expected_policy_revision,
                actual: self.policy.policy_revision,
            });
        }

        let policy_revision = self
            .policy
            .policy_revision
            .checked_add(1)
            .ok_or(ToolboxStorageError::InvalidPolicy)?;
        let candidate = ToolboxPolicy {
            schema_version: POLICY_SCHEMA_VERSION,
            policy_revision,
            global_history_enabled: request.global_history_enabled,
            toolbox_history_enabled: request.toolbox_history_enabled,
            retention_days: request.retention_days,
            notifications_enabled: request.notifications_enabled,
            language: request.language,
        };
        candidate.validate()?;

        let bytes = serde_json::to_vec_pretty(&candidate)
            .map_err(|_| ToolboxStorageError::Serialization)?;
        private_storage::write_atomic(&self.policy_path, &bytes)
            .map_err(|_| ToolboxStorageError::Io)?;
        self.policy = candidate.clone();
        Ok(candidate)
    }

    /// Record only a minimal terminal result.  The caller must supply the
    /// current epoch and monotonic lifecycle coordinator; this module never
    /// stops another job or reaches across service modules.
    pub fn record_completion(
        &mut self,
        expected_reset_epoch: u64,
        record: ToolboxCompletionRecord,
        now_ms: u64,
    ) -> Result<RecordCompletionOutcome, ToolboxStorageError> {
        self.check_reset_epoch(expected_reset_epoch)?;
        record.validate()?;

        if !self.policy.history_enabled() {
            return Ok(RecordCompletionOutcome::SkippedBecauseDisabled {
                history_revision: self.state.history_revision,
            });
        }

        if let Some(existing) = self
            .state
            .history
            .iter()
            .find(|existing| existing.record_id == record.record_id)
        {
            if existing == &record {
                return Ok(RecordCompletionOutcome::AlreadyPresent {
                    history_revision: self.state.history_revision,
                });
            }
            return Err(ToolboxStorageError::DuplicateRecord);
        }

        let mut candidate_state = self.state.clone();
        let changed_by_prune = prune_history(
            &mut candidate_state.history,
            now_ms,
            self.policy.retention_days,
        );
        let cutoff = retention_cutoff(now_ms, self.policy.retention_days);
        if record.completed_at_ms < cutoff {
            if changed_by_prune {
                candidate_state.history_revision = next_revision(candidate_state.history_revision)?;
                self.persist_state(&candidate_state)?;
                self.state = candidate_state;
            }
            return Ok(RecordCompletionOutcome::SkippedBecauseExpired {
                history_revision: self.state.history_revision,
            });
        }

        candidate_state.history.push(record);
        sort_history(&mut candidate_state.history);
        candidate_state.history.truncate(MAX_HISTORY_ENTRIES);
        candidate_state.history_revision = next_revision(self.state.history_revision)?;
        self.persist_state(&candidate_state)?;
        self.state = candidate_state;
        Ok(RecordCompletionOutcome::Stored {
            history_revision: self.state.history_revision,
        })
    }

    /// Replace the small set of active opaque IDs without touching history.
    /// This is useful for restart/clear-history snapshots and intentionally
    /// does not accept session details, paths, handles, or process identity.
    pub fn replace_active_activity_ids(
        &mut self,
        expected_reset_epoch: u64,
        activity_ids: Vec<String>,
    ) -> Result<(), ToolboxStorageError> {
        self.check_reset_epoch(expected_reset_epoch)?;
        validate_activity_ids(&activity_ids)?;
        let mut candidate_state = self.state.clone();
        candidate_state.active_activity_ids = activity_ids;
        self.persist_state(&candidate_state)?;
        self.state = candidate_state;
        Ok(())
    }

    pub fn list_history(
        &mut self,
        limit: usize,
        cursor: Option<&str>,
        now_ms: u64,
    ) -> Result<ToolboxHistoryPage, ToolboxStorageError> {
        let requested_limit = limit.min(MAX_HISTORY_PAGE);
        if requested_limit == 0 {
            return Err(ToolboxStorageError::InvalidCursor);
        }

        let mut candidate_state = self.state.clone();
        if prune_history(
            &mut candidate_state.history,
            now_ms,
            self.policy.retention_days,
        ) {
            candidate_state.history_revision = next_revision(self.state.history_revision)?;
            self.persist_state(&candidate_state)?;
            self.state = candidate_state;
        }

        let offset = match cursor {
            None => 0,
            Some(cursor) => decode_cursor(cursor, self.state.history_revision)?,
        };
        if offset > self.state.history.len() {
            return Err(ToolboxStorageError::InvalidCursor);
        }
        let records = self
            .state
            .history
            .iter()
            .skip(offset)
            .take(requested_limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(records.len());
        let next_cursor = (next_offset < self.state.history.len())
            .then(|| encode_cursor(self.state.history_revision, next_offset));

        Ok(ToolboxHistoryPage {
            records,
            next_cursor,
            history_revision: self.state.history_revision,
        })
    }

    /// Clear history only.  Policy, reset epoch, and active activity IDs are
    /// retained, so callers can clear the page without cancelling work.
    pub fn clear_history(
        &mut self,
        expected_history_revision: Option<u64>,
    ) -> Result<ToolboxHistoryPage, ToolboxStorageError> {
        if let Some(expected) = expected_history_revision
            && expected != self.state.history_revision
        {
            return Err(ToolboxStorageError::HistoryRevisionConflict {
                expected,
                actual: self.state.history_revision,
            });
        }
        let mut candidate_state = self.state.clone();
        candidate_state.history.clear();
        candidate_state.history_revision = next_revision(self.state.history_revision)?;
        self.persist_state(&candidate_state)?;
        self.state = candidate_state;
        Ok(ToolboxHistoryPage {
            records: Vec::new(),
            next_cursor: None,
            history_revision: self.state.history_revision,
        })
    }

    /// Clear persisted history and policy after the main service has stopped
    /// and released all actions.  This method only validates the epoch and
    /// storage; it never performs cross-module stopping or cancellation.
    pub fn clear_all_after_stop(
        &mut self,
        expected_reset_epoch: u64,
        next_reset_epoch: u64,
    ) -> Result<ToolboxStorageSnapshot, ToolboxStorageError> {
        self.check_reset_epoch(expected_reset_epoch)?;
        if next_reset_epoch <= self.state.reset_epoch {
            return Err(ToolboxStorageError::ResetEpochMustAdvance);
        }

        // A reset must invalidate cursors from the old state even when the
        // default history revision was zero.
        let candidate_state = PersistedToolboxState {
            reset_epoch: next_reset_epoch,
            history_revision: next_revision(self.state.history_revision)?,
            ..PersistedToolboxState::default()
        };
        self.persist_state(&candidate_state)?;

        // An absent policy file is the durable default.  Removing it after
        // the cleared state is safely persisted means a failed removal does
        // not resurrect the old history or epoch.
        private_storage::remove(&self.policy_path).map_err(|_| ToolboxStorageError::Io)?;
        self.state = candidate_state;
        self.policy = ToolboxPolicy::default();
        Ok(self.snapshot())
    }

    fn persist_state(&self, state: &PersistedToolboxState) -> Result<(), ToolboxStorageError> {
        let bytes =
            serde_json::to_vec_pretty(state).map_err(|_| ToolboxStorageError::Serialization)?;
        private_storage::write_atomic(&self.state_path, &bytes).map_err(|_| ToolboxStorageError::Io)
    }
}

#[cfg(test)]
#[path = "toolbox_storage_tests.rs"]
mod storage_tests;

fn load_policy(path: &Path) -> Result<ToolboxPolicy, ToolboxStorageError> {
    let Some(bytes) = private_storage::read_limited(path, MAX_STORAGE_BYTES)
        .map_err(|_| ToolboxStorageError::Io)?
    else {
        return Ok(ToolboxPolicy::default());
    };
    let Ok(policy) = serde_json::from_slice::<ToolboxPolicy>(&bytes) else {
        return Ok(ToolboxPolicy::default());
    };
    if policy.validate().is_err() {
        return Ok(ToolboxPolicy::default());
    }
    Ok(policy)
}

fn load_state(path: &Path) -> Result<PersistedToolboxState, ToolboxStorageError> {
    let Some(bytes) = private_storage::read_limited(path, MAX_STORAGE_BYTES)
        .map_err(|_| ToolboxStorageError::Io)?
    else {
        return Ok(PersistedToolboxState::default());
    };
    let Ok(mut state) = serde_json::from_slice::<PersistedToolboxState>(&bytes) else {
        return Ok(PersistedToolboxState::default());
    };
    if sanitize_state(&mut state).is_err() {
        return Ok(PersistedToolboxState::default());
    }
    Ok(state)
}

fn sanitize_state(state: &mut PersistedToolboxState) -> Result<(), ToolboxStorageError> {
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(ToolboxStorageError::InvalidPolicy);
    }
    validate_activity_ids(&state.active_activity_ids)?;
    for record in &state.history {
        record.validate()?;
    }
    sort_history(&mut state.history);
    state.history.truncate(MAX_HISTORY_ENTRIES);
    Ok(())
}

fn validate_activity_ids(activity_ids: &[String]) -> Result<(), ToolboxStorageError> {
    if activity_ids.len() > MAX_ACTIVE_ACTIVITY_IDS {
        return Err(ToolboxStorageError::InvalidRecord);
    }
    for id in activity_ids {
        validate_opaque_id(id)?;
    }
    Ok(())
}

fn validate_opaque_id(id: &str) -> Result<(), ToolboxStorageError> {
    if id.is_empty() || id.len() > 128 || !id.is_ascii() {
        return Err(ToolboxStorageError::InvalidRecord);
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(ToolboxStorageError::InvalidRecord);
    }
    Ok(())
}

fn retention_cutoff(now_ms: u64, retention_days: u8) -> u64 {
    now_ms.saturating_sub(u64::from(retention_days) * DAY_MILLIS)
}

fn prune_history(
    history: &mut Vec<ToolboxCompletionRecord>,
    now_ms: u64,
    retention_days: u8,
) -> bool {
    let cutoff = retention_cutoff(now_ms, retention_days);
    let before = history.len();
    history.retain(|record| record.completed_at_ms >= cutoff);
    sort_history(history);
    history.truncate(MAX_HISTORY_ENTRIES);
    history.len() != before
}

fn sort_history(history: &mut [ToolboxCompletionRecord]) {
    history.sort_by(|left, right| {
        right
            .completed_at_ms
            .cmp(&left.completed_at_ms)
            .then_with(|| right.record_id.cmp(&left.record_id))
    });
}

fn next_revision(revision: u64) -> Result<u64, ToolboxStorageError> {
    revision
        .checked_add(1)
        .ok_or(ToolboxStorageError::InvalidPolicy)
}

fn encode_cursor(history_revision: u64, offset: usize) -> String {
    format!("toolbox-history-v1-{history_revision}-{offset}")
}

fn decode_cursor(cursor: &str, expected_revision: u64) -> Result<usize, ToolboxStorageError> {
    let Some(rest) = cursor.strip_prefix("toolbox-history-v1-") else {
        return Err(ToolboxStorageError::InvalidCursor);
    };
    let Some((revision, offset)) = rest.split_once('-') else {
        return Err(ToolboxStorageError::InvalidCursor);
    };
    let revision = revision
        .parse::<u64>()
        .map_err(|_| ToolboxStorageError::InvalidCursor)?;
    let offset = offset
        .parse::<usize>()
        .map_err(|_| ToolboxStorageError::InvalidCursor)?;
    if revision != expected_revision {
        return Err(ToolboxStorageError::HistoryRevisionConflict {
            expected: revision,
            actual: expected_revision,
        });
    }
    if offset > MAX_HISTORY_ENTRIES {
        return Err(ToolboxStorageError::InvalidCursor);
    }
    Ok(offset)
}
