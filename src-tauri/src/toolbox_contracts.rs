use serde::{Deserialize, Serialize};

pub const TOOLBOX_CONTRACT_VERSION: &str = "toolbox-v1";
pub const TOOLBOX_EVENT: &str = "core-robin:toolbox-event";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Preparing,
    Running,
    Stopping,
    Ended,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceStatus {
    Acquiring,
    Active,
    Releasing,
    Released,
    ReleaseUnconfirmed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    OutputReady,
    Exporting,
    Stopping,
    Completed,
    Cancelled,
    Expired,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputValidation {
    Unverified,
    Verified,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalReason {
    Completed,
    Cancelled,
    Expired,
    Failed,
    Deadline,
    Interrupted,
    Unknown,
    ReleaseUnconfirmed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxCapability {
    pub state: String,
    pub reason: Option<String>,
    pub platform: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxRequest {
    pub request_id: String,
    pub expected_revision: Option<u64>,
    pub generation: Option<u64>,
    pub reset_epoch: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxJobRequest {
    #[serde(flatten)]
    pub common: ToolboxRequest,
    pub tool_id: String,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxSession {
    pub session_id: String,
    pub tool_id: String,
    pub status: SessionStatus,
    pub generation: u64,
    pub created_at_ms: u64,
    pub terminal_reason: Option<TerminalReason>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxResource {
    pub resource_id: String,
    pub session_id: String,
    pub status: ResourceStatus,
    pub bytes_reserved: u64,
    pub release_confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxJob {
    pub job_id: String,
    pub session_id: String,
    pub status: JobStatus,
    pub generation: u64,
    pub reset_epoch: u64,
    pub output_expires_at_ms: Option<u64>,
    pub output_token: Option<ToolboxOutputToken>,
    pub terminal_reason: Option<TerminalReason>,
    pub error: Option<ToolboxError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxOutputToken {
    pub token: String,
    pub job_id: String,
    pub generation: u64,
    pub reset_epoch: u64,
    pub byte_length: u64,
    pub expires_at_ms: u64,
    pub validation: OutputValidation,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxSnapshot {
    pub contract_version: String,
    pub service_instance_id: String,
    pub revision: u64,
    pub reset_epoch: u64,
    pub sessions: Vec<ToolboxSession>,
    pub resources: Vec<ToolboxResource>,
    pub jobs: Vec<ToolboxJob>,
    pub capabilities: std::collections::BTreeMap<String, ToolboxCapability>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolboxEvent {
    Snapshot { snapshot: ToolboxSnapshot },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_state_contract_in_camel_case() {
        let snapshot = ToolboxSnapshot {
            contract_version: TOOLBOX_CONTRACT_VERSION.to_owned(),
            service_instance_id: "instance".to_owned(),
            revision: 2,
            reset_epoch: 1,
            sessions: Vec::new(),
            resources: Vec::new(),
            jobs: Vec::new(),
            capabilities: std::collections::BTreeMap::new(),
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["contractVersion"], "toolbox-v1");
        assert_eq!(json["serviceInstanceId"], "instance");
        assert_eq!(json["resetEpoch"], 1);

        let event = serde_json::to_value(ToolboxEvent::Snapshot { snapshot }).unwrap();
        assert_eq!(event["type"], "snapshot");
        assert_eq!(event["snapshot"]["contractVersion"], "toolbox-v1");
    }
}
