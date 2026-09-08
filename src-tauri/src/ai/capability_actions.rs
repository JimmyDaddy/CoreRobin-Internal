//! User-operated cards reuse the same native tool executor and task lifecycle,
//! without a model request. Native targets stay in memory and expire.
use super::{
    service::AiService,
    tools::{NativeTarget, ToolScope},
    types::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub const TARGET_LIFETIME_MS: u64 = 10 * 60 * 1000;
pub const MAX_TARGET_SETS: usize = 16;

pub struct SavedTargets {
    pub session_id: String,
    pub epoch: u64,
    pub expires_at: u64,
    pub targets: Arc<Mutex<HashMap<String, NativeTarget>>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAction {
    Refresh,
    RequestClose,
    ForceKill,
    Trash,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityActionInput {
    pub submission_id: String,
    pub session_id: String,
    pub expected_session_revision: u64,
    pub message_id: String,
    pub step_id: String,
    pub action: CapabilityAction,
    #[serde(default)]
    pub target_refs: Vec<String>,
}

impl CapabilityActionInput {
    pub fn validate(&self) -> Result<(), AiError> {
        if [
            &self.submission_id,
            &self.session_id,
            &self.message_id,
            &self.step_id,
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 128 || value.chars().any(char::is_control))
            || self.target_refs.len() > 12
            || self
                .target_refs
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.target_refs.len()
            || self.target_refs.iter().any(|value| {
                value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
            })
        {
            return Err(AiError::new(
                "capability_action_invalid",
                "Invalid card action or target reference.",
            ));
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<String, AiError> {
        serde_json::to_string(&(
            &self.session_id,
            &self.message_id,
            &self.step_id,
            self.action,
            &self.target_refs,
        ))
        .map_err(AiError::storage)
    }
}

pub fn expired() -> AiError {
    AiError::new(
        "capability_target_expired",
        "This result can still be read, but its actions have expired. Refresh the inspection before acting.",
    )
}

pub fn source_has_target(step: &ToolStep, reference: &str) -> bool {
    let Some(value) = step
        .result
        .as_deref()
        .and_then(|output| serde_json::from_str::<serde_json::Value>(output).ok())
    else {
        return false;
    };
    let key = if step.name == "get_process_usage" {
        "processes"
    } else {
        "items"
    };
    value
        .get(key)
        .and_then(|rows| rows.as_array())
        .is_some_and(|rows| {
            rows.iter()
                .any(|row| row.get("targetRef").and_then(|value| value.as_str()) == Some(reference))
        })
}

// Only the service creates a direct run; there is no separate approval engine.
pub async fn finish_direct_action(
    service: Arc<AiService>,
    request_id: String,
    call: ToolCall,
    scope: ToolScope,
    targets: Arc<Mutex<HashMap<String, NativeTarget>>>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
) {
    let outcome = service
        .execute_single_tool(&request_id, call, scope, targets, cancelled)
        .await;
    service.finish_capability_action(&request_id, outcome);
}
