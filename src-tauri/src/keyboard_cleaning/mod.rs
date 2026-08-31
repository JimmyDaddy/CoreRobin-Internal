//! Safety-first state machine for the optional keyboard-cleaning helper.
//!
//! This module is intentionally independent from Tauri and the shared Toolbox
//! service. It is safe to integrate later through a narrow command/event
//! adapter. The WebView never receives keyboard input: only lifecycle facts
//! and opaque heartbeat sequence numbers cross this boundary.

mod helper_protocol;

pub use helper_protocol::{
    HeartbeatSignal, HelperCapability, HelperCommand, HelperLifecycleReason, HelperSignal,
    HelperStopReason, HookEffectiveness, HookFailure, HookIneffectiveSignal, LifecycleSignal,
    PROTOCOL_VERSION, ProtocolError, ReadySignal, ReleasedSignal, StartCommand, StopCommand,
    decode_signal, encode_command, encode_signal,
};

pub const PREPARATION_WINDOW_MS: u64 = 3_000;
pub const HEARTBEAT_GRACE_MS: u64 = 3_000;
pub const HARD_LIMIT_MS: u64 = 180_000;
pub const ALLOWED_DURATION_SECONDS: [u64; 3] = [30, 60, 120];
const MAX_REQUEST_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Available,
    Unavailable,
}

impl Capability {
    pub const fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Unavailable,
    Preparing,
    Active,
    Releasing,
    Ended,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Cancelled,
    MouseActivity,
    HeartbeatLost,
    FocusLost,
    HostExited,
    Sleeping,
    PermissionRevoked,
    HookUnconfirmed,
    HookIneffective,
    HardDeadline,
    Completed,
    HelperUnavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookStatus {
    Unconfirmed,
    Confirmed,
    Ineffective,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyboardCleaningSnapshot {
    pub capability: Capability,
    pub status: Status,
    pub hook: HookStatus,
    pub session_id: Option<String>,
    pub duration_seconds: Option<u64>,
    pub preparation_deadline_ms: Option<u64>,
    pub active_deadline_ms: Option<u64>,
    pub hard_deadline_ms: Option<u64>,
    pub last_heartbeat_ms: Option<u64>,
    pub release_confirmed: bool,
    pub end_reason: Option<EndReason>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    Start {
        request_id: String,
        duration_seconds: u64,
        now_ms: u64,
    },
    Tick {
        now_ms: u64,
    },
    HookReady {
        request_id: String,
        capability: Capability,
        effectiveness: HookEffectiveness,
        now_ms: u64,
    },
    Heartbeat {
        request_id: String,
        sequence: u64,
        now_ms: u64,
    },
    HookIneffective {
        request_id: String,
        now_ms: u64,
    },
    HelperLifecycle {
        request_id: String,
        reason: HelperLifecycleReason,
        now_ms: u64,
    },
    MouseActivity {
        now_ms: u64,
    },
    FocusLost {
        now_ms: u64,
    },
    HostExited {
        now_ms: u64,
    },
    Sleeping {
        now_ms: u64,
    },
    PermissionRevoked {
        now_ms: u64,
    },
    Cancel {
        now_ms: u64,
    },
    ReleaseConfirmed {
        request_id: String,
        now_ms: u64,
    },
    ReleaseUnconfirmed {
        request_id: String,
        now_ms: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    StartHelper(HelperCommand),
    StopHelper(HelperCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transition {
    pub snapshot: KeyboardCleaningSnapshot,
    pub effects: Vec<Effect>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControllerError {
    CapabilityUnavailable,
    InvalidDuration,
    InvalidRequestId,
    ClockWentBackward,
    InvalidState,
    WrongRequest,
    HeartbeatOutOfOrder,
}

impl std::fmt::Display for ControllerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::CapabilityUnavailable => "keyboard cleaning is unavailable on this platform",
            Self::InvalidDuration => "duration must be 30, 60, or 120 seconds",
            Self::InvalidRequestId => "request id is empty or too long",
            Self::ClockWentBackward => "monotonic clock moved backwards",
            Self::InvalidState => "keyboard cleaning is already in use",
            Self::WrongRequest => "helper event belongs to another request",
            Self::HeartbeatOutOfOrder => "helper heartbeat sequence is not increasing",
        })
    }
}

impl std::error::Error for ControllerError {}

#[derive(Clone, Debug)]
struct Session {
    request_id: String,
    duration_seconds: u64,
    preparation_deadline_ms: u64,
    active_deadline_ms: u64,
    hard_deadline_ms: u64,
    hook: HookStatus,
    last_heartbeat_ms: Option<u64>,
    last_heartbeat_sequence: Option<u64>,
    release_confirmed: bool,
    end_reason: Option<EndReason>,
}

pub struct Controller {
    capability: Capability,
    status: Status,
    session: Option<Session>,
    last_now_ms: u64,
}

impl Controller {
    pub const fn new(capability: Capability) -> Self {
        Self {
            capability,
            status: if capability.is_available() {
                Status::Idle
            } else {
                Status::Unavailable
            },
            session: None,
            last_now_ms: 0,
        }
    }

    pub fn snapshot(&self) -> KeyboardCleaningSnapshot {
        let session = self.session.as_ref();
        KeyboardCleaningSnapshot {
            capability: self.capability,
            status: self.status,
            hook: session.map_or(HookStatus::Unconfirmed, |item| item.hook),
            session_id: session.map(|item| item.request_id.clone()),
            duration_seconds: session.map(|item| item.duration_seconds),
            preparation_deadline_ms: session.map(|item| item.preparation_deadline_ms),
            active_deadline_ms: session.map(|item| item.active_deadline_ms),
            hard_deadline_ms: session.map(|item| item.hard_deadline_ms),
            last_heartbeat_ms: session.and_then(|item| item.last_heartbeat_ms),
            release_confirmed: session.is_none_or(|item| item.release_confirmed),
            end_reason: session.and_then(|item| item.end_reason),
        }
    }

    pub fn dispatch(&mut self, event: Event) -> Result<Transition, ControllerError> {
        let now_ms = event.now_ms();
        self.observe_time(now_ms)?;

        let mut effects = Vec::new();
        if !matches!(&event, Event::Start { .. }) {
            self.advance(now_ms, &mut effects);
        }
        match event {
            Event::Start {
                request_id,
                duration_seconds,
                now_ms: _,
            } => self.start(request_id, duration_seconds, now_ms, &mut effects)?,
            Event::Tick { now_ms: _ } => self.advance(now_ms, &mut effects),
            Event::HookReady {
                request_id,
                capability,
                effectiveness,
                now_ms: _,
            } => self.hook_ready(&request_id, capability, effectiveness, now_ms, &mut effects)?,
            Event::Heartbeat {
                request_id,
                sequence,
                now_ms: _,
            } => self.heartbeat(&request_id, sequence, now_ms)?,
            Event::HookIneffective {
                request_id,
                now_ms: _,
            } => self.hook_ineffective(&request_id, now_ms, &mut effects)?,
            Event::HelperLifecycle {
                request_id,
                reason,
                now_ms: _,
            } => {
                self.ensure_request(&request_id)?;
                self.release(reason.into(), &mut effects);
            }
            Event::MouseActivity { now_ms: _ } => {
                self.release(EndReason::MouseActivity, &mut effects)
            }
            Event::FocusLost { now_ms: _ } => self.release(EndReason::FocusLost, &mut effects),
            Event::HostExited { now_ms: _ } => self.release(EndReason::HostExited, &mut effects),
            Event::Sleeping { now_ms: _ } => self.release(EndReason::Sleeping, &mut effects),
            Event::PermissionRevoked { now_ms: _ } => {
                self.release(EndReason::PermissionRevoked, &mut effects)
            }
            Event::Cancel { now_ms: _ } => self.release(EndReason::Cancelled, &mut effects),
            Event::ReleaseConfirmed {
                request_id,
                now_ms: _,
            } => self.release_ack(&request_id, true)?,
            Event::ReleaseUnconfirmed {
                request_id,
                now_ms: _,
            } => self.release_ack(&request_id, false)?,
        }

        Ok(Transition {
            snapshot: self.snapshot(),
            effects,
        })
    }

    pub fn apply_helper_signal(
        &mut self,
        signal: HelperSignal,
        now_ms: u64,
    ) -> Result<Transition, ControllerError> {
        let event = match signal {
            HelperSignal::Ready(signal) => Event::HookReady {
                request_id: self.checked_request_id(&signal.protocol_version, signal.request_id)?,
                capability: match signal.capability {
                    HelperCapability::Available => Capability::Available,
                    HelperCapability::Unavailable => Capability::Unavailable,
                },
                effectiveness: signal.effectiveness,
                now_ms,
            },
            HelperSignal::Heartbeat(signal) => Event::Heartbeat {
                request_id: self.checked_request_id(&signal.protocol_version, signal.request_id)?,
                sequence: signal.sequence,
                now_ms,
            },
            HelperSignal::HookIneffective(signal) => Event::HookIneffective {
                request_id: self.checked_request_id(&signal.protocol_version, signal.request_id)?,
                now_ms,
            },
            HelperSignal::Lifecycle(signal) => Event::HelperLifecycle {
                request_id: self.checked_request_id(&signal.protocol_version, signal.request_id)?,
                reason: signal.reason,
                now_ms,
            },
            HelperSignal::Released(signal) => {
                let request_id =
                    self.checked_request_id(&signal.protocol_version, signal.request_id)?;
                if signal.confirmed {
                    Event::ReleaseConfirmed { request_id, now_ms }
                } else {
                    Event::ReleaseUnconfirmed { request_id, now_ms }
                }
            }
        };
        self.dispatch(event)
    }

    fn start(
        &mut self,
        request_id: String,
        duration_seconds: u64,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) -> Result<(), ControllerError> {
        if !self.capability.is_available() {
            return Err(ControllerError::CapabilityUnavailable);
        }
        if !ALLOWED_DURATION_SECONDS.contains(&duration_seconds) {
            return Err(ControllerError::InvalidDuration);
        }
        if request_id.is_empty()
            || request_id.len() > MAX_REQUEST_ID_BYTES
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
        {
            return Err(ControllerError::InvalidRequestId);
        }
        if !matches!(self.status, Status::Idle | Status::Ended) {
            return Err(ControllerError::InvalidState);
        }
        let preparation_deadline_ms = now_ms.saturating_add(PREPARATION_WINDOW_MS);
        let hard_deadline_ms = now_ms.saturating_add(HARD_LIMIT_MS);
        let active_deadline_ms =
            preparation_deadline_ms.saturating_add(duration_seconds.saturating_mul(1000));
        self.session = Some(Session {
            request_id: request_id.clone(),
            duration_seconds,
            preparation_deadline_ms,
            active_deadline_ms: active_deadline_ms.min(hard_deadline_ms),
            hard_deadline_ms,
            hook: HookStatus::Unconfirmed,
            last_heartbeat_ms: None,
            last_heartbeat_sequence: None,
            release_confirmed: false,
            end_reason: None,
        });
        self.status = Status::Preparing;
        effects.push(Effect::StartHelper(HelperCommand::Start(
            helper_protocol::StartCommand {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                request_id,
                duration_seconds,
                prepare_deadline_ms: preparation_deadline_ms,
                hard_deadline_ms,
            },
        )));
        Ok(())
    }

    fn hook_ready(
        &mut self,
        request_id: &str,
        capability: Capability,
        effectiveness: HookEffectiveness,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) -> Result<(), ControllerError> {
        self.ensure_request(request_id)?;
        if !matches!(self.status, Status::Preparing) {
            return Ok(());
        }
        if !capability.is_available() {
            self.session.as_mut().expect("preparing has a session").hook = HookStatus::Ineffective;
            self.release(EndReason::HelperUnavailable, effects);
            return Ok(());
        }
        match effectiveness {
            HookEffectiveness::Confirmed => {
                let preparation_deadline_ms = self
                    .session
                    .as_ref()
                    .expect("preparing has a session")
                    .preparation_deadline_ms;
                if now_ms >= preparation_deadline_ms {
                    self.release(EndReason::HookUnconfirmed, effects);
                } else {
                    let session = self.session.as_mut().expect("preparing has a session");
                    session.hook = HookStatus::Confirmed;
                    session.last_heartbeat_ms = Some(now_ms);
                }
            }
            HookEffectiveness::Unconfirmed => {
                self.session.as_mut().expect("preparing has a session").hook =
                    HookStatus::Unconfirmed;
                self.release(EndReason::HookUnconfirmed, effects);
            }
            HookEffectiveness::SilentlyIneffective => {
                self.session.as_mut().expect("preparing has a session").hook =
                    HookStatus::Ineffective;
                self.release(EndReason::HookIneffective, effects);
            }
        }
        Ok(())
    }

    fn heartbeat(
        &mut self,
        request_id: &str,
        sequence: u64,
        now_ms: u64,
    ) -> Result<(), ControllerError> {
        self.ensure_request(request_id)?;
        if !matches!(self.status, Status::Preparing | Status::Active) {
            return Ok(());
        }
        let session = self.session.as_mut().expect("live state has a session");
        if session
            .last_heartbeat_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(ControllerError::HeartbeatOutOfOrder);
        }
        session.last_heartbeat_sequence = Some(sequence);
        session.last_heartbeat_ms = Some(now_ms);
        Ok(())
    }

    fn hook_ineffective(
        &mut self,
        request_id: &str,
        _now_ms: u64,
        effects: &mut Vec<Effect>,
    ) -> Result<(), ControllerError> {
        self.ensure_request(request_id)?;
        if !matches!(self.status, Status::Preparing | Status::Active) {
            return Ok(());
        }
        if let Some(session) = self.session.as_mut() {
            session.hook = HookStatus::Ineffective;
        }
        self.release(EndReason::HookIneffective, effects);
        Ok(())
    }

    fn advance(&mut self, now_ms: u64, effects: &mut Vec<Effect>) {
        let Some((
            preparation_deadline_ms,
            hard_deadline_ms,
            active_deadline_ms,
            hook,
            last_heartbeat_ms,
        )) = self.session.as_ref().map(|session| {
            (
                session.preparation_deadline_ms,
                session.hard_deadline_ms,
                session.active_deadline_ms,
                session.hook,
                session.last_heartbeat_ms,
            )
        })
        else {
            return;
        };
        match self.status {
            Status::Preparing if now_ms >= preparation_deadline_ms => {
                if hook == HookStatus::Confirmed {
                    self.status = Status::Active;
                } else {
                    self.release(EndReason::HookUnconfirmed, effects);
                }
            }
            Status::Active if now_ms >= hard_deadline_ms => {
                self.release(EndReason::HardDeadline, effects);
            }
            Status::Active if now_ms >= active_deadline_ms => {
                self.release(EndReason::Completed, effects);
            }
            Status::Active
                if last_heartbeat_ms
                    .is_none_or(|last| now_ms.saturating_sub(last) >= HEARTBEAT_GRACE_MS) =>
            {
                self.release(EndReason::HeartbeatLost, effects);
            }
            _ => {}
        }
    }

    fn release(&mut self, reason: EndReason, effects: &mut Vec<Effect>) {
        if !matches!(self.status, Status::Preparing | Status::Active) {
            return;
        }
        let Some(session) = self.session.as_mut() else {
            return;
        };
        session.end_reason = Some(reason);
        session.release_confirmed = false;
        self.status = Status::Releasing;
        effects.push(Effect::StopHelper(HelperCommand::Stop(
            helper_protocol::StopCommand {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                request_id: session.request_id.clone(),
                reason: reason.into(),
            },
        )));
    }

    fn release_ack(&mut self, request_id: &str, confirmed: bool) -> Result<(), ControllerError> {
        self.ensure_request(request_id)?;
        if self.status != Status::Releasing {
            return Ok(());
        }
        if let Some(session) = self.session.as_mut() {
            session.release_confirmed = confirmed;
        }
        self.status = Status::Ended;
        Ok(())
    }

    fn ensure_request(&self, request_id: &str) -> Result<(), ControllerError> {
        if self
            .session
            .as_ref()
            .is_none_or(|session| session.request_id != request_id)
        {
            return Err(ControllerError::WrongRequest);
        }
        Ok(())
    }

    fn checked_request_id(
        &self,
        protocol_version: &str,
        request_id: String,
    ) -> Result<String, ControllerError> {
        if protocol_version != PROTOCOL_VERSION {
            return Err(ControllerError::WrongRequest);
        }
        Ok(request_id)
    }

    fn observe_time(&mut self, now_ms: u64) -> Result<(), ControllerError> {
        if now_ms < self.last_now_ms {
            return Err(ControllerError::ClockWentBackward);
        }
        self.last_now_ms = now_ms;
        Ok(())
    }
}

impl Event {
    fn now_ms(&self) -> u64 {
        match self {
            Self::Start { now_ms, .. }
            | Self::Tick { now_ms }
            | Self::HookReady { now_ms, .. }
            | Self::Heartbeat { now_ms, .. }
            | Self::HookIneffective { now_ms, .. }
            | Self::HelperLifecycle { now_ms, .. }
            | Self::MouseActivity { now_ms }
            | Self::FocusLost { now_ms }
            | Self::HostExited { now_ms }
            | Self::Sleeping { now_ms }
            | Self::PermissionRevoked { now_ms }
            | Self::Cancel { now_ms }
            | Self::ReleaseConfirmed { now_ms, .. }
            | Self::ReleaseUnconfirmed { now_ms, .. } => *now_ms,
        }
    }
}

impl From<EndReason> for HelperStopReason {
    fn from(reason: EndReason) -> Self {
        match reason {
            EndReason::Cancelled => Self::Cancelled,
            EndReason::MouseActivity => Self::MouseActivity,
            EndReason::HeartbeatLost => Self::HeartbeatLost,
            EndReason::FocusLost => Self::FocusLost,
            EndReason::HostExited => Self::HostExited,
            EndReason::Sleeping => Self::Sleeping,
            EndReason::PermissionRevoked => Self::PermissionRevoked,
            EndReason::HookUnconfirmed => Self::HookUnconfirmed,
            EndReason::HookIneffective => Self::HookIneffective,
            EndReason::HardDeadline => Self::Deadline,
            EndReason::Completed => Self::Completed,
            EndReason::HelperUnavailable => Self::HelperUnavailable,
        }
    }
}

impl From<HelperLifecycleReason> for EndReason {
    fn from(reason: HelperLifecycleReason) -> Self {
        match reason {
            HelperLifecycleReason::MouseActivity => Self::MouseActivity,
            HelperLifecycleReason::FocusLost => Self::FocusLost,
            HelperLifecycleReason::HostExited => Self::HostExited,
            HelperLifecycleReason::Sleeping => Self::Sleeping,
            HelperLifecycleReason::PermissionRevoked => Self::PermissionRevoked,
        }
    }
}

use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
