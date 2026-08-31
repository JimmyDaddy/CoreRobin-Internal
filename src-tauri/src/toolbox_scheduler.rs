use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{TimeZone, Utc};

use crate::error::CommandError;

#[path = "toolbox_scheduler/persist.rs"]
mod persist;
#[path = "toolbox_scheduler/core.rs"]
mod scheduler_core;

use persist::{
    IntentWrite, PersistedExecutionIntent, PersistedIntentState, PersistedSchedule,
    PersistedSchedulerAction, PersistedSchedulerTrigger, SchedulerStore, SchedulerStoreError,
};
use scheduler_core::{
    CronExpression, CronSearchResult, SearchBudget, parse_time_zone, search_cron,
};

pub const MAX_SCHEDULE_RULES: usize = 32;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_SCHEDULE_ID_BYTES: usize = 64;
const MAX_TITLE_CHARS: usize = 80;
const MIN_KEEP_AWAKE_MINUTES: u16 = 1;
const MAX_KEEP_AWAKE_MINUTES: u16 = 12 * 60;
const ONE_DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_ONCE_AHEAD_MS: u64 = 365 * ONE_DAY_MS;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerCreateRequest {
    pub request_id: String,
    pub time_zone: String,
    pub title: Option<String>,
    pub action: SchedulerAction,
    pub trigger: SchedulerTrigger,
}
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerRuleRequest {
    pub request_id: String,
    pub schedule_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SchedulerAction {
    Reminder,
    KeepAwake { duration_minutes: u16 },
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SchedulerTrigger {
    Once {
        at_ms: u64,
    },
    Daily {
        hour: u8,
        minute: u8,
        next_run_at_ms: u64,
    },
    Weekly {
        weekday: u8,
        hour: u8,
        minute: u8,
        next_run_at_ms: u64,
    },
    Cron {
        expression: String,
        next_run_at_ms: u64,
    },
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerRule {
    pub schedule_id: String,
    pub time_zone: String,
    pub title: Option<String>,
    pub action: SchedulerAction,
    pub trigger: SchedulerTrigger,
    pub status: SchedulerRuleStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SchedulerRuleStatus {
    Scheduled,
    Paused,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerSnapshot {
    pub revision: u64,
    pub max_rules: usize,
    pub persistent: bool,
    pub restart_notice: String,
    pub execution_notice: String,
    pub rules: Vec<SchedulerRule>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerActionIntent {
    pub schedule_id: String,
    pub schedule_revision: u64,
    pub action: SchedulerAction,
    pub scheduled_at_ms: u64,
    pub epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedulerIntentOutcome {
    Submitted,
    Skipped,
    Failed,
}

/// A pure native preview request. This deliberately has no requestId because it cannot persist
/// or dispatch an action; save/edit requests are separately idempotent mutations.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerPreviewRequest {
    pub time_zone: String,
    pub trigger: SchedulerPreviewTrigger,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SchedulerPreviewTrigger {
    Once { at_utc_ms: u64 },
    Daily { hour: u8, minute: u8 },
    Weekly { weekday: u8, hour: u8, minute: u8 },
    Cron { expression: String },
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerPreview {
    pub time_zone: String,
    pub status: SchedulerPreviewStatus,
    pub occurrence_at_ms: Vec<u64>,
    pub horizon_end_at_ms: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SchedulerPreviewStatus {
    Ready,
    NoOccurrenceInHorizon,
}

/// A bounded native schedule provider. Persistent instances load only the
/// scheduler's private rule file; the caller owns the timer and action executor.
#[derive(Default)]
pub struct ToolboxScheduler {
    revision: u64,
    next_rule_id: u64,
    rules: Vec<SchedulerRule>,
    store: Option<SchedulerStore>,
}

impl ToolboxScheduler {
    pub fn open(app_data_dir: impl Into<std::path::PathBuf>) -> Result<Self, CommandError> {
        let store = SchedulerStore::open(app_data_dir).map_err(storage_error)?;
        let mut scheduler = Self {
            revision: store.state().revision,
            next_rule_id: store.state().next_rule_sequence,
            rules: Vec::new(),
            store: Some(store),
        };
        scheduler.reload_from_store()?;
        Ok(scheduler)
    }

    fn reload_from_store(&mut self) -> Result<(), CommandError> {
        let Some(store) = self.store.as_ref() else {
            return Ok(());
        };
        self.revision = store.state().revision;
        self.next_rule_id = store.state().next_rule_sequence;
        self.rules = store
            .state()
            .rules
            .iter()
            .map(public_rule)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(())
    }

    /// Parse and preview the product rule dialect in an explicit IANA zone. The command wrapper
    /// is registered by the total controller; this function touches no stored rule or action.
    pub fn preview(request: SchedulerPreviewRequest) -> Result<SchedulerPreview, CommandError> {
        Self::preview_at(request, now_millis())
    }

    fn preview_at(
        request: SchedulerPreviewRequest,
        after_ms: u64,
    ) -> Result<SchedulerPreview, CommandError> {
        let time_zone = parse_time_zone(&request.time_zone).map_err(rule_error)?;
        let after_utc = utc_from_millis(after_ms)?;

        let expression = match request.trigger {
            SchedulerPreviewTrigger::Once { at_utc_ms } => {
                if at_utc_ms <= after_ms || at_utc_ms > after_ms.saturating_add(MAX_ONCE_AHEAD_MS) {
                    return Err(CommandError::new(
                        "invalid_once_time",
                        "The one-time schedule must be in the next 365 days.",
                    ));
                }
                return Ok(SchedulerPreview {
                    time_zone: time_zone.to_string(),
                    status: SchedulerPreviewStatus::Ready,
                    occurrence_at_ms: vec![at_utc_ms],
                    horizon_end_at_ms: at_utc_ms,
                    truncated: false,
                });
            }
            SchedulerPreviewTrigger::Daily { hour, minute } => {
                validate_time_of_day(hour, minute)?;
                CronExpression::parse(&format!("{minute} {hour} * * *")).map_err(rule_error)?
            }
            SchedulerPreviewTrigger::Weekly {
                weekday,
                hour,
                minute,
            } => {
                if weekday > 6 {
                    return Err(CommandError::new(
                        "invalid_weekday",
                        "weekday must use 0 for Sunday through 6 for Saturday.",
                    ));
                }
                validate_time_of_day(hour, minute)?;
                CronExpression::parse(&format!("{minute} {hour} * * {weekday}"))
                    .map_err(rule_error)?
            }
            SchedulerPreviewTrigger::Cron { expression } => {
                CronExpression::parse(&expression).map_err(rule_error)?
            }
        };

        match search_cron(
            &expression,
            time_zone,
            after_utc,
            SearchBudget::normal(),
            || false,
        ) {
            CronSearchResult::Occurrences {
                occurrences,
                horizon_end_utc,
                truncated,
            } => Ok(SchedulerPreview {
                time_zone: time_zone.to_string(),
                status: SchedulerPreviewStatus::Ready,
                occurrence_at_ms: occurrences
                    .into_iter()
                    .map(|occurrence| millis_from_utc(occurrence.at_utc))
                    .collect(),
                horizon_end_at_ms: millis_from_utc(horizon_end_utc),
                truncated,
            }),
            CronSearchResult::NoOccurrenceInHorizon { horizon_end_utc } => Ok(SchedulerPreview {
                time_zone: time_zone.to_string(),
                status: SchedulerPreviewStatus::NoOccurrenceInHorizon,
                occurrence_at_ms: Vec::new(),
                horizon_end_at_ms: millis_from_utc(horizon_end_utc),
                truncated: false,
            }),
            CronSearchResult::SearchLimit => Err(CommandError::new(
                "search_limit",
                "The Cron search reached its bounded calculation limit; the rule was not enabled.",
            )),
        }
    }

    pub fn snapshot(&self) -> SchedulerSnapshot {
        SchedulerSnapshot {
            revision: self.revision,
            max_rules: MAX_SCHEDULE_RULES,
            persistent: self.store.is_some(),
            restart_notice: if self.store.is_some() {
                "Rules are stored in private app data; temporary action state is not restored."
            } else {
                "Rules are stored only in memory and are cleared when CoreRobin restarts."
            }
            .to_owned(),
            execution_notice: "Native scheduling records an action intent before emitting a reminder or requesting a bounded keep-awake action; missed actions are not replayed."
                .to_owned(),
            rules: self.rules.clone(),
        }
    }

    pub fn create(
        &mut self,
        request: SchedulerCreateRequest,
    ) -> Result<SchedulerSnapshot, CommandError> {
        self.create_at(request, now_millis())
    }

    pub fn poll_due(&mut self, now_ms: u64) -> Result<Vec<SchedulerActionIntent>, CommandError> {
        if self.store.is_none() {
            return Ok(Vec::new());
        }
        let epoch = self
            .store
            .as_ref()
            .map(|store| store.state().epoch)
            .unwrap_or_default();
        let due = self
            .store
            .as_ref()
            .expect("persistent scheduler store")
            .state()
            .rules
            .iter()
            .filter(|rule| {
                rule.enabled
                    && rule
                        .next_scheduled_at_utc_ms
                        .is_some_and(|scheduled| scheduled <= now_ms)
            })
            .map(|rule| {
                (
                    rule.schedule_id.clone(),
                    rule.revision,
                    rule.next_scheduled_at_utc_ms.unwrap_or_default(),
                    rule.action.clone(),
                    rule.trigger.clone(),
                )
            })
            .collect::<Vec<_>>();
        let mut intents = Vec::new();
        for (schedule_id, schedule_revision, scheduled_at_ms, action, trigger) in due {
            // A schedule that was missed while the app was stopped is advanced without
            // dispatch. The one-second grace window is only for an active runtime poll.
            if now_ms.saturating_sub(scheduled_at_ms) > 5_000 {
                self.advance_persisted_rule(&schedule_id, now_ms)?;
                continue;
            }
            let intent = PersistedExecutionIntent {
                schedule_id: schedule_id.clone(),
                schedule_revision,
                scheduled_at_utc_ms: scheduled_at_ms,
                local_key: None,
                epoch,
                state: PersistedIntentState::Intended,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            };
            let intent_write = self
                .store
                .as_mut()
                .expect("persistent scheduler store")
                .record_intent(intent, now_ms)
                .map_err(storage_error)?;
            if intent_write == IntentWrite::AlreadyRecorded {
                self.advance_persisted_rule(&schedule_id, now_ms)?;
                continue;
            }
            self.advance_persisted_rule_with_trigger(&schedule_id, now_ms, &trigger)?;
            intents.push(SchedulerActionIntent {
                schedule_id,
                schedule_revision,
                action: public_action(&action),
                scheduled_at_ms,
                epoch,
            });
        }
        self.reload_from_store()?;
        Ok(intents)
    }

    pub fn mark_intent_outcome(
        &mut self,
        intent: &SchedulerActionIntent,
        outcome: SchedulerIntentOutcome,
        now_ms: u64,
    ) -> Result<(), CommandError> {
        let Some(store) = self.store.as_mut() else {
            return Ok(());
        };
        let state = match outcome {
            SchedulerIntentOutcome::Submitted => PersistedIntentState::Submitted,
            SchedulerIntentOutcome::Skipped => PersistedIntentState::Skipped,
            SchedulerIntentOutcome::Failed => PersistedIntentState::Failed,
        };
        store
            .mark_intent(
                &intent.schedule_id,
                intent.schedule_revision,
                intent.scheduled_at_ms,
                intent.epoch,
                state,
                now_ms,
            )
            .map_err(storage_error)
    }

    pub fn adopt_reset_epoch(&mut self, reset_epoch: u64) -> Result<(), CommandError> {
        let Some(store) = self.store.as_mut() else {
            return Ok(());
        };
        if reset_epoch < store.state().epoch {
            return Err(CommandError::new(
                "reset_epoch_conflict",
                "The scheduler reset epoch is newer than toolbox storage.",
            ));
        }
        if reset_epoch == store.state().epoch {
            return Ok(());
        }
        store
            .transact(|state| {
                state.epoch = reset_epoch;
                state.rules.clear();
                state.intents.clear();
                state.revision = state.revision.saturating_add(1);
                Ok(())
            })
            .map_err(storage_error)?;
        self.reload_from_store()
    }

    pub fn pause(
        &mut self,
        request: SchedulerRuleRequest,
    ) -> Result<SchedulerSnapshot, CommandError> {
        self.pause_at(request, now_millis())
    }

    pub fn delete(
        &mut self,
        request: SchedulerRuleRequest,
    ) -> Result<SchedulerSnapshot, CommandError> {
        validate_request_id(&request.request_id)?;
        validate_schedule_id(&request.schedule_id)?;
        if let Some(store) = self.store.as_mut() {
            store
                .transact(|state| {
                    let Some(index) = state
                        .rules
                        .iter()
                        .position(|rule| rule.schedule_id == request.schedule_id)
                    else {
                        return Err(SchedulerStoreError::InvalidState);
                    };
                    state.rules.remove(index);
                    state.revision = state.revision.saturating_add(1);
                    Ok(())
                })
                .map_err(|error| match error {
                    SchedulerStoreError::InvalidState => CommandError::new(
                        "schedule_not_found",
                        "The schedule rule no longer exists.",
                    ),
                    other => storage_error(other),
                })?;
            self.reload_from_store()?;
            return Ok(self.snapshot());
        }
        let Some(index) = self
            .rules
            .iter()
            .position(|rule| rule.schedule_id == request.schedule_id)
        else {
            return Err(CommandError::new(
                "schedule_not_found",
                "The schedule rule no longer exists.",
            ));
        };
        self.rules.remove(index);
        self.revision = self.revision.saturating_add(1);
        Ok(self.snapshot())
    }

    fn create_at(
        &mut self,
        request: SchedulerCreateRequest,
        now_ms: u64,
    ) -> Result<SchedulerSnapshot, CommandError> {
        validate_request_id(&request.request_id)?;
        if self.rules.len() >= MAX_SCHEDULE_RULES {
            return Err(CommandError::new(
                "schedule_limit_reached",
                format!("At most {MAX_SCHEDULE_RULES} schedule rules can be kept in memory."),
            ));
        }
        let title = validate_title(request.title.as_deref())?;
        validate_action(&request.action)?;
        let _time_zone = parse_time_zone(&request.time_zone).map_err(rule_error)?;
        let trigger = normalize_trigger(&request.time_zone, request.trigger, now_ms)?;

        let schedule_id = format!("schedule-{}", self.next_rule_id.saturating_add(1));
        if let Some(store) = self.store.as_mut() {
            let action = request.action.clone();
            let time_zone = request.time_zone.clone();
            let persisted_trigger = persisted_trigger(&trigger);
            let persisted_action = persisted_action(&action);
            let persisted_title = title.clone();
            let next_scheduled_at_utc_ms = trigger_next_run(&trigger);
            store
                .transact(|state| {
                    if state.rules.len() >= MAX_SCHEDULE_RULES {
                        return Err(SchedulerStoreError::InvalidState);
                    }
                    let revision = state.revision.saturating_add(1);
                    state.revision = revision;
                    state.next_rule_sequence = state.next_rule_sequence.saturating_add(1);
                    state.rules.push(PersistedSchedule {
                        schedule_id: schedule_id.clone(),
                        revision,
                        title: persisted_title.clone(),
                        time_zone: time_zone.clone(),
                        action: persisted_action.clone(),
                        trigger: persisted_trigger.clone(),
                        enabled: true,
                        next_scheduled_at_utc_ms: Some(next_scheduled_at_utc_ms),
                        last_processed_at_utc_ms: None,
                        last_processed_local_key: None,
                        created_at_ms: now_ms,
                        updated_at_ms: now_ms,
                    });
                    Ok(())
                })
                .map_err(storage_error)?;
            self.reload_from_store()?;
            return Ok(self.snapshot());
        }
        self.next_rule_id = self.next_rule_id.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        self.rules.push(SchedulerRule {
            schedule_id,
            time_zone: request.time_zone,
            title,
            action: request.action,
            trigger,
            status: SchedulerRuleStatus::Scheduled,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        });
        Ok(self.snapshot())
    }

    fn pause_at(
        &mut self,
        request: SchedulerRuleRequest,
        now_ms: u64,
    ) -> Result<SchedulerSnapshot, CommandError> {
        validate_request_id(&request.request_id)?;
        validate_schedule_id(&request.schedule_id)?;
        if let Some(store) = self.store.as_mut() {
            store
                .transact(|state| {
                    let Some(rule) = state
                        .rules
                        .iter_mut()
                        .find(|rule| rule.schedule_id == request.schedule_id)
                    else {
                        return Err(SchedulerStoreError::InvalidState);
                    };
                    if rule.enabled {
                        rule.enabled = false;
                        rule.updated_at_ms = now_ms;
                        state.revision = state.revision.saturating_add(1);
                    }
                    Ok(())
                })
                .map_err(|error| match error {
                    SchedulerStoreError::InvalidState => CommandError::new(
                        "schedule_not_found",
                        "The schedule rule no longer exists.",
                    ),
                    other => storage_error(other),
                })?;
            self.reload_from_store()?;
            return Ok(self.snapshot());
        }
        let Some(rule) = self
            .rules
            .iter_mut()
            .find(|rule| rule.schedule_id == request.schedule_id)
        else {
            return Err(CommandError::new(
                "schedule_not_found",
                "The schedule rule no longer exists.",
            ));
        };
        if rule.status != SchedulerRuleStatus::Paused {
            rule.status = SchedulerRuleStatus::Paused;
            rule.updated_at_ms = now_ms;
            self.revision = self.revision.saturating_add(1);
        }
        Ok(self.snapshot())
    }

    fn advance_persisted_rule(
        &mut self,
        schedule_id: &str,
        now_ms: u64,
    ) -> Result<(), CommandError> {
        let trigger = self
            .store
            .as_ref()
            .and_then(|store| {
                store
                    .state()
                    .rules
                    .iter()
                    .find(|rule| rule.schedule_id == schedule_id)
                    .map(|rule| rule.trigger.clone())
            })
            .ok_or_else(|| {
                CommandError::new("schedule_not_found", "The schedule rule no longer exists.")
            })?;
        self.advance_persisted_rule_with_trigger(schedule_id, now_ms, &trigger)
    }

    fn advance_persisted_rule_with_trigger(
        &mut self,
        schedule_id: &str,
        now_ms: u64,
        trigger: &PersistedSchedulerTrigger,
    ) -> Result<(), CommandError> {
        let Some(store) = self.store.as_mut() else {
            return Ok(());
        };
        let next = {
            let rule = store
                .state()
                .rules
                .iter()
                .find(|rule| rule.schedule_id == schedule_id)
                .ok_or_else(|| {
                    CommandError::new("schedule_not_found", "The schedule rule no longer exists.")
                })?;
            match trigger {
                PersistedSchedulerTrigger::Once { .. } => None,
                PersistedSchedulerTrigger::Daily { hour, minute } => Some(next_for_trigger(
                    &rule.time_zone,
                    SchedulerPreviewTrigger::Daily {
                        hour: *hour,
                        minute: *minute,
                    },
                    now_ms,
                )?),
                PersistedSchedulerTrigger::Weekly {
                    weekday,
                    hour,
                    minute,
                } => Some(next_for_trigger(
                    &rule.time_zone,
                    SchedulerPreviewTrigger::Weekly {
                        weekday: *weekday,
                        hour: *hour,
                        minute: *minute,
                    },
                    now_ms,
                )?),
                PersistedSchedulerTrigger::Cron { expression } => Some(next_for_trigger(
                    &rule.time_zone,
                    SchedulerPreviewTrigger::Cron {
                        expression: expression.clone(),
                    },
                    now_ms,
                )?),
            }
        };
        store
            .transact(|state| {
                let rule = state
                    .rules
                    .iter_mut()
                    .find(|rule| rule.schedule_id == schedule_id)
                    .ok_or(SchedulerStoreError::InvalidState)?;
                rule.last_processed_at_utc_ms = Some(now_ms);
                rule.next_scheduled_at_utc_ms = next;
                if next.is_none() {
                    rule.enabled = false;
                }
                rule.updated_at_ms = now_ms;
                state.revision = state.revision.saturating_add(1);
                Ok(())
            })
            .map_err(storage_error)?;
        Ok(())
    }
}

fn storage_error(error: SchedulerStoreError) -> CommandError {
    let code = match error {
        SchedulerStoreError::InvalidAppDataDir => "invalid_storage",
        SchedulerStoreError::Corrupt => "schedule_storage_corrupt",
        SchedulerStoreError::InvalidState => "invalid_schedule",
        SchedulerStoreError::Io | SchedulerStoreError::Serialization => "schedule_storage_error",
    };
    CommandError::new(code, error.to_string())
}

fn public_rule(rule: &PersistedSchedule) -> Result<SchedulerRule, CommandError> {
    let trigger = match &rule.trigger {
        PersistedSchedulerTrigger::Once { at_utc_ms } => {
            SchedulerTrigger::Once { at_ms: *at_utc_ms }
        }
        PersistedSchedulerTrigger::Daily { hour, minute } => SchedulerTrigger::Daily {
            hour: *hour,
            minute: *minute,
            next_run_at_ms: rule.next_scheduled_at_utc_ms.ok_or_else(|| {
                CommandError::new(
                    "invalid_schedule",
                    "A daily schedule has no next occurrence.",
                )
            })?,
        },
        PersistedSchedulerTrigger::Weekly {
            weekday,
            hour,
            minute,
        } => SchedulerTrigger::Weekly {
            weekday: *weekday,
            hour: *hour,
            minute: *minute,
            next_run_at_ms: rule.next_scheduled_at_utc_ms.ok_or_else(|| {
                CommandError::new(
                    "invalid_schedule",
                    "A weekly schedule has no next occurrence.",
                )
            })?,
        },
        PersistedSchedulerTrigger::Cron { expression } => SchedulerTrigger::Cron {
            expression: expression.clone(),
            next_run_at_ms: rule.next_scheduled_at_utc_ms.ok_or_else(|| {
                CommandError::new(
                    "invalid_schedule",
                    "A Cron schedule has no next occurrence.",
                )
            })?,
        },
    };
    let action = match &rule.action {
        PersistedSchedulerAction::Reminder => SchedulerAction::Reminder,
        PersistedSchedulerAction::KeepAwake { duration_minutes } => SchedulerAction::KeepAwake {
            duration_minutes: *duration_minutes,
        },
    };
    Ok(SchedulerRule {
        schedule_id: rule.schedule_id.clone(),
        time_zone: rule.time_zone.clone(),
        title: rule.title.clone(),
        action,
        trigger,
        status: if rule.enabled {
            SchedulerRuleStatus::Scheduled
        } else {
            SchedulerRuleStatus::Paused
        },
        created_at_ms: rule.created_at_ms,
        updated_at_ms: rule.updated_at_ms,
    })
}

fn normalize_trigger(
    time_zone: &str,
    trigger: SchedulerTrigger,
    now_ms: u64,
) -> Result<SchedulerTrigger, CommandError> {
    match trigger {
        SchedulerTrigger::Once { at_ms } => {
            validate_next_run(at_ms, now_ms, MAX_ONCE_AHEAD_MS, "once")?;
            Ok(SchedulerTrigger::Once { at_ms })
        }
        SchedulerTrigger::Daily { hour, minute, .. } => {
            validate_time_of_day(hour, minute)?;
            let next_run_at_ms = next_for_trigger(
                time_zone,
                SchedulerPreviewTrigger::Daily { hour, minute },
                now_ms,
            )?;
            Ok(SchedulerTrigger::Daily {
                hour,
                minute,
                next_run_at_ms,
            })
        }
        SchedulerTrigger::Weekly {
            weekday,
            hour,
            minute,
            ..
        } => {
            if weekday > 6 {
                return Err(CommandError::new(
                    "invalid_weekday",
                    "weekday must use 0 for Sunday through 6 for Saturday.",
                ));
            }
            validate_time_of_day(hour, minute)?;
            let next_run_at_ms = next_for_trigger(
                time_zone,
                SchedulerPreviewTrigger::Weekly {
                    weekday,
                    hour,
                    minute,
                },
                now_ms,
            )?;
            Ok(SchedulerTrigger::Weekly {
                weekday,
                hour,
                minute,
                next_run_at_ms,
            })
        }
        SchedulerTrigger::Cron { expression, .. } => {
            validate_cron_expression(&expression)?;
            let next_run_at_ms = next_for_trigger(
                time_zone,
                SchedulerPreviewTrigger::Cron {
                    expression: expression.clone(),
                },
                now_ms,
            )?;
            Ok(SchedulerTrigger::Cron {
                expression,
                next_run_at_ms,
            })
        }
    }
}

fn next_for_trigger(
    time_zone: &str,
    trigger: SchedulerPreviewTrigger,
    after_ms: u64,
) -> Result<u64, CommandError> {
    let preview = ToolboxScheduler::preview_at(
        SchedulerPreviewRequest {
            time_zone: time_zone.to_owned(),
            trigger,
        },
        after_ms,
    )?;
    preview.occurrence_at_ms.first().copied().ok_or_else(|| {
        CommandError::new(
            "no_occurrence",
            "The schedule has no occurrence in the bounded horizon.",
        )
    })
}

fn persisted_trigger(trigger: &SchedulerTrigger) -> PersistedSchedulerTrigger {
    match trigger {
        SchedulerTrigger::Once { at_ms } => PersistedSchedulerTrigger::Once { at_utc_ms: *at_ms },
        SchedulerTrigger::Daily { hour, minute, .. } => PersistedSchedulerTrigger::Daily {
            hour: *hour,
            minute: *minute,
        },
        SchedulerTrigger::Weekly {
            weekday,
            hour,
            minute,
            ..
        } => PersistedSchedulerTrigger::Weekly {
            weekday: *weekday,
            hour: *hour,
            minute: *minute,
        },
        SchedulerTrigger::Cron { expression, .. } => PersistedSchedulerTrigger::Cron {
            expression: expression.clone(),
        },
    }
}

fn persisted_action(action: &SchedulerAction) -> PersistedSchedulerAction {
    match action {
        SchedulerAction::Reminder => PersistedSchedulerAction::Reminder,
        SchedulerAction::KeepAwake { duration_minutes } => PersistedSchedulerAction::KeepAwake {
            duration_minutes: *duration_minutes,
        },
    }
}

fn public_action(action: &PersistedSchedulerAction) -> SchedulerAction {
    match action {
        PersistedSchedulerAction::Reminder => SchedulerAction::Reminder,
        PersistedSchedulerAction::KeepAwake { duration_minutes } => SchedulerAction::KeepAwake {
            duration_minutes: *duration_minutes,
        },
    }
}

fn trigger_next_run(trigger: &SchedulerTrigger) -> u64 {
    match trigger {
        SchedulerTrigger::Once { at_ms } => *at_ms,
        SchedulerTrigger::Daily { next_run_at_ms, .. }
        | SchedulerTrigger::Weekly { next_run_at_ms, .. }
        | SchedulerTrigger::Cron { next_run_at_ms, .. } => *next_run_at_ms,
    }
}

fn rule_error(error: scheduler_core::SchedulerRuleError) -> CommandError {
    CommandError::new(error.code, error.message)
}

fn utc_from_millis(milliseconds: u64) -> Result<chrono::DateTime<Utc>, CommandError> {
    let milliseconds = i64::try_from(milliseconds).map_err(|_| {
        CommandError::new(
            "invalid_time",
            "The preview start time is outside the supported UTC range.",
        )
    })?;
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .ok_or_else(|| {
            CommandError::new(
                "invalid_time",
                "The preview start time is outside the supported UTC range.",
            )
        })
}

fn millis_from_utc(value: chrono::DateTime<Utc>) -> u64 {
    u64::try_from(value.timestamp_millis()).unwrap_or(u64::MAX)
}

fn validate_request_id(request_id: &str) -> Result<(), CommandError> {
    if request_id.trim().is_empty() || request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(CommandError::new(
            "invalid_request",
            "requestId must be a non-empty value no longer than 128 bytes.",
        ));
    }
    Ok(())
}

fn validate_schedule_id(schedule_id: &str) -> Result<(), CommandError> {
    if schedule_id.trim().is_empty() || schedule_id.len() > MAX_SCHEDULE_ID_BYTES {
        return Err(CommandError::new(
            "invalid_schedule_id",
            "scheduleId must be a non-empty value no longer than 64 bytes.",
        ));
    }
    Ok(())
}

fn validate_title(title: Option<&str>) -> Result<Option<String>, CommandError> {
    let Some(title) = title else {
        return Ok(None);
    };
    let title = title.trim();
    if title.is_empty() {
        return Ok(None);
    }
    if title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
        return Err(CommandError::new(
            "invalid_title",
            "Schedule titles must contain at most 80 non-control characters.",
        ));
    }
    Ok(Some(title.to_owned()))
}

fn validate_action(action: &SchedulerAction) -> Result<(), CommandError> {
    match action {
        SchedulerAction::Reminder => Ok(()),
        SchedulerAction::KeepAwake { duration_minutes }
            if (MIN_KEEP_AWAKE_MINUTES..=MAX_KEEP_AWAKE_MINUTES).contains(duration_minutes) =>
        {
            Ok(())
        }
        SchedulerAction::KeepAwake { .. } => Err(CommandError::new(
            "invalid_duration",
            "Timed keep-awake intents must be between 1 minute and 12 hours.",
        )),
    }
}

fn validate_time_of_day(hour: u8, minute: u8) -> Result<(), CommandError> {
    if hour > 23 || minute > 59 {
        return Err(CommandError::new(
            "invalid_time_of_day",
            "Scheduled hour must be 0-23 and minute must be 0-59.",
        ));
    }
    Ok(())
}

fn validate_next_run(
    next_run_at_ms: u64,
    now_ms: u64,
    maximum_ahead_ms: u64,
    trigger_kind: &str,
) -> Result<(), CommandError> {
    if next_run_at_ms <= now_ms || next_run_at_ms > now_ms.saturating_add(maximum_ahead_ms) {
        return Err(CommandError::new(
            "invalid_next_run",
            format!("The {trigger_kind} nextRunAtMs must be a bounded future time."),
        ));
    }
    Ok(())
}

fn validate_cron_expression(expression: &str) -> Result<(), CommandError> {
    CronExpression::parse(expression)
        .map(|_| ())
        .map_err(rule_error)
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
    use super::*;

    const NOW_MS: u64 = 1_000_000;

    fn reminder_once(at_ms: u64) -> SchedulerCreateRequest {
        SchedulerCreateRequest {
            request_id: "request-1".to_owned(),
            time_zone: "Etc/UTC".to_owned(),
            title: Some("Lunch reminder".to_owned()),
            action: SchedulerAction::Reminder,
            trigger: SchedulerTrigger::Once { at_ms },
        }
    }

    #[test]
    fn keeps_only_bounded_memory_rules_and_marks_restart_behavior() {
        let mut scheduler = ToolboxScheduler::default();
        let snapshot = scheduler
            .create_at(reminder_once(NOW_MS + 60_000), NOW_MS)
            .expect("valid rule is accepted");

        assert!(!snapshot.persistent);
        assert!(snapshot.restart_notice.contains("cleared"));
        assert!(snapshot.execution_notice.contains("missed actions"));
        assert_eq!(snapshot.max_rules, MAX_SCHEDULE_RULES);
        assert_eq!(snapshot.rules[0].status, SchedulerRuleStatus::Scheduled);
        assert_eq!(snapshot.rules[0].title.as_deref(), Some("Lunch reminder"));
    }

    #[test]
    fn rejects_command_like_cron_before_mutating_state() {
        let mut scheduler = ToolboxScheduler::default();
        let error = scheduler
            .create_at(
                SchedulerCreateRequest {
                    request_id: "request-2".to_owned(),
                    time_zone: "Etc/UTC".to_owned(),
                    title: None,
                    action: SchedulerAction::Reminder,
                    trigger: SchedulerTrigger::Cron {
                        expression: "0 0 * * * rm -rf /".to_owned(),
                        next_run_at_ms: NOW_MS + ONE_DAY_MS,
                    },
                },
                NOW_MS,
            )
            .expect_err("six-field command payload is rejected");

        assert_eq!(error.code, "invalid_cron");
        assert!(scheduler.snapshot().rules.is_empty());
    }

    #[test]
    fn validates_white_list_action_bounds_and_rule_limit() {
        let mut scheduler = ToolboxScheduler::default();
        let invalid = scheduler.create_at(
            SchedulerCreateRequest {
                request_id: "request-3".to_owned(),
                time_zone: "Etc/UTC".to_owned(),
                title: None,
                action: SchedulerAction::KeepAwake {
                    duration_minutes: MAX_KEEP_AWAKE_MINUTES + 1,
                },
                trigger: SchedulerTrigger::Daily {
                    hour: 9,
                    minute: 0,
                    next_run_at_ms: NOW_MS + ONE_DAY_MS,
                },
            },
            NOW_MS,
        );
        assert_eq!(
            invalid.expect_err("duration is limited").code,
            "invalid_duration"
        );

        for number in 0..MAX_SCHEDULE_RULES {
            let mut request = reminder_once(NOW_MS + 60_000);
            request.request_id = format!("request-{number}");
            scheduler
                .create_at(request, NOW_MS)
                .expect("rule inside fixed limit is accepted");
        }
        let error = scheduler
            .create_at(reminder_once(NOW_MS + 60_000), NOW_MS)
            .expect_err("rule beyond fixed limit is rejected");
        assert_eq!(error.code, "schedule_limit_reached");
    }

    #[test]
    fn pauses_then_deletes_a_rule_without_any_execution_path() {
        let mut scheduler = ToolboxScheduler::default();
        let created = scheduler
            .create_at(reminder_once(NOW_MS + 60_000), NOW_MS)
            .expect("rule is created");
        let schedule_id = created.rules[0].schedule_id.clone();

        let paused = scheduler
            .pause_at(
                SchedulerRuleRequest {
                    request_id: "request-pause".to_owned(),
                    schedule_id: schedule_id.clone(),
                },
                NOW_MS + 1,
            )
            .expect("created rule can be paused");
        assert_eq!(paused.rules[0].status, SchedulerRuleStatus::Paused);

        let deleted = scheduler
            .delete(SchedulerRuleRequest {
                request_id: "request-delete".to_owned(),
                schedule_id,
            })
            .expect("paused rule can be deleted");
        assert!(deleted.rules.is_empty());
    }

    #[test]
    fn native_preview_resolves_the_repeated_dst_minute_once() {
        let after_ms = millis_from_utc(
            Utc.with_ymd_and_hms(2024, 11, 3, 4, 0, 0)
                .single()
                .expect("valid UTC instant"),
        );
        let preview = ToolboxScheduler::preview_at(
            SchedulerPreviewRequest {
                time_zone: "America/New_York".to_owned(),
                trigger: SchedulerPreviewTrigger::Cron {
                    expression: "30 1 3 11 *".to_owned(),
                },
            },
            after_ms,
        )
        .expect("Cron preview succeeds");

        assert_eq!(preview.status, SchedulerPreviewStatus::Ready);
        assert_eq!(
            preview.occurrence_at_ms.first().copied(),
            Some(millis_from_utc(
                Utc.with_ymd_and_hms(2024, 11, 3, 5, 30, 0)
                    .single()
                    .expect("valid earliest fall-back instant"),
            ))
        );
    }

    #[test]
    fn persistent_scheduler_records_due_intents_before_dispatch() {
        let directory = tempfile::tempdir().expect("private test directory");
        let mut scheduler = ToolboxScheduler::open(directory.path()).expect("open scheduler");
        scheduler
            .create_at(reminder_once(NOW_MS + 1_000), NOW_MS)
            .expect("save one-time rule");

        let intents = scheduler.poll_due(NOW_MS + 1_000).expect("poll due rules");
        assert_eq!(intents.len(), 1);
        assert!(
            scheduler
                .poll_due(NOW_MS + 1_001)
                .expect("deduplicate advanced rule")
                .is_empty()
        );

        scheduler
            .mark_intent_outcome(
                &intents[0],
                SchedulerIntentOutcome::Submitted,
                NOW_MS + 1_002,
            )
            .expect("record delivery outcome");
        drop(scheduler);

        let reopened = ToolboxScheduler::open(directory.path()).expect("reopen scheduler");
        let snapshot = reopened.snapshot();
        assert_eq!(snapshot.rules.len(), 1);
        assert_eq!(snapshot.rules[0].status, SchedulerRuleStatus::Paused);
    }

    #[test]
    fn adopting_a_new_reset_epoch_clears_persistent_rules() {
        let directory = tempfile::tempdir().expect("private test directory");
        let mut scheduler = ToolboxScheduler::open(directory.path()).expect("open scheduler");
        scheduler
            .create_at(reminder_once(NOW_MS + 1_000), NOW_MS)
            .expect("save one-time rule");

        scheduler
            .adopt_reset_epoch(1)
            .expect("advance the reset epoch");
        assert!(scheduler.snapshot().rules.is_empty());
        drop(scheduler);

        let reopened = ToolboxScheduler::open(directory.path()).expect("reopen scheduler");
        assert!(reopened.snapshot().rules.is_empty());
    }
}
