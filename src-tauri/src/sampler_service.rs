use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::background_supervisor::{BackgroundSupervisor, BackgroundSupervisorConfig};
use crate::models::{SystemSnapshot, SystemSummary};
use crate::monitor::SystemMonitor;

pub const SYSTEM_SNAPSHOT_EVENT: &str = "core-robin:system-snapshot";
pub const SYSTEM_SUMMARY_EVENT: &str = "core-robin:system-summary";
pub const SAMPLER_STATUS_EVENT: &str = "core-robin:sampler-status";

const ACTIVE_INTERVAL_MS: u64 = 1_000;
const BACKGROUND_INTERVAL_MS: u64 = 5_000;
const MINIMUM_INTERVAL_MS: u64 = 500;
const MAXIMUM_INTERVAL_MS: u64 = 60_000;
const FRONTEND_STALE_AFTER_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SamplerDataFreshness {
    Live,
    Paused,
    Stale,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SamplerSampleKind {
    Full,
    Summary,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerControl {
    pub active: bool,
    pub paused: bool,
    pub interval_ms: Option<u64>,
    pub full_snapshot_interval_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerStatus {
    pub running: bool,
    pub paused: bool,
    pub active: bool,
    pub interval_ms: u64,
    pub full_snapshot_interval_ms: Option<u64>,
    pub last_full_snapshot_at_ms: Option<u64>,
    pub last_frontend_heartbeat_at_ms: Option<u64>,
    pub data_freshness: SamplerDataFreshness,
    pub sample_kind: Option<SamplerSampleKind>,
    pub last_attempt_at_ms: Option<u64>,
    pub last_success_at_ms: Option<u64>,
    pub consecutive_failures: u32,
    pub degraded_reason: Option<String>,
}

#[derive(Default)]
struct SamplerState {
    latest_snapshot: Option<SystemSnapshot>,
    latest_summary: Option<SystemSummary>,
    last_attempt_at_ms: Option<u64>,
    last_success_at_ms: Option<u64>,
    last_full_snapshot_at_ms: Option<u64>,
    sample_kind: Option<SamplerSampleKind>,
    consecutive_failures: u32,
    degraded_reason: Option<String>,
}

pub struct SamplerService {
    monitor: Arc<Mutex<SystemMonitor>>,
    state: Arc<Mutex<SamplerState>>,
    started: AtomicBool,
    paused: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    interval_ms: Arc<AtomicU64>,
    full_snapshot_interval_ms: Arc<AtomicU64>,
    frontend_heartbeat_at_ms: Arc<AtomicU64>,
    supervisor: Arc<BackgroundSupervisor>,
}

impl SamplerService {
    pub fn new(monitor: Arc<Mutex<SystemMonitor>>) -> Self {
        Self {
            monitor,
            state: Arc::new(Mutex::new(SamplerState::default())),
            started: AtomicBool::new(false),
            paused: Arc::new(AtomicBool::new(false)),
            active: Arc::new(AtomicBool::new(true)),
            interval_ms: Arc::new(AtomicU64::new(ACTIVE_INTERVAL_MS)),
            full_snapshot_interval_ms: Arc::new(AtomicU64::new(0)),
            frontend_heartbeat_at_ms: Arc::new(AtomicU64::new(0)),
            supervisor: Arc::new(BackgroundSupervisor::default()),
        }
    }

    pub fn start(&self, app: AppHandle) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let monitor = Arc::clone(&self.monitor);
        let state = Arc::clone(&self.state);
        let paused = Arc::clone(&self.paused);
        let active = Arc::clone(&self.active);
        let interval_ms = Arc::clone(&self.interval_ms);
        let full_snapshot_interval_ms = Arc::clone(&self.full_snapshot_interval_ms);
        let frontend_heartbeat_at_ms = Arc::clone(&self.frontend_heartbeat_at_ms);
        let supervisor = Arc::clone(&self.supervisor);
        thread::Builder::new()
            .name("core-robin-native-sampler".to_owned())
            .spawn(move || {
                loop {
                    if paused.load(Ordering::Acquire) {
                        emit_status(
                            &app,
                            &state,
                            true,
                            active.load(Ordering::Acquire),
                            &interval_ms,
                            &full_snapshot_interval_ms,
                            &frontend_heartbeat_at_ms,
                        );
                        sleep_interruptibly(Duration::from_millis(250), &paused);
                        continue;
                    }

                    let active_now = active.load(Ordering::Acquire);
                    let full_interval_ms = full_snapshot_interval_ms.load(Ordering::Acquire);
                    let should_sample_full = active_now
                        || full_interval_ms > 0
                            && state
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .last_full_snapshot_at_ms
                                .is_none_or(|last| {
                                    now_millis().saturating_sub(last) >= full_interval_ms
                                });
                    if let Some(sample) = sample_once(&monitor, &state, should_sample_full) {
                        match &sample {
                            SamplerSample::Full(snapshot) => {
                                supervisor.observe_snapshot(&app, snapshot);
                            }
                            SamplerSample::Summary(summary) => {
                                supervisor.observe_summary(&app, summary);
                            }
                        }
                        match sample {
                            SamplerSample::Full(snapshot) => {
                                let _ = app.emit_to("main", SYSTEM_SNAPSHOT_EVENT, &snapshot);
                            }
                            SamplerSample::Summary(summary) => {
                                let _ = app.emit_to("main", SYSTEM_SUMMARY_EVENT, &summary);
                            }
                        }
                    }
                    emit_status(
                        &app,
                        &state,
                        false,
                        active_now,
                        &interval_ms,
                        &full_snapshot_interval_ms,
                        &frontend_heartbeat_at_ms,
                    );
                    sleep_interruptibly(
                        Duration::from_millis(interval_ms.load(Ordering::Acquire)),
                        &paused,
                    );
                }
            })
            .expect("failed to start the native sampler service");
    }

    pub fn configure(&self, control: SamplerControl) -> SamplerStatus {
        self.active.store(control.active, Ordering::Release);
        self.paused.store(control.paused, Ordering::Release);
        let default_interval = if control.active {
            ACTIVE_INTERVAL_MS
        } else {
            BACKGROUND_INTERVAL_MS
        };
        self.interval_ms.store(
            control
                .interval_ms
                .unwrap_or(default_interval)
                .clamp(MINIMUM_INTERVAL_MS, MAXIMUM_INTERVAL_MS),
            Ordering::Release,
        );
        self.full_snapshot_interval_ms.store(
            control
                .full_snapshot_interval_ms
                .map(|interval| interval.clamp(MINIMUM_INTERVAL_MS, MAXIMUM_INTERVAL_MS))
                .unwrap_or(0),
            Ordering::Release,
        );
        self.frontend_heartbeat();
        self.status()
    }

    pub fn frontend_heartbeat(&self) -> SamplerStatus {
        self.frontend_heartbeat_at_ms
            .store(now_millis(), Ordering::Release);
        self.status()
    }

    pub fn configure_supervisor(&self, config: BackgroundSupervisorConfig) {
        self.supervisor.configure(config);
    }

    pub fn latest_or_sample(&self) -> Result<SystemSnapshot, String> {
        if let Some(snapshot) = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .latest_snapshot
            .clone()
        {
            return Ok(snapshot);
        }
        sample_once(&self.monitor, &self.state, true)
            .and_then(SamplerSample::into_full)
            .ok_or_else(|| {
                self.status()
                    .degraded_reason
                    .unwrap_or_else(|| "Sampling failed.".into())
            })
    }

    pub fn latest_summary_or_sample(&self) -> Result<SystemSummary, String> {
        if let Some(summary) = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .latest_summary
            .clone()
        {
            return Ok(summary);
        }
        sample_once(&self.monitor, &self.state, false)
            .map(SamplerSample::into_summary)
            .ok_or_else(|| {
                self.status()
                    .degraded_reason
                    .unwrap_or_else(|| "Sampling failed.".into())
            })
    }

    pub fn status(&self) -> SamplerStatus {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SamplerStatus {
            running: self.started.load(Ordering::Acquire),
            paused: self.paused.load(Ordering::Acquire),
            active: self.active.load(Ordering::Acquire),
            interval_ms: self.interval_ms.load(Ordering::Acquire),
            full_snapshot_interval_ms: non_zero(
                self.full_snapshot_interval_ms.load(Ordering::Acquire),
            ),
            last_full_snapshot_at_ms: state.last_full_snapshot_at_ms,
            last_frontend_heartbeat_at_ms: non_zero(
                self.frontend_heartbeat_at_ms.load(Ordering::Acquire),
            ),
            data_freshness: data_freshness(
                self.paused.load(Ordering::Acquire),
                self.frontend_heartbeat_at_ms.load(Ordering::Acquire),
                now_millis(),
            ),
            sample_kind: state.sample_kind,
            last_attempt_at_ms: state.last_attempt_at_ms,
            last_success_at_ms: state.last_success_at_ms,
            consecutive_failures: state.consecutive_failures,
            degraded_reason: state.degraded_reason.clone(),
        }
    }
}

enum SamplerSample {
    Full(Box<SystemSnapshot>),
    Summary(Box<SystemSummary>),
}

impl SamplerSample {
    fn into_full(self) -> Option<SystemSnapshot> {
        match self {
            Self::Full(snapshot) => Some(*snapshot),
            Self::Summary(_) => None,
        }
    }

    fn into_summary(self) -> SystemSummary {
        match self {
            Self::Full(snapshot) => summary_from_snapshot(*snapshot),
            Self::Summary(summary) => *summary,
        }
    }
}

fn sample_once(
    monitor: &Arc<Mutex<SystemMonitor>>,
    state: &Arc<Mutex<SamplerState>>,
    full: bool,
) -> Option<SamplerSample> {
    let attempted_at_ms = now_millis();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut monitor = monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if full {
            SamplerSample::Full(Box::new(monitor.sample()))
        } else {
            SamplerSample::Summary(Box::new(monitor.sample_summary()))
        }
    }));
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.last_attempt_at_ms = Some(attempted_at_ms);
    match result {
        Ok(sample) => {
            let summary = match &sample {
                SamplerSample::Full(snapshot) => summary_from_snapshot((**snapshot).clone()),
                SamplerSample::Summary(summary) => (**summary).clone(),
            };
            state.last_success_at_ms = Some(summary.sampled_at_ms);
            state.consecutive_failures = 0;
            state.degraded_reason = None;
            state.latest_summary = Some(summary);
            match &sample {
                SamplerSample::Full(snapshot) => {
                    state.last_full_snapshot_at_ms = Some(snapshot.sampled_at_ms);
                    state.latest_snapshot = Some((**snapshot).clone());
                    state.sample_kind = Some(SamplerSampleKind::Full);
                }
                SamplerSample::Summary(_) => {
                    state.sample_kind = Some(SamplerSampleKind::Summary);
                }
            }
            Some(sample)
        }
        Err(reason) => {
            state.consecutive_failures = state.consecutive_failures.saturating_add(1);
            state.degraded_reason = Some(panic_message(reason));
            None
        }
    }
}

fn emit_status(
    app: &AppHandle,
    state: &Arc<Mutex<SamplerState>>,
    paused: bool,
    active: bool,
    interval_ms: &Arc<AtomicU64>,
    full_snapshot_interval_ms: &Arc<AtomicU64>,
    frontend_heartbeat_at_ms: &Arc<AtomicU64>,
) {
    let state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let status = SamplerStatus {
        running: true,
        paused,
        active,
        interval_ms: interval_ms.load(Ordering::Acquire),
        full_snapshot_interval_ms: non_zero(full_snapshot_interval_ms.load(Ordering::Acquire)),
        last_full_snapshot_at_ms: state.last_full_snapshot_at_ms,
        last_frontend_heartbeat_at_ms: non_zero(frontend_heartbeat_at_ms.load(Ordering::Acquire)),
        data_freshness: data_freshness(
            paused,
            frontend_heartbeat_at_ms.load(Ordering::Acquire),
            now_millis(),
        ),
        sample_kind: state.sample_kind,
        last_attempt_at_ms: state.last_attempt_at_ms,
        last_success_at_ms: state.last_success_at_ms,
        consecutive_failures: state.consecutive_failures,
        degraded_reason: state.degraded_reason.clone(),
    };
    let _ = app.emit_to("main", SAMPLER_STATUS_EVENT, status);
}

fn non_zero(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

fn data_freshness(paused: bool, heartbeat_at_ms: u64, now_ms: u64) -> SamplerDataFreshness {
    if paused {
        SamplerDataFreshness::Paused
    } else if heartbeat_at_ms > 0
        && now_ms.saturating_sub(heartbeat_at_ms) <= FRONTEND_STALE_AFTER_MS
    {
        SamplerDataFreshness::Live
    } else {
        SamplerDataFreshness::Stale
    }
}

fn summary_from_snapshot(snapshot: SystemSnapshot) -> SystemSummary {
    SystemSummary {
        sequence: snapshot.sequence,
        sampled_at_ms: snapshot.sampled_at_ms,
        sample_interval_ms: snapshot.sample_interval_ms,
        cpu: snapshot.cpu,
        memory: snapshot.memory,
        disk: snapshot.disk,
        network: snapshot.network,
        sensors: snapshot.sensors,
    }
}

fn sleep_interruptibly(duration: Duration, paused: &AtomicBool) {
    let ticks = duration.as_millis().div_ceil(100).max(1);
    for _ in 0..ticks {
        thread::sleep(Duration::from_millis(100));
        if paused.load(Ordering::Acquire) {
            break;
        }
    }
}

fn panic_message(reason: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = reason.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = reason.downcast_ref::<String>() {
        return message.clone();
    }
    "The native sampler stopped unexpectedly.".to_owned()
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
    use super::{
        FRONTEND_STALE_AFTER_MS, SamplerControl, SamplerDataFreshness, SamplerService,
        data_freshness,
    };
    use crate::models::{
        ProcessActionCapability, ProcessControlCapabilities, ProcessControlTargeting,
    };
    use crate::monitor::SystemMonitor;
    use std::sync::{Arc, Mutex};

    #[test]
    fn sampler_control_clamps_requested_interval() {
        let service = SamplerService::new(Arc::new(Mutex::new(SystemMonitor::new(
            ProcessControlCapabilities {
                targeting: ProcessControlTargeting::Unavailable,
                request_close: ProcessActionCapability {
                    enabled: false,
                    semantic: None,
                    disabled_reason: Some("test".to_owned()),
                },
                force_kill: ProcessActionCapability {
                    enabled: false,
                    semantic: None,
                    disabled_reason: Some("test".to_owned()),
                },
                lease_ttl_ms: 0,
            },
        ))));
        let status = service.configure(SamplerControl {
            active: false,
            paused: true,
            interval_ms: Some(1),
            full_snapshot_interval_ms: None,
        });
        assert!(status.paused);
        assert!(!status.active);
        assert_eq!(status.interval_ms, 500);
        assert_eq!(status.full_snapshot_interval_ms, None);
    }

    #[test]
    fn frontend_freshness_distinguishes_live_paused_and_stale_data() {
        assert_eq!(
            data_freshness(false, 1_000, 1_000 + FRONTEND_STALE_AFTER_MS),
            SamplerDataFreshness::Live
        );
        assert_eq!(
            data_freshness(false, 1_000, 1_001 + FRONTEND_STALE_AFTER_MS),
            SamplerDataFreshness::Stale
        );
        assert_eq!(
            data_freshness(true, 0, 1_001 + FRONTEND_STALE_AFTER_MS),
            SamplerDataFreshness::Paused
        );
    }
}
