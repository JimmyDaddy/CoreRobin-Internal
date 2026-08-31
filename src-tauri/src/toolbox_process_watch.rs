use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::error::CommandError;
use crate::identity::read_birth_token;
use crate::models::ProcessKey;
use crate::toolbox_power::{PowerRequest, PowerService, ProcessWatchPowerStatus};

/// The maximum number of selected process instances observed by one service.
pub const MAX_ACTIVE_PROCESS_WATCHES: usize = 3;

/// One service owns one polling worker, regardless of the number of watches.
const MAX_RETAINED_TERMINAL_WATCHES: usize = MAX_ACTIVE_PROCESS_WATCHES;
const MIN_DURATION_MINUTES: u64 = 1;
const MAX_DURATION_MINUTES: u64 = 12 * 60;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const UNKNOWN_RETRY_INTERVAL: Duration = Duration::from_secs(30);

/// A read-only request for one already-selected process identity.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessWatchRequest {
    pub key: ProcessKey,
    pub duration_minutes: u64,
    #[serde(default)]
    pub keep_awake: bool,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessWatchCancelRequest {
    pub watch_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessWatchSnapshotView {
    pub watch_id: u64,
    pub key: ProcessKey,
    pub status: ProcessWatchStatus,
    pub started_at_ms: u64,
    pub deadline_at_ms: u64,
    pub last_checked_at_ms: u64,
    pub keep_awake_status: ProcessWatchKeepAwakeStatus,
}

impl ProcessWatchSnapshotView {
    pub fn from_snapshot(snapshot: &ProcessWatchSnapshot, now: Instant, now_ms: u64) -> Self {
        Self {
            watch_id: snapshot.watch_id,
            key: snapshot.key.clone(),
            status: snapshot.status,
            started_at_ms: project_instant(snapshot.started_at, now, now_ms),
            deadline_at_ms: project_instant(snapshot.deadline, now, now_ms),
            last_checked_at_ms: project_instant(snapshot.last_checked_at, now, now_ms),
            keep_awake_status: snapshot.keep_awake_status,
        }
    }
}

fn project_instant(value: Instant, now: Instant, now_ms: u64) -> u64 {
    if value >= now {
        now_ms.saturating_add(value.duration_since(now).as_millis().min(u64::MAX as u128) as u64)
    } else {
        now_ms.saturating_sub(now.duration_since(value).as_millis().min(u64::MAX as u128) as u64)
    }
}

/// The current state of a selected process instance.
///
/// `IdentityChanged` is terminal: it proves that the selected instance ended,
/// but deliberately does not begin observing the replacement PID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessWatchStatus {
    Running,
    Exited,
    Unknown,
    IdentityChanged,
    Interrupted,
    Expired,
    Cancelled,
}

impl ProcessWatchStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Exited
                | Self::IdentityChanged
                | Self::Interrupted
                | Self::Expired
                | Self::Cancelled
        )
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessWatchKeepAwakeStatus {
    NotRequested,
    Active,
    LowBatteryEnded,
    Expired,
    Cancelled,
    Unavailable,
}

/// A service-owned watch snapshot. Times are monotonic and are intended for
/// in-process coordination; the parent service owns any wall-clock projection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessWatchSnapshot {
    pub watch_id: u64,
    pub key: ProcessKey,
    pub status: ProcessWatchStatus,
    pub started_at: Instant,
    pub deadline: Instant,
    pub last_checked_at: Instant,
    pub keep_awake_requested: bool,
    pub keep_awake_status: ProcessWatchKeepAwakeStatus,
}

/// The result of creating a watch. A repeated `ProcessKey` returns the active
/// watch without extending its deadline.
pub struct ProcessWatchStart {
    pub snapshot: ProcessWatchSnapshot,
}

/// A bounded, read-only process observation service.
///
/// The service keeps at most three active watches, three terminal snapshots,
/// and exactly one worker thread. It deliberately has no process-control API.
pub struct ProcessWatchService {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl ProcessWatchService {
    pub fn new() -> Result<Self, CommandError> {
        Self::with_reader_and_timing_and_power(
            Arc::new(read_birth_token),
            WatchTiming {
                poll_interval: POLL_INTERVAL,
                unknown_retry_interval: UNKNOWN_RETRY_INTERVAL,
            },
            None,
        )
    }

    /// Uses the same PowerService instance as the independent keep-awake slot.
    /// AppState owns the wiring so this module does not construct a second
    /// platform assertion or depend on a Tauri command handler.
    #[allow(dead_code)]
    pub fn with_power_service(power: Arc<Mutex<PowerService>>) -> Result<Self, CommandError> {
        Self::with_reader_and_timing_and_power(
            Arc::new(read_birth_token),
            WatchTiming {
                poll_interval: POLL_INTERVAL,
                unknown_retry_interval: UNKNOWN_RETRY_INTERVAL,
            },
            Some(Arc::new(PowerServiceWatchAttachment { power })),
        )
    }

    /// Creates a watch after validating the selected `ProcessKey` and duration.
    /// The selected identity is checked before insertion and every later poll.
    pub fn start(&self, request: ProcessWatchRequest) -> Result<ProcessWatchStart, CommandError> {
        validate_request(&request)?;
        let keep_awake_requested = request.keep_awake;
        let duration_minutes = request.duration_minutes;

        {
            let state = self
                .shared
                .state
                .lock()
                .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
            if state.shutdown {
                return Err(CommandError::new(
                    "process_watch_stopped",
                    "The process watch service is stopping.",
                ));
            }
            if let Some(snapshot) = state.active_for_key(&request.key) {
                return Ok(self.start_result(snapshot));
            }
            if state.active.len() >= MAX_ACTIVE_PROCESS_WATCHES {
                return Err(CommandError::new(
                    "process_watch_limit",
                    "Observe at most three processes at a time.",
                ));
            }
        }

        // No state lock is held while asking the OS for identity information.
        // A slow or unavailable identity source must not block cancellation.
        let initial_status = classify_observation(
            &request.key,
            (self.shared.read_birth_token)(request.key.pid),
        );
        let started_at = Instant::now();
        let duration = Duration::from_secs(request.duration_minutes.saturating_mul(60));
        let deadline = started_at + duration;

        let snapshot = {
            let mut state = self
                .shared
                .state
                .lock()
                .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
            if state.shutdown {
                return Err(CommandError::new(
                    "process_watch_stopped",
                    "The process watch service is stopping.",
                ));
            }
            if let Some(snapshot) = state.active_for_key(&request.key) {
                return Ok(self.start_result(snapshot));
            }
            if state.active.len() >= MAX_ACTIVE_PROCESS_WATCHES {
                return Err(CommandError::new(
                    "process_watch_limit",
                    "Observe at most three processes at a time.",
                ));
            }
            state.insert(
                request.key,
                initial_status,
                keep_awake_requested,
                started_at,
                deadline,
                self.shared.timing,
            )
        };

        let snapshot = self.attach_keep_awake(snapshot, duration_minutes)?;
        self.shared.wake.notify_one();
        Ok(self.start_result(snapshot))
    }

    /// Returns an active or bounded retained terminal snapshot.
    #[cfg(test)]
    pub fn snapshot(&self, watch_id: u64) -> Result<Option<ProcessWatchSnapshot>, CommandError> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
        Ok(state.snapshot(watch_id))
    }

    /// Returns all active watches plus the bounded terminal cache, ordered by ID.
    pub fn snapshots(&self) -> Result<Vec<ProcessWatchSnapshot>, CommandError> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
        Ok(state.snapshots())
    }

    #[cfg(test)]
    pub fn active_count(&self) -> Result<usize, CommandError> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
        Ok(state.active.len())
    }

    /// Cancels a watch by its service-generated ID. Repeating the call returns
    /// the retained terminal snapshot while it remains in the bounded cache.
    pub fn cancel(&self, watch_id: u64) -> Result<Option<ProcessWatchSnapshot>, CommandError> {
        cancel_watch(&self.shared, watch_id)
    }

    /// Stops the one polling worker. Dropping the service also calls this.
    pub fn shutdown(&mut self) {
        let active = if let Ok(mut state) = self.shared.state.lock() {
            state.shutdown = true;
            state
                .active
                .iter()
                .map(|entry| entry.snapshot.clone())
                .collect()
        } else {
            Vec::new()
        };
        detach_process_power(&self.shared, &active);
        self.shared.wake.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    fn start_result(&self, snapshot: ProcessWatchSnapshot) -> ProcessWatchStart {
        ProcessWatchStart { snapshot }
    }

    fn attach_keep_awake(
        &self,
        snapshot: ProcessWatchSnapshot,
        duration_minutes: u64,
    ) -> Result<ProcessWatchSnapshot, CommandError> {
        if !snapshot.keep_awake_requested || snapshot.status.is_terminal() {
            return Ok(snapshot);
        }
        let status = self
            .shared
            .power
            .as_ref()
            .map(|power| power.attach(snapshot.watch_id, duration_minutes))
            .unwrap_or(ProcessWatchKeepAwakeStatus::Unavailable);
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| CommandError::internal("Process watch state is unavailable."))?;
        Ok(state
            .set_keep_awake_status(snapshot.watch_id, status)
            .unwrap_or(snapshot))
    }

    fn with_reader_and_timing_and_power(
        read_birth_token: Arc<BirthTokenReader>,
        timing: WatchTiming,
        power: Option<Arc<dyn ProcessWatchPowerAttachment>>,
    ) -> Result<Self, CommandError> {
        let shared = Arc::new(Shared {
            read_birth_token,
            power,
            timing,
            state: Mutex::new(WatchBook::default()),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("core-robin-process-watch".to_owned())
            .spawn(move || worker_loop(worker_shared))
            .map_err(|error| {
                CommandError::internal(format!("Could not start process watch worker: {error}"))
            })?;

        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }
}

impl Drop for ProcessWatchService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

type BirthTokenReader = dyn Fn(u32) -> Result<String, CommandError> + Send + Sync;

trait ProcessWatchPowerAttachment: Send + Sync {
    fn attach(&self, watch_id: u64, duration_minutes: u64) -> ProcessWatchKeepAwakeStatus;
    fn detach(&self, watch_id: u64);
    fn status(&self, watch_id: u64) -> Option<ProcessWatchKeepAwakeStatus>;
}

#[allow(dead_code)]
struct PowerServiceWatchAttachment {
    power: Arc<Mutex<PowerService>>,
}

impl ProcessWatchPowerAttachment for PowerServiceWatchAttachment {
    fn attach(&self, watch_id: u64, duration_minutes: u64) -> ProcessWatchKeepAwakeStatus {
        let Ok(mut power) = self.power.lock() else {
            return ProcessWatchKeepAwakeStatus::Unavailable;
        };
        match power.attach_process_watch(
            watch_id,
            PowerRequest {
                request_id: format!("process-watch-{watch_id}"),
                duration_minutes,
            },
        ) {
            Ok(_) => ProcessWatchKeepAwakeStatus::Active,
            Err(_) => ProcessWatchKeepAwakeStatus::Unavailable,
        }
    }

    fn detach(&self, watch_id: u64) {
        if let Ok(mut power) = self.power.lock() {
            power.detach_process_watch(watch_id);
        }
    }

    fn status(&self, watch_id: u64) -> Option<ProcessWatchKeepAwakeStatus> {
        let power = self.power.lock().ok()?;
        power
            .process_watch_power_status(watch_id)
            .map(map_power_status)
    }
}

#[allow(dead_code)]
fn map_power_status(status: ProcessWatchPowerStatus) -> ProcessWatchKeepAwakeStatus {
    match status {
        ProcessWatchPowerStatus::Active => ProcessWatchKeepAwakeStatus::Active,
        ProcessWatchPowerStatus::LowBatteryEnded => ProcessWatchKeepAwakeStatus::LowBatteryEnded,
        ProcessWatchPowerStatus::Expired => ProcessWatchKeepAwakeStatus::Expired,
        ProcessWatchPowerStatus::Cancelled => ProcessWatchKeepAwakeStatus::Cancelled,
        ProcessWatchPowerStatus::Unavailable => ProcessWatchKeepAwakeStatus::Unavailable,
    }
}

struct Shared {
    read_birth_token: Arc<BirthTokenReader>,
    power: Option<Arc<dyn ProcessWatchPowerAttachment>>,
    timing: WatchTiming,
    state: Mutex<WatchBook>,
    wake: Condvar,
}

#[derive(Clone, Copy)]
struct WatchTiming {
    poll_interval: Duration,
    unknown_retry_interval: Duration,
}

struct ActiveWatch {
    snapshot: ProcessWatchSnapshot,
    next_check_at: Instant,
    unknown_since: Option<Instant>,
}

#[derive(Default)]
struct WatchBook {
    active: Vec<ActiveWatch>,
    terminal: VecDeque<ProcessWatchSnapshot>,
    next_watch_id: u64,
    shutdown: bool,
}

impl WatchBook {
    fn active_for_key(&self, key: &ProcessKey) -> Option<ProcessWatchSnapshot> {
        self.active
            .iter()
            .find(|entry| entry.snapshot.key == *key)
            .map(|entry| entry.snapshot.clone())
    }

    fn insert(
        &mut self,
        key: ProcessKey,
        status: ProcessWatchStatus,
        keep_awake_requested: bool,
        started_at: Instant,
        deadline: Instant,
        timing: WatchTiming,
    ) -> ProcessWatchSnapshot {
        self.next_watch_id = self.next_watch_id.saturating_add(1);
        let snapshot = ProcessWatchSnapshot {
            watch_id: self.next_watch_id,
            key,
            status,
            started_at,
            deadline,
            last_checked_at: started_at,
            keep_awake_requested,
            keep_awake_status: if keep_awake_requested {
                ProcessWatchKeepAwakeStatus::Unavailable
            } else {
                ProcessWatchKeepAwakeStatus::NotRequested
            },
        };

        if status.is_terminal() {
            self.retain_terminal(snapshot.clone());
        } else {
            self.active.push(ActiveWatch {
                next_check_at: next_check_at(started_at, status, timing),
                unknown_since: (status == ProcessWatchStatus::Unknown).then_some(started_at),
                snapshot: snapshot.clone(),
            });
        }
        snapshot
    }

    #[cfg(test)]
    fn snapshot(&self, watch_id: u64) -> Option<ProcessWatchSnapshot> {
        self.active
            .iter()
            .find(|entry| entry.snapshot.watch_id == watch_id)
            .map(|entry| entry.snapshot.clone())
            .or_else(|| {
                self.terminal
                    .iter()
                    .find(|snapshot| snapshot.watch_id == watch_id)
                    .cloned()
            })
    }

    fn snapshots(&self) -> Vec<ProcessWatchSnapshot> {
        let mut snapshots = self
            .active
            .iter()
            .map(|entry| entry.snapshot.clone())
            .chain(self.terminal.iter().cloned())
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| snapshot.watch_id);
        snapshots
    }

    fn expire_due(&mut self, now: Instant) -> Vec<ProcessWatchSnapshot> {
        let mut finished = Vec::new();
        let mut index = 0;
        while index < self.active.len() {
            if self.active[index].snapshot.deadline <= now {
                finished.push(self.finish_at(index, ProcessWatchStatus::Expired, now));
            } else {
                index += 1;
            }
        }
        finished
    }

    fn due_watch_ids(&self, now: Instant) -> Vec<u64> {
        self.active
            .iter()
            .filter(|entry| entry.next_check_at <= now)
            .map(|entry| entry.snapshot.watch_id)
            .collect()
    }

    fn key_for(&self, watch_id: u64) -> Option<ProcessKey> {
        self.active
            .iter()
            .find(|entry| entry.snapshot.watch_id == watch_id)
            .map(|entry| entry.snapshot.key.clone())
    }

    fn set_keep_awake_status(
        &mut self,
        watch_id: u64,
        keep_awake_status: ProcessWatchKeepAwakeStatus,
    ) -> Option<ProcessWatchSnapshot> {
        self.active
            .iter_mut()
            .find(|entry| entry.snapshot.watch_id == watch_id)
            .map(|entry| {
                entry.snapshot.keep_awake_status = keep_awake_status;
                entry.snapshot.clone()
            })
            .or_else(|| {
                self.terminal
                    .iter()
                    .find(|snapshot| snapshot.watch_id == watch_id)
                    .cloned()
            })
    }

    fn apply_check(
        &mut self,
        watch_id: u64,
        status: ProcessWatchStatus,
        keep_awake_status: Option<ProcessWatchKeepAwakeStatus>,
        checked_at: Instant,
        timing: WatchTiming,
    ) -> Option<ProcessWatchSnapshot> {
        let index = self
            .active
            .iter()
            .position(|entry| entry.snapshot.watch_id == watch_id)?;

        if let Some(keep_awake_status) = keep_awake_status {
            self.active[index].snapshot.keep_awake_status = keep_awake_status;
        }
        if self.active[index].snapshot.deadline <= checked_at {
            Some(self.finish_at(index, ProcessWatchStatus::Expired, checked_at))
        } else if status.is_terminal() {
            Some(self.finish_at(index, status, checked_at))
        } else {
            let entry = &mut self.active[index];
            entry.snapshot.status = status;
            entry.snapshot.last_checked_at = checked_at;
            if status == ProcessWatchStatus::Unknown {
                let unknown_since = entry.unknown_since.get_or_insert(checked_at);
                if checked_at.duration_since(*unknown_since) >= timing.unknown_retry_interval {
                    return Some(self.finish_at(
                        index,
                        ProcessWatchStatus::Interrupted,
                        checked_at,
                    ));
                }
            } else {
                entry.unknown_since = None;
            }
            entry.next_check_at = next_check_at(checked_at, status, timing);
            None
        }
    }

    fn cancel(&mut self, watch_id: u64, cancelled_at: Instant) -> Option<ProcessWatchSnapshot> {
        if let Some(index) = self
            .active
            .iter()
            .position(|entry| entry.snapshot.watch_id == watch_id)
        {
            return Some(self.finish_at(index, ProcessWatchStatus::Cancelled, cancelled_at));
        }
        self.terminal
            .iter()
            .find(|snapshot| snapshot.watch_id == watch_id)
            .cloned()
    }

    fn next_wake_at(&self) -> Option<Instant> {
        self.active
            .iter()
            .map(|entry| entry.snapshot.deadline.min(entry.next_check_at))
            .min()
    }

    fn finish_at(
        &mut self,
        index: usize,
        status: ProcessWatchStatus,
        finished_at: Instant,
    ) -> ProcessWatchSnapshot {
        let mut entry = self.active.remove(index);
        entry.snapshot.status = status;
        entry.snapshot.last_checked_at = finished_at;
        if entry.snapshot.keep_awake_requested
            && entry.snapshot.keep_awake_status == ProcessWatchKeepAwakeStatus::Active
        {
            entry.snapshot.keep_awake_status = if status == ProcessWatchStatus::Expired {
                ProcessWatchKeepAwakeStatus::Expired
            } else {
                ProcessWatchKeepAwakeStatus::Cancelled
            };
        }
        let snapshot = entry.snapshot;
        self.retain_terminal(snapshot.clone());
        snapshot
    }

    fn retain_terminal(&mut self, snapshot: ProcessWatchSnapshot) {
        while self.terminal.len() >= MAX_RETAINED_TERMINAL_WATCHES {
            self.terminal.pop_front();
        }
        self.terminal.push_back(snapshot);
    }
}

fn validate_request(request: &ProcessWatchRequest) -> Result<(), CommandError> {
    if request.key.pid == 0 || request.key.birth_token.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_process_key",
            "Choose a process instance with a PID and birth token.",
        ));
    }
    if !(MIN_DURATION_MINUTES..=MAX_DURATION_MINUTES).contains(&request.duration_minutes) {
        return Err(CommandError::new(
            "invalid_duration",
            "Process watch duration must be between 1 minute and 12 hours.",
        ));
    }
    Ok(())
}

fn classify_birth_token(
    key: &ProcessKey,
    result: Result<String, CommandError>,
) -> ProcessWatchStatus {
    match result {
        Ok(current) if current == key.birth_token => ProcessWatchStatus::Running,
        Ok(_) => ProcessWatchStatus::IdentityChanged,
        Err(error) if error.code == "process_exited" => ProcessWatchStatus::Exited,
        Err(_) => ProcessWatchStatus::Unknown,
    }
}

fn classify_observation(
    key: &ProcessKey,
    result: Result<String, CommandError>,
) -> ProcessWatchStatus {
    let status = classify_birth_token(key, result);
    if status == ProcessWatchStatus::Unknown && process_is_definitely_missing(key.pid) {
        ProcessWatchStatus::Exited
    } else {
        status
    }
}

/// A failed identity read alone is never proof of exit. This supplementary,
/// read-only presence check only upgrades that failure when the OS can prove
/// that no process currently owns the PID.
fn process_is_definitely_missing(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return true;
        };
        if unsafe { libc::kill(pid, 0) } == 0 {
            return false;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return std::io::Error::last_os_error().raw_os_error()
                == Some(ERROR_INVALID_PARAMETER as i32);
        }
        unsafe {
            CloseHandle(handle);
        }
        return false;
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

fn next_check_at(checked_at: Instant, status: ProcessWatchStatus, timing: WatchTiming) -> Instant {
    let interval = match status {
        ProcessWatchStatus::Unknown => timing.unknown_retry_interval,
        ProcessWatchStatus::Running => timing.poll_interval,
        ProcessWatchStatus::Exited
        | ProcessWatchStatus::IdentityChanged
        | ProcessWatchStatus::Interrupted
        | ProcessWatchStatus::Expired
        | ProcessWatchStatus::Cancelled => return checked_at,
    };
    checked_at + interval
}

fn cancel_watch(
    shared: &Arc<Shared>,
    watch_id: u64,
) -> Result<Option<ProcessWatchSnapshot>, CommandError> {
    let snapshot = shared
        .state
        .lock()
        .map_err(|_| CommandError::internal("Process watch state is unavailable."))?
        .cancel(watch_id, Instant::now());
    if let Some(snapshot) = snapshot.as_ref() {
        detach_process_power(shared, std::slice::from_ref(snapshot));
    }
    shared.wake.notify_one();
    Ok(snapshot)
}

fn detach_process_power(shared: &Shared, snapshots: &[ProcessWatchSnapshot]) {
    let Some(power) = shared.power.as_ref() else {
        return;
    };
    for snapshot in snapshots {
        if snapshot.keep_awake_requested {
            power.detach(snapshot.watch_id);
        }
    }
}

fn worker_loop(shared: Arc<Shared>) {
    loop {
        let (expired, due_watch_ids) = {
            let mut state = lock_for_worker(&shared);
            if state.shutdown {
                return;
            }
            let now = Instant::now();
            let expired = state.expire_due(now);
            (expired, state.due_watch_ids(now))
        };
        detach_process_power(&shared, &expired);

        for watch_id in due_watch_ids {
            let Some(key) = lock_for_worker(&shared).key_for(watch_id) else {
                continue;
            };
            let status = classify_observation(&key, (shared.read_birth_token)(key.pid));
            let keep_awake_status = shared
                .power
                .as_ref()
                .and_then(|power| power.status(watch_id));
            let mut state = lock_for_worker(&shared);
            if state.shutdown {
                return;
            }
            let finished = state.apply_check(
                watch_id,
                status,
                keep_awake_status,
                Instant::now(),
                shared.timing,
            );
            drop(state);
            if let Some(snapshot) = finished {
                detach_process_power(&shared, std::slice::from_ref(&snapshot));
            }
        }

        let state = lock_for_worker(&shared);
        if state.shutdown {
            return;
        }
        let Some(wake_at) = state.next_wake_at() else {
            drop(wait_for_change(&shared, state));
            continue;
        };
        let wait_for = wake_at.saturating_duration_since(Instant::now());
        drop(wait_for_timeout(&shared, state, wait_for));
    }
}

fn lock_for_worker(shared: &Shared) -> std::sync::MutexGuard<'_, WatchBook> {
    shared
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_for_change<'a>(
    shared: &'a Shared,
    state: std::sync::MutexGuard<'a, WatchBook>,
) -> std::sync::MutexGuard<'a, WatchBook> {
    shared
        .wake
        .wait(state)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_for_timeout<'a>(
    shared: &'a Shared,
    state: std::sync::MutexGuard<'a, WatchBook>,
    timeout: Duration,
) -> std::sync::MutexGuard<'a, WatchBook> {
    shared
        .wake
        .wait_timeout(state, timeout)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .0
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    use super::*;

    const FAST_TIMING: WatchTiming = WatchTiming {
        poll_interval: Duration::from_millis(5),
        unknown_retry_interval: Duration::from_millis(5),
    };

    fn key(pid: u32, token: &str) -> ProcessKey {
        ProcessKey {
            pid,
            birth_token: token.to_owned(),
        }
    }

    fn request(pid: u32, token: &str, duration_minutes: u64) -> ProcessWatchRequest {
        ProcessWatchRequest {
            key: key(pid, token),
            duration_minutes,
            keep_awake: false,
        }
    }

    fn service_with_reader(
        reader: impl Fn(u32) -> Result<String, CommandError> + Send + Sync + 'static,
    ) -> ProcessWatchService {
        ProcessWatchService::with_reader_and_timing_and_power(Arc::new(reader), FAST_TIMING, None)
            .unwrap()
    }

    struct MockPowerAttachment {
        attached: Mutex<Vec<u64>>,
        detached: Mutex<Vec<u64>>,
        status: Mutex<ProcessWatchKeepAwakeStatus>,
    }

    impl Default for MockPowerAttachment {
        fn default() -> Self {
            Self {
                attached: Mutex::new(Vec::new()),
                detached: Mutex::new(Vec::new()),
                status: Mutex::new(ProcessWatchKeepAwakeStatus::NotRequested),
            }
        }
    }

    impl ProcessWatchPowerAttachment for MockPowerAttachment {
        fn attach(&self, watch_id: u64, _duration_minutes: u64) -> ProcessWatchKeepAwakeStatus {
            self.attached.lock().unwrap().push(watch_id);
            *self.status.lock().unwrap()
        }

        fn detach(&self, watch_id: u64) {
            self.detached.lock().unwrap().push(watch_id);
        }

        fn status(&self, _watch_id: u64) -> Option<ProcessWatchKeepAwakeStatus> {
            Some(*self.status.lock().unwrap())
        }
    }

    fn service_with_power(
        reader: impl Fn(u32) -> Result<String, CommandError> + Send + Sync + 'static,
        power: Arc<MockPowerAttachment>,
    ) -> ProcessWatchService {
        ProcessWatchService::with_reader_and_timing_and_power(
            Arc::new(reader),
            FAST_TIMING,
            Some(power),
        )
        .unwrap()
    }

    fn keep_awake_request(pid: u32, token: &str, duration_minutes: u64) -> ProcessWatchRequest {
        ProcessWatchRequest {
            key: key(pid, token),
            duration_minutes,
            keep_awake: true,
        }
    }

    fn wait_for_status(
        service: &ProcessWatchService,
        watch_id: u64,
        expected: ProcessWatchStatus,
    ) -> ProcessWatchSnapshot {
        for _ in 0..100 {
            if let Some(snapshot) = service.snapshot(watch_id).unwrap()
                && snapshot.status == expected
            {
                return snapshot;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("watch {watch_id} did not reach {expected:?}");
    }

    #[test]
    fn rejects_invalid_process_keys_and_durations_before_reading_identity() {
        let reads = Arc::new(AtomicUsize::new(0));
        let reader_reads = Arc::clone(&reads);
        let service = service_with_reader(move |_| {
            reader_reads.fetch_add(1, Ordering::Relaxed);
            Ok("birth".to_owned())
        });

        let invalid_key = match service.start(request(0, "birth", 60)) {
            Err(error) => error,
            Ok(_) => panic!("an invalid process key must be rejected"),
        };
        assert_eq!(invalid_key.code, "invalid_process_key");
        let invalid_duration = match service.start(request(7, "birth", 0)) {
            Err(error) => error,
            Ok(_) => panic!("an invalid duration must be rejected"),
        };
        assert_eq!(invalid_duration.code, "invalid_duration");
        assert_eq!(reads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn classifies_identity_reads_without_treating_unknown_as_exit() {
        let selected = key(7, "selected");
        assert_eq!(
            classify_birth_token(&selected, Ok("selected".to_owned())),
            ProcessWatchStatus::Running
        );
        assert_eq!(
            classify_birth_token(&selected, Ok("replacement".to_owned())),
            ProcessWatchStatus::IdentityChanged
        );
        assert_eq!(
            classify_birth_token(&selected, Err(CommandError::new("process_exited", "gone"))),
            ProcessWatchStatus::Exited
        );
        assert_eq!(
            classify_birth_token(
                &selected,
                Err(CommandError::new("identity_unavailable", "unavailable"))
            ),
            ProcessWatchStatus::Unknown
        );
    }

    #[cfg(unix)]
    #[test]
    fn presence_check_only_proves_exit_for_an_impossible_unix_pid() {
        assert!(process_is_definitely_missing(u32::MAX));
    }

    #[test]
    fn deduplicates_active_process_keys_without_extending_the_deadline() {
        let service = service_with_reader(|_| Ok("birth".to_owned()));
        let first = service.start(request(7, "birth", 1)).unwrap();
        let duplicate = service.start(request(7, "birth", 12)).unwrap();

        assert_eq!(duplicate.snapshot.watch_id, first.snapshot.watch_id);
        assert_eq!(duplicate.snapshot.deadline, first.snapshot.deadline);
        assert_eq!(service.active_count().unwrap(), 1);
        assert_eq!(
            service
                .cancel(duplicate.snapshot.watch_id)
                .unwrap()
                .unwrap()
                .status,
            ProcessWatchStatus::Cancelled
        );
    }

    #[test]
    fn enforces_the_three_watch_memory_and_worker_bound() {
        let service = service_with_reader(|pid| Ok(format!("birth-{pid}")));
        for pid in 1..=MAX_ACTIVE_PROCESS_WATCHES as u32 {
            service
                .start(request(pid, &format!("birth-{pid}"), 1))
                .unwrap();
        }

        let error = match service.start(request(4, "birth-4", 1)) {
            Err(error) => error,
            Ok(_) => panic!("the fourth active watch must be rejected"),
        };
        assert_eq!(error.code, "process_watch_limit");
        assert_eq!(service.active_count().unwrap(), MAX_ACTIVE_PROCESS_WATCHES);
    }

    #[test]
    fn polling_rechecks_identity_and_never_adopts_a_reused_pid() {
        let reads = Arc::new(AtomicUsize::new(0));
        let reader_reads = Arc::clone(&reads);
        let service = service_with_reader(move |_| {
            if reader_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok("original".to_owned())
            } else {
                Ok("replacement".to_owned())
            }
        });

        let started = service.start(request(42, "original", 1)).unwrap();
        assert_eq!(started.snapshot.status, ProcessWatchStatus::Running);
        let terminal = wait_for_status(
            &service,
            started.snapshot.watch_id,
            ProcessWatchStatus::IdentityChanged,
        );

        assert_eq!(terminal.key, key(42, "original"));
        assert!(reads.load(Ordering::SeqCst) >= 2);
        assert_eq!(service.active_count().unwrap(), 0);
    }

    #[test]
    fn unknown_identity_is_retried_instead_of_being_reported_as_exit() {
        let reads = Arc::new(AtomicUsize::new(0));
        let reader_reads = Arc::clone(&reads);
        let pid = std::process::id();
        let service = service_with_reader(move |_| {
            if reader_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(CommandError::new("identity_unavailable", "unavailable"))
            } else {
                Ok("birth".to_owned())
            }
        });

        let started = service.start(request(pid, "birth", 1)).unwrap();
        assert_eq!(started.snapshot.status, ProcessWatchStatus::Unknown);
        let running = wait_for_status(
            &service,
            started.snapshot.watch_id,
            ProcessWatchStatus::Running,
        );

        assert_eq!(running.key, key(pid, "birth"));
        assert!(reads.load(Ordering::SeqCst) >= 2);
        assert_eq!(service.active_count().unwrap(), 1);
    }

    #[test]
    fn unknown_identity_for_the_full_retry_window_interrupts_the_watch() {
        let pid = std::process::id();
        let service =
            service_with_reader(|_| Err(CommandError::new("identity_unavailable", "unavailable")));
        let started = service.start(request(pid, "birth", 1)).unwrap();

        let interrupted = wait_for_status(
            &service,
            started.snapshot.watch_id,
            ProcessWatchStatus::Interrupted,
        );

        assert_eq!(interrupted.key, key(pid, "birth"));
        assert_eq!(service.active_count().unwrap(), 0);
    }

    #[test]
    fn attached_keep_awake_is_released_when_its_watch_is_cancelled() {
        let power = Arc::new(MockPowerAttachment {
            status: Mutex::new(ProcessWatchKeepAwakeStatus::Active),
            ..Default::default()
        });
        let service = service_with_power(|_| Ok("birth".to_owned()), Arc::clone(&power));
        let started = service.start(keep_awake_request(7, "birth", 60)).unwrap();

        assert_eq!(
            started.snapshot.keep_awake_status,
            ProcessWatchKeepAwakeStatus::Active
        );
        assert_eq!(
            *power.attached.lock().unwrap(),
            vec![started.snapshot.watch_id]
        );

        let cancelled = service.cancel(started.snapshot.watch_id).unwrap().unwrap();

        assert_eq!(cancelled.status, ProcessWatchStatus::Cancelled);
        assert_eq!(
            *power.detached.lock().unwrap(),
            vec![started.snapshot.watch_id]
        );
    }

    #[test]
    fn low_battery_ends_only_the_attached_keep_awake_demand() {
        let power = Arc::new(MockPowerAttachment {
            status: Mutex::new(ProcessWatchKeepAwakeStatus::LowBatteryEnded),
            ..Default::default()
        });
        let service = service_with_power(|_| Ok("birth".to_owned()), Arc::clone(&power));
        let started = service.start(keep_awake_request(7, "birth", 60)).unwrap();

        assert_eq!(
            started.snapshot.keep_awake_status,
            ProcessWatchKeepAwakeStatus::LowBatteryEnded
        );
        assert_eq!(started.snapshot.status, ProcessWatchStatus::Running);
        assert_eq!(service.active_count().unwrap(), 1);
    }

    #[test]
    fn expiry_wins_after_its_deadline_without_reading_or_controlling_the_process() {
        let now = Instant::now();
        let mut book = WatchBook::default();
        let snapshot = book.insert(
            key(7, "birth"),
            ProcessWatchStatus::Running,
            false,
            now - Duration::from_secs(61),
            now - Duration::from_secs(1),
            FAST_TIMING,
        );

        book.expire_due(now);

        assert_eq!(
            book.snapshot(snapshot.watch_id).unwrap().status,
            ProcessWatchStatus::Expired
        );
        assert!(book.active.is_empty());
    }

    #[test]
    fn cancellation_is_idempotent_and_never_changes_process_state() {
        let service = service_with_reader(|_| Ok("birth".to_owned()));
        let started = service.start(request(7, "birth", 1)).unwrap();

        let first = service.cancel(started.snapshot.watch_id).unwrap().unwrap();
        let second = service.cancel(started.snapshot.watch_id).unwrap().unwrap();

        assert_eq!(first.status, ProcessWatchStatus::Cancelled);
        assert_eq!(second, first);
        assert_eq!(service.active_count().unwrap(), 0);
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn native_reader_observes_the_current_process_without_control_privileges() {
        let pid = std::process::id();
        let token = read_birth_token(pid).expect("the current process must have a birth token");
        let service = ProcessWatchService::new().unwrap();
        let started = service.start(request(pid, &token, 1)).unwrap();

        assert_eq!(started.snapshot.status, ProcessWatchStatus::Running);
        assert_eq!(
            service
                .cancel(started.snapshot.watch_id)
                .unwrap()
                .unwrap()
                .status,
            ProcessWatchStatus::Cancelled
        );
    }
}
