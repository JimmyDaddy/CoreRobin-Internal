//! A deliberately narrow newline-delimited protocol for the optional keyboard
//! helper. The helper never receives or returns key values, text, scan codes,
//! clipboard data, or WebView messages. It can only prove readiness, renew a
//! heartbeat, report that the hook stopped being effective, and acknowledge a
//! stop request.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "keyboard-cleaning-helper-v1";
pub const MAX_FRAME_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperCapability {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEffectiveness {
    Confirmed,
    Unconfirmed,
    SilentlyIneffective,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookFailure {
    CapabilityUnavailable,
    PermissionRevoked,
    HostDisconnected,
    HookStopped,
    HookNotConfirmed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperStopReason {
    Cancelled,
    MouseActivity,
    HeartbeatLost,
    FocusLost,
    HostExited,
    Sleeping,
    PermissionRevoked,
    HookUnconfirmed,
    HookIneffective,
    Deadline,
    Completed,
    HelperUnavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartCommand {
    pub protocol_version: String,
    pub request_id: String,
    pub duration_seconds: u64,
    pub prepare_deadline_ms: u64,
    pub hard_deadline_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopCommand {
    pub protocol_version: String,
    pub request_id: String,
    pub reason: HelperStopReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadySignal {
    pub protocol_version: String,
    pub request_id: String,
    pub capability: HelperCapability,
    pub effectiveness: HookEffectiveness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeartbeatSignal {
    pub protocol_version: String,
    pub request_id: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookIneffectiveSignal {
    pub protocol_version: String,
    pub request_id: String,
    pub failure: HookFailure,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleasedSignal {
    pub protocol_version: String,
    pub request_id: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleSignal {
    pub protocol_version: String,
    pub request_id: String,
    pub reason: HelperLifecycleReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperLifecycleReason {
    MouseActivity,
    FocusLost,
    HostExited,
    Sleeping,
    PermissionRevoked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum HelperCommand {
    Start(StartCommand),
    Stop(StopCommand),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum HelperSignal {
    Ready(ReadySignal),
    Heartbeat(HeartbeatSignal),
    HookIneffective(HookIneffectiveSignal),
    Lifecycle(LifecycleSignal),
    Released(ReleasedSignal),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    FrameTooLarge,
    UnexpectedLineBreak,
    InvalidEnvelope,
    InvalidJson,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::FrameTooLarge => "helper frame exceeds the bounded protocol size",
            Self::UnexpectedLineBreak => "helper frame must be a single line",
            Self::InvalidEnvelope => "helper frame has an unexpected envelope",
            Self::InvalidJson => "helper frame is not valid JSON",
        })
    }
}

impl std::error::Error for ProtocolError {}

pub fn encode_command(command: &HelperCommand) -> Result<Vec<u8>, ProtocolError> {
    encode(command)
}

pub fn encode_signal(signal: &HelperSignal) -> Result<Vec<u8>, ProtocolError> {
    encode(signal)
}

pub fn decode_signal(frame: &[u8]) -> Result<HelperSignal, ProtocolError> {
    validate_frame(frame)?;
    validate_envelope(frame)?;
    serde_json::from_slice(frame).map_err(|_| ProtocolError::InvalidJson)
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let frame = serde_json::to_vec(value).map_err(|_| ProtocolError::InvalidJson)?;
    validate_frame(&frame)?;
    validate_envelope(&frame)?;
    Ok(frame)
}

fn validate_frame(frame: &[u8]) -> Result<(), ProtocolError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    if frame.iter().any(|byte| matches!(byte, b'\n' | b'\r')) {
        return Err(ProtocolError::UnexpectedLineBreak);
    }
    Ok(())
}

fn validate_envelope(frame: &[u8]) -> Result<(), ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_slice(frame).map_err(|_| ProtocolError::InvalidJson)?;
    let Some(object) = value.as_object() else {
        return Err(ProtocolError::InvalidEnvelope);
    };
    if object.len() != 2 || !object.contains_key("type") || !object.contains_key("payload") {
        return Err(ProtocolError::InvalidEnvelope);
    }
    Ok(())
}

#[cfg(test)]
#[path = "helper_protocol_tests.rs"]
mod tests;
