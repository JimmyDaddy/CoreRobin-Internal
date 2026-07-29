use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::models::{SystemSnapshot, SystemSummary};
use crate::monitor::SystemMonitor;

pub const SYSTEM_SNAPSHOT_EVENT: &str = "core-robin:system-snapshot";
pub const SAMPLER_STATUS_EVENT: &str = "core-robin:sampler-status";

const ACTIVE_INTERVAL_MS: u64 = 1_000;
const BACKGROUND_INTERVAL_MS: u64 = 5_000;
const MINIMUM_INTERVAL_MS: u64 = 500;
const MAXIMUM_INTERVAL_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerControl {
    pub active: bool,
    pub paused: bool,
    pub interval_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerStatus {
    pub running: bool,
    pub paused: bool,
    pub active: bool,
    pub interval_ms: u64,
    pub last_attempt_at_ms: Option<u64>,
    pub last_success_at_ms: Option<u64>,
    pub consecutive_failures: u32,
    pub degraded_reason: Option<String>,
}

#[derive(Default)]
struct SamplerState {
    latest_snapshot: Option<SystemSnapshot>,
    last_attempt_at_ms: Option<u64>,
    last_success_at_ms: Option<u64>,
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
                        );
                        sleep_interruptibly(Duration::from_millis(250), &paused);
                        continue;
                    }

                    let snapshot = sample_once(&monitor, &state);
                    if let Some(snapshot) = snapshot {
                        let _ = app.emit_to("main", SYSTEM_SNAPSHOT_EVENT, &snapshot);
                    }
                    emit_status(
                        &app,
                        &state,
                        false,
                        active.load(Ordering::Acquire),
                        &interval_ms,
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
        self.status()
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
        sample_once(&self.monitor, &self.state).ok_or_else(|| {
            self.status()
                .degraded_reason
                .unwrap_or_else(|| "Sampling failed.".into())
        })
    }

    pub fn latest_summary_or_sample(&self) -> Result<SystemSummary, String> {
        self.latest_or_sample().map(summary_from_snapshot)
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
            last_attempt_at_ms: state.last_attempt_at_ms,
            last_success_at_ms: state.last_success_at_ms,
            consecutive_failures: state.consecutive_failures,
            degraded_reason: state.degraded_reason.clone(),
        }
    }
}

fn sample_once(
    monitor: &Arc<Mutex<SystemMonitor>>,
    state: &Arc<Mutex<SamplerState>>,
) -> Option<SystemSnapshot> {
    let attempted_at_ms = now_millis();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut monitor = monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        monitor.sample()
    }));
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.last_attempt_at_ms = Some(attempted_at_ms);
    match result {
        Ok(snapshot) => {
            state.last_success_at_ms = Some(snapshot.sampled_at_ms);
            state.consecutive_failures = 0;
            state.degraded_reason = None;
            state.latest_snapshot = Some(snapshot.clone());
            Some(snapshot)
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
) {
    let state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let status = SamplerStatus {
        running: true,
        paused,
        active,
        interval_ms: interval_ms.load(Ordering::Acquire),
        last_attempt_at_ms: state.last_attempt_at_ms,
        last_success_at_ms: state.last_success_at_ms,
        consecutive_failures: state.consecutive_failures,
        degraded_reason: state.degraded_reason.clone(),
    };
    let _ = app.emit_to("main", SAMPLER_STATUS_EVENT, status);
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
    use super::{SamplerControl, SamplerService};
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
        });
        assert!(status.paused);
        assert!(!status.active);
        assert_eq!(status.interval_ms, 500);
    }
}
