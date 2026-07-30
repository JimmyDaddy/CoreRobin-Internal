use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::CommandError;

pub const HEALTH_STATE_SCHEMA_VERSION: u16 = 3;
pub const HEALTH_STATE_EVENT: &str = "core-robin:health-state-changed";
pub const FRONTEND_HEARTBEAT_STALE_AFTER_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthDataStatus {
    Fresh,
    Paused,
    Stale,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthDataMode {
    Foreground,
    Background,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthLevel {
    Observing,
    Normal,
    Attention,
    Urgent,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthReason {
    Cpu,
    Memory,
    Storage,
    Temperature,
    Battery,
    Network,
    Sleep,
    None,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthIncidentPhase {
    Active,
    Recovering,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthIntent {
    Slow,
    Space,
    Startup,
    Heat,
    Network,
    Checkup,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryState {
    Charging,
    Discharging,
    Full,
    NotCharging,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIncidentProjection {
    pub id: String,
    pub occurrence_id: String,
    pub phase: HealthIncidentPhase,
    pub level: HealthLevel,
    pub reason: HealthReason,
    pub intent: HealthIntent,
    pub activated_at_ms: u64,
    pub recovery_started_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStateUpdate {
    pub schema_version: u16,
    pub sampled_at_ms: u64,
    pub data_mode: HealthDataMode,
    pub data_status: HealthDataStatus,
    pub paused: bool,
    pub health: HealthLevel,
    pub reason: HealthReason,
    pub active_count: usize,
    pub pending_count: usize,
    pub recovering_count: usize,
    pub primary_incident: Option<HealthIncidentProjection>,
    pub cpu_percent: Option<f32>,
    pub memory_percent: f32,
    pub storage_used_percent: Option<f32>,
    pub storage_available_bytes: Option<u64>,
    pub temperature_celsius: Option<f32>,
    pub battery_percent: Option<f32>,
    pub battery_health_percent: Option<f32>,
    pub battery_cycle_count: Option<u64>,
    pub battery_state: BatteryState,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStateSnapshot {
    pub revision: u64,
    #[serde(flatten)]
    pub update: HealthStateUpdate,
}

#[derive(Default)]
struct HealthStateRegistry {
    revision: u64,
    last_frontend_heartbeat_at_ms: Option<u64>,
    current: Option<HealthStateSnapshot>,
}

#[derive(Default)]
pub struct HealthStateStore {
    registry: Mutex<HealthStateRegistry>,
}

impl HealthStateStore {
    pub fn frontend_heartbeat(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.last_frontend_heartbeat_at_ms = Some(now_millis());
        }
    }

    pub fn publish(&self, update: HealthStateUpdate) -> Result<HealthStateSnapshot, CommandError> {
        validate_update(&update)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| CommandError::internal("The health state lock was poisoned."))?;
        registry.revision = registry.revision.saturating_add(1);
        let snapshot = HealthStateSnapshot {
            revision: registry.revision,
            update,
        };
        registry.current = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub fn current(&self) -> Result<Option<HealthStateSnapshot>, CommandError> {
        self.registry
            .lock()
            .map(|registry| registry.current.clone())
            .map_err(|_| CommandError::internal("The health state lock was poisoned."))
    }

    pub fn expire_stale_frontend(
        &self,
        now_ms: u64,
    ) -> Result<Option<HealthStateSnapshot>, CommandError> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| CommandError::internal("The health state lock was poisoned."))?;
        let heartbeat_at = registry.last_frontend_heartbeat_at_ms.unwrap_or(0);
        let should_expire = registry.current.as_ref().is_some_and(|snapshot| {
            !snapshot.update.paused
                && snapshot.update.data_status != HealthDataStatus::Stale
                && (heartbeat_at == 0
                    || now_ms.saturating_sub(heartbeat_at) > FRONTEND_HEARTBEAT_STALE_AFTER_MS)
        });
        if !should_expire {
            return Ok(None);
        }
        let Some(current) = registry.current.as_ref() else {
            return Ok(None);
        };
        let mut update = current.update.clone();
        update.data_status = HealthDataStatus::Stale;
        update.paused = false;
        update.health = HealthLevel::Observing;
        update.reason = HealthReason::None;
        update.active_count = 0;
        update.pending_count = 0;
        update.recovering_count = 0;
        update.primary_incident = None;
        registry.revision = registry.revision.saturating_add(1);
        let snapshot = HealthStateSnapshot {
            revision: registry.revision,
            update,
        };
        registry.current = Some(snapshot.clone());
        Ok(Some(snapshot))
    }
}

fn validate_update(update: &HealthStateUpdate) -> Result<(), CommandError> {
    let valid = update.schema_version == HEALTH_STATE_SCHEMA_VERSION
        && update.sampled_at_ms > 0
        && update.data_status
            == if update.paused {
                HealthDataStatus::Paused
            } else {
                HealthDataStatus::Fresh
            }
        && update.recovering_count <= update.active_count
        && (update.active_count > 0) == update.primary_incident.is_some()
        && (update.active_count > 0) == (update.reason != HealthReason::None)
        && (update.active_count == 0
            || matches!(update.health, HealthLevel::Attention | HealthLevel::Urgent))
        && update.memory_percent.is_finite()
        && (0.0..=100.0).contains(&update.memory_percent)
        && update
            .battery_health_percent
            .is_none_or(|value| value.is_finite() && (0.0..=100.0).contains(&value));
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_health_state",
            "The health state update is inconsistent or uses an unsupported schema.",
        ))
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(active_count: usize) -> HealthStateUpdate {
        HealthStateUpdate {
            schema_version: HEALTH_STATE_SCHEMA_VERSION,
            sampled_at_ms: 100,
            data_mode: HealthDataMode::Foreground,
            data_status: HealthDataStatus::Fresh,
            paused: false,
            health: if active_count == 0 {
                HealthLevel::Normal
            } else {
                HealthLevel::Attention
            },
            reason: if active_count == 0 {
                HealthReason::None
            } else {
                HealthReason::Cpu
            },
            active_count,
            pending_count: 0,
            recovering_count: 0,
            primary_incident: (active_count > 0).then(|| HealthIncidentProjection {
                id: "diagnosis:sustained_cpu".to_owned(),
                occurrence_id: "diagnosis:sustained_cpu:100".to_owned(),
                phase: HealthIncidentPhase::Active,
                level: HealthLevel::Attention,
                reason: HealthReason::Cpu,
                intent: HealthIntent::Slow,
                activated_at_ms: 100,
                recovery_started_at_ms: None,
            }),
            cpu_percent: Some(80.0),
            memory_percent: 50.0,
            storage_used_percent: Some(40.0),
            storage_available_bytes: Some(100),
            temperature_celsius: Some(55.0),
            battery_percent: Some(80.0),
            battery_health_percent: Some(94.0),
            battery_cycle_count: Some(173),
            battery_state: BatteryState::Discharging,
        }
    }

    #[test]
    fn retains_the_latest_state_with_monotonic_revisions() {
        let store = HealthStateStore::default();
        let first = store.publish(update(0)).unwrap();
        let second = store.publish(update(1)).unwrap();

        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 2);
        assert_eq!(store.current().unwrap(), Some(second));
    }

    #[test]
    fn rejects_inconsistent_counts_before_replacing_the_current_state() {
        let store = HealthStateStore::default();
        let accepted = store.publish(update(0)).unwrap();
        let mut invalid = update(1);
        invalid.primary_incident = None;

        let error = store.publish(invalid).unwrap_err();

        assert_eq!(error.code, "invalid_health_state");
        assert_eq!(store.current().unwrap(), Some(accepted));
    }

    #[test]
    fn serializes_revision_and_update_as_one_flat_contract() {
        let snapshot = HealthStateStore::default().publish(update(1)).unwrap();
        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["revision"], 1);
        assert_eq!(value["schemaVersion"], HEALTH_STATE_SCHEMA_VERSION);
        assert_eq!(value["dataStatus"], "fresh");
        assert_eq!(
            value["primaryIncident"]["occurrenceId"],
            "diagnosis:sustained_cpu:100"
        );
    }

    #[test]
    fn stale_frontend_replaces_green_health_with_explicit_observing_state() {
        let store = HealthStateStore::default();
        store.frontend_heartbeat();
        store.publish(update(0)).unwrap();

        let stale = store
            .expire_stale_frontend(now_millis() + FRONTEND_HEARTBEAT_STALE_AFTER_MS + 1)
            .unwrap()
            .unwrap();

        assert_eq!(stale.update.data_status, HealthDataStatus::Stale);
        assert_eq!(stale.update.health, HealthLevel::Observing);
        assert_eq!(stale.update.reason, HealthReason::None);
        assert_eq!(stale.update.active_count, 0);
        assert!(stale.update.primary_incident.is_none());
        assert!(
            store
                .expire_stale_frontend(now_millis() + FRONTEND_HEARTBEAT_STALE_AFTER_MS + 2)
                .unwrap()
                .is_none()
        );
    }
}
