use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;

const MINUTES_MIN: u64 = 1;
const MINUTES_MAX: u64 = 12 * 60;
const LOW_BATTERY_PERCENT: u8 = 15;
const POWER_CHECK_INTERVAL: Duration = Duration::from_secs(15);
const MAX_PENDING_COMPLETIONS: usize = 16;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerRequest {
    pub request_id: String,
    pub duration_minutes: u64,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    pub status: String,
    pub request_id: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub platform: String,
    pub reason: Option<String>,
    pub resource_status: String,
    pub release_confirmed: bool,
    pub battery_protection: String,
    pub active_demand_count: usize,
}

/// The state of a keep-awake demand attached to a process watch. A low-battery
/// release changes only this attachment; it never changes the watch's own
/// process-observation outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessWatchPowerStatus {
    Active,
    LowBatteryEnded,
    Expired,
    Cancelled,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResourceStatus {
    Active,
    Releasing,
    Released,
    ReleaseUnconfirmed,
}

impl ResourceStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Releasing => "releasing",
            Self::Released => "released",
            Self::ReleaseUnconfirmed => "release_unconfirmed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatteryProtection {
    Unknown,
    Available,
    Unavailable,
}

impl BatteryProtection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "checking",
            Self::Available => "available",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatteryState {
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    Discharging(u8),
    #[cfg(windows)]
    NotDischarging,
    Unavailable,
}

#[derive(Clone)]
struct PowerDemand {
    request_id: String,
    started_at_ms: u64,
    deadline: Duration,
    deadline_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DemandOwner {
    Independent,
    Scheduler,
    ProcessWatch(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerCompletionStatus {
    Cancelled,
    Expired,
    LowBattery,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerCompletionOwner {
    Independent,
    Scheduler,
    ProcessWatch(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PowerCompletion {
    pub request_id: String,
    pub started_at_ms: u64,
    pub owner: PowerCompletionOwner,
    pub status: PowerCompletionStatus,
}

struct PowerBook {
    independent: Option<PowerDemand>,
    scheduler: Option<PowerDemand>,
    process_watches: BTreeMap<u64, PowerDemand>,
    process_statuses: BTreeMap<u64, ProcessWatchPowerStatus>,
    resource_status: ResourceStatus,
    release_confirmed: bool,
    release_retry_requested: bool,
    reason: Option<String>,
    battery_protection: BatteryProtection,
    closed: bool,
    completions: VecDeque<PowerCompletion>,
}

impl Default for PowerBook {
    fn default() -> Self {
        Self {
            independent: None,
            scheduler: None,
            process_watches: BTreeMap::new(),
            process_statuses: BTreeMap::new(),
            resource_status: ResourceStatus::Released,
            release_confirmed: true,
            release_retry_requested: false,
            reason: None,
            battery_protection: BatteryProtection::Unknown,
            closed: false,
            completions: VecDeque::new(),
        }
    }
}

impl PowerBook {
    fn demand_count(&self) -> usize {
        usize::from(self.independent.is_some())
            + usize::from(self.scheduler.is_some())
            + self.process_watches.len()
    }

    fn has_demands(&self) -> bool {
        self.demand_count() > 0
    }

    fn next_deadline(&self) -> Option<Duration> {
        self.independent
            .iter()
            .chain(self.scheduler.iter())
            .chain(self.process_watches.values())
            .map(|demand| demand.deadline)
            .min()
    }

    fn assertion_timeout(&self, now: Duration) -> Duration {
        self.independent
            .iter()
            .chain(self.scheduler.iter())
            .chain(self.process_watches.values())
            .map(|demand| demand.deadline.saturating_sub(now))
            .max()
            .unwrap_or(Duration::ZERO)
    }

    fn expires_at_ms(&self) -> Option<u64> {
        self.independent
            .iter()
            .chain(self.scheduler.iter())
            .chain(self.process_watches.values())
            .map(|demand| demand.deadline_at_ms)
            .max()
    }

    fn prune_expired(&mut self, now: Duration) {
        let mut expired = false;
        if self
            .independent
            .as_ref()
            .is_some_and(|demand| demand.deadline <= now)
            && let Some(demand) = self.independent.take()
        {
            self.retain_completion(
                demand,
                DemandOwner::Independent,
                PowerCompletionStatus::Expired,
            );
            expired = true;
        }
        if self
            .scheduler
            .as_ref()
            .is_some_and(|demand| demand.deadline <= now)
            && let Some(demand) = self.scheduler.take()
        {
            self.retain_completion(
                demand,
                DemandOwner::Scheduler,
                PowerCompletionStatus::Expired,
            );
            expired = true;
        }
        let expired_watch_ids = self
            .process_watches
            .iter()
            .filter_map(|(watch_id, demand)| (demand.deadline <= now).then_some(*watch_id))
            .collect::<Vec<_>>();
        for watch_id in expired_watch_ids {
            if let Some(demand) = self.process_watches.remove(&watch_id) {
                self.retain_completion(
                    demand,
                    DemandOwner::ProcessWatch(watch_id),
                    PowerCompletionStatus::Expired,
                );
            }
            self.process_statuses
                .insert(watch_id, ProcessWatchPowerStatus::Expired);
            expired = true;
        }
        if expired && !self.has_demands() {
            self.reason = Some("deadline".to_owned());
        }
    }

    fn end_for_low_battery(&mut self) {
        if let Some(demand) = self.independent.take() {
            self.retain_completion(
                demand,
                DemandOwner::Independent,
                PowerCompletionStatus::LowBattery,
            );
        }
        if let Some(demand) = self.scheduler.take() {
            self.retain_completion(
                demand,
                DemandOwner::Scheduler,
                PowerCompletionStatus::LowBattery,
            );
        }
        for (watch_id, demand) in std::mem::take(&mut self.process_watches) {
            self.retain_completion(
                demand,
                DemandOwner::ProcessWatch(watch_id),
                PowerCompletionStatus::LowBattery,
            );
            self.process_statuses
                .insert(watch_id, ProcessWatchPowerStatus::LowBatteryEnded);
        }
        self.reason = Some("low_battery".to_owned());
    }

    fn end_all(&mut self, reason: &str) {
        let status = match reason {
            "system_sleep" | "application_exit" => PowerCompletionStatus::Interrupted,
            _ => PowerCompletionStatus::Failed,
        };
        if let Some(demand) = self.independent.take() {
            self.retain_completion(demand, DemandOwner::Independent, status);
        }
        if let Some(demand) = self.scheduler.take() {
            self.retain_completion(demand, DemandOwner::Scheduler, status);
        }
        for (watch_id, demand) in std::mem::take(&mut self.process_watches) {
            self.retain_completion(demand, DemandOwner::ProcessWatch(watch_id), status);
            self.process_statuses
                .insert(watch_id, ProcessWatchPowerStatus::Cancelled);
        }
        self.reason = Some(reason.to_owned());
    }

    fn set_demand(&mut self, owner: DemandOwner, demand: PowerDemand) {
        match owner {
            DemandOwner::Independent => self.independent = Some(demand),
            DemandOwner::Scheduler => self.scheduler = Some(demand),
            DemandOwner::ProcessWatch(watch_id) => {
                self.process_watches.insert(watch_id, demand);
                self.process_statuses
                    .insert(watch_id, ProcessWatchPowerStatus::Active);
            }
        }
    }

    fn remove_demand(&mut self, owner: DemandOwner) {
        match owner {
            DemandOwner::Independent => {
                if let Some(demand) = self.independent.take() {
                    self.retain_completion(
                        demand,
                        DemandOwner::Independent,
                        PowerCompletionStatus::Failed,
                    );
                }
            }
            DemandOwner::Scheduler => {
                if let Some(demand) = self.scheduler.take() {
                    self.retain_completion(
                        demand,
                        DemandOwner::Scheduler,
                        PowerCompletionStatus::Failed,
                    );
                }
            }
            DemandOwner::ProcessWatch(watch_id) => {
                if let Some(demand) = self.process_watches.remove(&watch_id) {
                    self.retain_completion(
                        demand,
                        DemandOwner::ProcessWatch(watch_id),
                        PowerCompletionStatus::Failed,
                    );
                }
                self.process_statuses
                    .insert(watch_id, ProcessWatchPowerStatus::Unavailable);
            }
        }
    }

    fn retain_completion(
        &mut self,
        demand: PowerDemand,
        owner: DemandOwner,
        status: PowerCompletionStatus,
    ) {
        while self.completions.len() >= MAX_PENDING_COMPLETIONS {
            self.completions.pop_front();
        }
        self.completions.push_back(PowerCompletion {
            request_id: demand.request_id,
            started_at_ms: demand.started_at_ms,
            owner: match owner {
                DemandOwner::Independent => PowerCompletionOwner::Independent,
                DemandOwner::Scheduler => PowerCompletionOwner::Scheduler,
                DemandOwner::ProcessWatch(watch_id) => PowerCompletionOwner::ProcessWatch(watch_id),
            },
            status,
        });
    }

    fn snapshot(&self) -> PowerState {
        let demand_count = self.demand_count();
        let status = if demand_count > 0 && self.resource_status == ResourceStatus::Active {
            "active"
        } else if matches!(
            self.resource_status,
            ResourceStatus::Releasing | ResourceStatus::ReleaseUnconfirmed
        ) {
            "stopping"
        } else {
            "inactive"
        };
        PowerState {
            status: status.to_owned(),
            request_id: self
                .independent
                .as_ref()
                .map(|demand| demand.request_id.clone()),
            expires_at_ms: self.expires_at_ms(),
            platform: platform_name().to_owned(),
            reason: self.reason.clone(),
            resource_status: self.resource_status.as_str().to_owned(),
            release_confirmed: self.release_confirmed,
            battery_protection: if demand_count == 0 {
                "not_active".to_owned()
            } else {
                self.battery_protection.as_str().to_owned()
            },
            active_demand_count: demand_count,
        }
    }
}

trait PowerAssertion: Send {
    fn set_timeout(&mut self, timeout: Duration) -> Result<(), CommandError>;
    fn release(&mut self) -> Result<(), CommandError>;
}

trait PowerBackend: Send + Sync {
    fn acquire(&self, timeout: Duration) -> Result<Box<dyn PowerAssertion>, CommandError>;
    fn battery_state(&self) -> BatteryState;
}

struct NativePowerBackend;

impl PowerBackend for NativePowerBackend {
    fn acquire(&self, timeout: Duration) -> Result<Box<dyn PowerAssertion>, CommandError> {
        #[cfg(target_os = "macos")]
        {
            Ok(Box::new(NativePowerAssertion::new(timeout)?))
        }
        #[cfg(windows)]
        {
            let _ = timeout;
            return Ok(Box::new(NativePowerAssertion::new()?));
        }
        #[cfg(target_os = "linux")]
        {
            let _ = timeout;
            Err(CommandError::new(
                "power_backend_requires_logind",
                "A Portal or logind idle-inhibitor backend must be configured for this Linux build.",
            ))
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        {
            let _ = timeout;
            Err(CommandError::new(
                "power_unavailable",
                "A safe native keep-awake backend is not available on this build.",
            ))
        }
    }

    fn battery_state(&self) -> BatteryState {
        #[cfg(target_os = "macos")]
        {
            macos_battery_state()
        }
        #[cfg(windows)]
        {
            return windows_battery_state();
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            BatteryState::Unavailable
        }
    }
}

struct PowerShared {
    backend: Arc<dyn PowerBackend>,
    timing: PowerTiming,
    book: Mutex<PowerBook>,
    changed: Condvar,
}

#[derive(Clone, Copy)]
struct PowerTiming {
    battery_check_interval: Duration,
}

impl Default for PowerTiming {
    fn default() -> Self {
        Self {
            battery_check_interval: POWER_CHECK_INTERVAL,
        }
    }
}

struct PowerLease {
    worker: Option<JoinHandle<()>>,
}

impl PowerLease {
    fn join(mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Owns the single real operating-system assertion and aggregates independent,
/// process-watch, and scheduler demands. The deadline worker owns the assertion
/// handle so request updates cannot be delayed by normal service work.
pub struct PowerService {
    shared: Arc<PowerShared>,
    lease: Option<PowerLease>,
}

#[allow(dead_code)]
impl PowerService {
    pub fn new() -> Self {
        Self::with_backend_and_timing(Arc::new(NativePowerBackend), PowerTiming::default())
    }

    pub fn snapshot(&self) -> PowerState {
        self.lock_book().snapshot()
    }

    /// Drains power-demand terminal events exactly once. The application layer
    /// owns persistence and notification policy; the power worker only emits a
    /// bounded, privacy-safe completion record.
    pub fn take_completions(&self) -> Vec<PowerCompletion> {
        let mut book = self.lock_book();
        book.completions.drain(..).collect()
    }

    /// Starts or updates the one independent keep-awake slot without touching
    /// process-watch or scheduler demands.
    pub fn start(&mut self, request: PowerRequest) -> Result<PowerState, CommandError> {
        validate_request(&request)?;
        self.reap_finished_lease();
        self.ensure_not_closed()?;
        let now = monotonic_now();
        let demand = demand_for(&request, now);
        let should_acquire = !self.lock_book().has_demands();
        if should_acquire {
            self.start_new_lease(DemandOwner::Independent, demand)?;
            return Ok(self.snapshot());
        }

        let mut book = self.lock_book();
        self.ensure_active_resource(&book)?;
        book.independent = Some(demand);
        book.reason = None;
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_one();
        Ok(state)
    }

    /// Starts a scheduler-originated request only when no independent or
    /// process-watch demand exists. It deliberately never extends another
    /// request because a skipped schedule must remain a skipped schedule.
    pub fn start_if_vacant(&mut self, request: PowerRequest) -> Result<PowerState, CommandError> {
        validate_request(&request)?;
        self.reap_finished_lease();
        self.ensure_not_closed()?;
        if self.lock_book().has_demands() {
            return Err(CommandError::new(
                "keep_awake_busy",
                "Another keep-awake request is already active.",
            ));
        }
        let demand = demand_for(&request, monotonic_now());
        self.start_new_lease(DemandOwner::Scheduler, demand)?;
        Ok(self.snapshot())
    }

    /// Attaches a single demand to a selected process-watch session. The caller
    /// must detach it when that watch reaches any terminal outcome.
    pub fn attach_process_watch(
        &mut self,
        watch_id: u64,
        request: PowerRequest,
    ) -> Result<PowerState, CommandError> {
        if watch_id == 0 {
            return Err(CommandError::new(
                "invalid_process_watch",
                "A process watch ID is required for attached keep-awake.",
            ));
        }
        validate_request(&request)?;
        self.reap_finished_lease();
        self.ensure_not_closed()?;
        let demand = demand_for(&request, monotonic_now());
        let should_acquire = !self.lock_book().has_demands();
        if should_acquire {
            self.start_new_lease(DemandOwner::ProcessWatch(watch_id), demand)?;
            return Ok(self.snapshot());
        }

        let mut book = self.lock_book();
        self.ensure_active_resource(&book)?;
        book.process_watches.insert(watch_id, demand);
        book.process_statuses
            .insert(watch_id, ProcessWatchPowerStatus::Active);
        book.reason = None;
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_one();
        Ok(state)
    }

    /// Removes only one attached process-watch demand. Other demands continue
    /// to own the same operating-system assertion.
    pub fn detach_process_watch(&mut self, watch_id: u64) -> PowerState {
        let mut book = self.lock_book();
        if book.process_watches.remove(&watch_id).is_some() {
            book.process_statuses
                .insert(watch_id, ProcessWatchPowerStatus::Cancelled);
            if !book.has_demands() {
                book.reason = Some("process_watch_ended".to_owned());
            }
        }
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_one();
        state
    }

    pub fn process_watch_power_status(&self, watch_id: u64) -> Option<ProcessWatchPowerStatus> {
        let book = self.lock_book();
        book.process_watches
            .contains_key(&watch_id)
            .then_some(ProcessWatchPowerStatus::Active)
            .or_else(|| book.process_statuses.get(&watch_id).copied())
    }

    /// Cancels only the independent slot. If a scheduler or process watch still
    /// owns a demand, the native assertion remains active and the returned state
    /// reports that fact instead of falsely claiming it was released.
    pub fn cancel(&mut self) -> PowerState {
        let mut book = self.lock_book();
        if let Some(demand) = book.independent.take() {
            book.retain_completion(
                demand,
                DemandOwner::Independent,
                PowerCompletionStatus::Cancelled,
            );
            book.reason = Some(if book.has_demands() {
                "other_keep_awake_demands_active".to_owned()
            } else {
                "user_requested".to_owned()
            });
        }
        if book.resource_status == ResourceStatus::ReleaseUnconfirmed {
            book.resource_status = ResourceStatus::Releasing;
            book.release_retry_requested = true;
            book.reason = Some("release_retry_requested".to_owned());
        }
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_one();
        state
    }

    /// Ends every toolbox-owned demand during the global clear barrier. Unlike
    /// the user-facing cancel action this also removes scheduler and attached
    /// process-watch demands, and drops all pre-clear completions so a late
    /// worker transition cannot be projected into the new history epoch.
    pub fn clear_all(&mut self) -> PowerState {
        let mut book = self.lock_book();
        book.end_all("toolbox_clear");
        book.completions.clear();
        if book.resource_status == ResourceStatus::ReleaseUnconfirmed {
            book.resource_status = ResourceStatus::Releasing;
            book.release_retry_requested = true;
            book.release_confirmed = false;
            book.reason = Some("release_retry_requested".to_owned());
        }
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_all();
        state
    }

    /// Retries a failed release while the deadline worker still owns the
    /// platform assertion. The operation is intentionally narrow and
    /// idempotent: a confirmed or already-running release simply returns the
    /// current state, while only `release_unconfirmed` wakes the worker.
    pub fn retry_release(&mut self) -> Result<PowerState, CommandError> {
        let mut book = self.lock_book();
        match book.resource_status {
            ResourceStatus::ReleaseUnconfirmed => {
                book.resource_status = ResourceStatus::Releasing;
                book.release_retry_requested = true;
                book.reason = Some("release_retry_requested".to_owned());
            }
            ResourceStatus::Releasing | ResourceStatus::Released => return Ok(book.snapshot()),
            ResourceStatus::Active => {
                return Err(CommandError::new(
                    "power_release_not_needed",
                    "The keep-awake resource is still active; stop it before retrying release.",
                ));
            }
        }
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_all();
        Ok(state)
    }

    /// Must be called from the application's power-sleep notification path.
    /// It releases rather than attempting to reassert on wake; the elapsed-time
    /// clock also prevents an already-expired demand from being revived.
    pub fn handle_system_sleep(&mut self) -> PowerState {
        let mut book = self.lock_book();
        book.end_all("system_sleep");
        let state = book.snapshot();
        drop(book);
        self.shared.changed.notify_one();
        state
    }

    pub fn shutdown(&mut self) {
        {
            let mut book = self.lock_book();
            book.closed = true;
            book.end_all("application_exit");
        }
        self.shared.changed.notify_all();
        if let Some(lease) = self.lease.take() {
            lease.join();
        }
    }

    fn with_backend_and_timing(backend: Arc<dyn PowerBackend>, timing: PowerTiming) -> Self {
        Self {
            shared: Arc::new(PowerShared {
                backend,
                timing,
                book: Mutex::new(PowerBook::default()),
                changed: Condvar::new(),
            }),
            lease: None,
        }
    }

    fn ensure_not_closed(&self) -> Result<(), CommandError> {
        if self.lock_book().closed {
            return Err(CommandError::new(
                "power_service_stopped",
                "The keep-awake service is stopping.",
            ));
        }
        Ok(())
    }

    fn ensure_active_resource(&self, book: &PowerBook) -> Result<(), CommandError> {
        if book.resource_status == ResourceStatus::ReleaseUnconfirmed {
            return Err(CommandError::new(
                "power_release_unconfirmed",
                "The previous keep-awake request has not confirmed release yet.",
            ));
        }
        if book.resource_status != ResourceStatus::Active {
            return Err(CommandError::new(
                "power_unavailable",
                "The existing keep-awake resource is no longer active.",
            ));
        }
        Ok(())
    }

    fn start_new_lease(
        &mut self,
        owner: DemandOwner,
        initial_demand: PowerDemand,
    ) -> Result<(), CommandError> {
        if self.lock_book().resource_status == ResourceStatus::ReleaseUnconfirmed {
            return Err(CommandError::new(
                "power_release_unconfirmed",
                "The previous keep-awake request has not confirmed release yet.",
            ));
        }
        if matches!(
            self.shared.backend.battery_state(),
            BatteryState::Discharging(percent) if percent <= LOW_BATTERY_PERCENT
        ) {
            let mut book = self.lock_book();
            book.battery_protection = BatteryProtection::Available;
            book.reason = Some("low_battery".to_owned());
            return Err(CommandError::new(
                "power_low_battery",
                "Keep-awake is unavailable while the battery is at or below 15% and discharging.",
            ));
        }
        let now = monotonic_now();
        let timeout = initial_demand.deadline.saturating_sub(now);
        let assertion = self.shared.backend.acquire(timeout)?;
        {
            let mut book = self.lock_book();
            book.resource_status = ResourceStatus::Active;
            book.release_confirmed = false;
            book.battery_protection = BatteryProtection::Unknown;
            book.set_demand(owner, initial_demand);
            book.reason = None;
        }
        let shared = Arc::clone(&self.shared);
        let assertion_slot = Arc::new(Mutex::new(Some(assertion)));
        let worker_assertion_slot = Arc::clone(&assertion_slot);
        let worker = thread::Builder::new()
            .name("core-robin-toolbox-power-deadline".to_owned())
            .spawn(move || {
                let assertion = worker_assertion_slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .expect("power assertion must be present when the worker starts");
                power_worker(shared, assertion);
            })
            .map_err(|error| {
                let release = assertion_slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .map(|mut assertion| assertion.release())
                    .unwrap_or(Ok(()));
                let mut book = self.lock_book();
                book.remove_demand(owner);
                book.resource_status = ResourceStatus::Releasing;
                drop(book);
                finish_release(&self.shared, release);
                CommandError::internal(format!(
                    "Could not start the power deadline worker: {error}"
                ))
            })?;
        self.lease = Some(PowerLease {
            worker: Some(worker),
        });
        Ok(())
    }

    fn reap_finished_lease(&mut self) {
        let should_join = {
            let book = self.lock_book();
            !book.has_demands()
                && book.resource_status == ResourceStatus::Released
                && self.lease.is_some()
        };
        if should_join {
            self.shared.changed.notify_all();
            if let Some(lease) = self.lease.take() {
                lease.join();
            }
        }
    }

    fn lock_book(&self) -> std::sync::MutexGuard<'_, PowerBook> {
        self.shared
            .book
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for PowerService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_request(request: &PowerRequest) -> Result<(), CommandError> {
    if request.request_id.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "requestId is required.",
        ));
    }
    if !(MINUTES_MIN..=MINUTES_MAX).contains(&request.duration_minutes) {
        return Err(CommandError::new(
            "invalid_duration",
            "Keep-awake duration must be between 1 minute and 12 hours.",
        ));
    }
    Ok(())
}

fn demand_for(request: &PowerRequest, now: Duration) -> PowerDemand {
    let duration = Duration::from_secs(request.duration_minutes.saturating_mul(60));
    PowerDemand {
        request_id: request.request_id.clone(),
        started_at_ms: now_millis(),
        deadline: now.saturating_add(duration),
        deadline_at_ms: now_millis()
            .saturating_add(duration.as_millis().min(u64::MAX as u128) as u64),
    }
}

fn power_worker(shared: Arc<PowerShared>, mut assertion: Box<dyn PowerAssertion>) {
    let mut last_timeout = Duration::ZERO;
    let mut last_battery_check = Duration::ZERO;
    loop {
        let now = monotonic_now();
        let (should_check_battery, should_release, timeout, wait_for) = {
            let mut book = lock_book(&shared);
            book.prune_expired(now);
            let should_check_battery =
                now.saturating_sub(last_battery_check) >= shared.timing.battery_check_interval;
            if !book.has_demands() {
                book.resource_status = ResourceStatus::Releasing;
                (false, true, Duration::ZERO, Duration::ZERO)
            } else {
                let timeout = book.assertion_timeout(now);
                let next_deadline = book.next_deadline().unwrap_or(now);
                let next_battery_check =
                    last_battery_check.saturating_add(shared.timing.battery_check_interval);
                let wake_at = next_deadline.min(next_battery_check);
                (
                    should_check_battery,
                    false,
                    timeout,
                    wake_at.saturating_sub(now),
                )
            }
        };

        if should_release {
            if retry_release_after_failure(&shared, &mut assertion) {
                continue;
            }
            return;
        }

        if timeout != last_timeout {
            if let Err(error) = assertion.set_timeout(timeout) {
                {
                    let mut book = lock_book(&shared);
                    book.end_all("timeout_update_failed");
                    book.reason = Some(format!("timeout_update_failed:{}", error.code));
                    book.resource_status = ResourceStatus::Releasing;
                }
                if retry_release_after_failure(&shared, &mut assertion) {
                    continue;
                }
                return;
            }
            last_timeout = timeout;
        }

        if should_check_battery {
            last_battery_check = now;
            let battery = shared.backend.battery_state();
            let mut book = lock_book(&shared);
            match battery {
                BatteryState::Discharging(percent) if percent <= LOW_BATTERY_PERCENT => {
                    book.battery_protection = BatteryProtection::Available;
                    book.end_for_low_battery();
                }
                BatteryState::Discharging(_) => {
                    book.battery_protection = BatteryProtection::Available;
                }
                #[cfg(windows)]
                BatteryState::NotDischarging => {
                    book.battery_protection = BatteryProtection::Available;
                }
                BatteryState::Unavailable => {
                    book.battery_protection = BatteryProtection::Unavailable;
                }
            }
            if !book.has_demands() {
                book.resource_status = ResourceStatus::Releasing;
                drop(book);
                if retry_release_after_failure(&shared, &mut assertion) {
                    continue;
                }
                return;
            }
        }

        let book = lock_book(&shared);
        drop(wait_for_change(&shared, book, wait_for));
    }
}

fn finish_release(shared: &PowerShared, release: Result<(), CommandError>) {
    let mut book = lock_book(shared);
    match release {
        Ok(()) => {
            book.resource_status = ResourceStatus::Released;
            book.release_confirmed = true;
        }
        Err(error) => {
            book.resource_status = ResourceStatus::ReleaseUnconfirmed;
            book.release_confirmed = false;
            book.reason = Some(format!("release_unconfirmed:{}", error.code));
        }
    }
}

fn retry_release_after_failure(
    shared: &PowerShared,
    assertion: &mut Box<dyn PowerAssertion>,
) -> bool {
    match assertion.release() {
        Ok(()) => {
            finish_release(shared, Ok(()));
            false
        }
        Err(error) => {
            finish_release(shared, Err(error));
            let mut book = lock_book(shared);
            while !book.release_retry_requested && !book.closed {
                book = wait_for_change(shared, book, Duration::from_secs(60));
            }
            if book.closed {
                return false;
            }
            book.release_retry_requested = false;
            book.resource_status = ResourceStatus::Releasing;
            book.release_confirmed = false;
            drop(book);
            true
        }
    }
}

fn lock_book(shared: &PowerShared) -> std::sync::MutexGuard<'_, PowerBook> {
    shared
        .book
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_for_change<'a>(
    shared: &'a PowerShared,
    book: std::sync::MutexGuard<'a, PowerBook>,
    timeout: Duration,
) -> std::sync::MutexGuard<'a, PowerBook> {
    shared
        .changed
        .wait_timeout(book, timeout)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .0
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// Uses clocks that continue across system suspend where the platform exposes
/// one. The wall clock is intentionally used only for UI projection.
#[cfg(target_os = "macos")]
fn monotonic_now() -> Duration {
    let mut timebase = MachTimebaseInfo { numer: 0, denom: 0 };
    let status = unsafe { mach_timebase_info(&mut timebase) };
    if status == 0 && timebase.denom != 0 {
        let nanos = unsafe { mach_continuous_time() }.saturating_mul(u64::from(timebase.numer))
            / u64::from(timebase.denom);
        return Duration::from_nanos(nanos);
    }
    static FALLBACK_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    FALLBACK_EPOCH
        .get_or_init(std::time::Instant::now)
        .elapsed()
}

#[cfg(windows)]
fn monotonic_now() -> Duration {
    Duration::from_millis(unsafe { GetTickCount64() })
}

#[cfg(target_os = "linux")]
fn monotonic_now() -> Duration {
    let mut timestamp = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut timestamp) } == 0 {
        let seconds = u64::try_from(timestamp.tv_sec).unwrap_or_default();
        let nanos = u32::try_from(timestamp.tv_nsec).unwrap_or_default();
        return Duration::new(seconds, nanos);
    }
    static FALLBACK_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    FALLBACK_EPOCH
        .get_or_init(std::time::Instant::now)
        .elapsed()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn monotonic_now() -> Duration {
    static FALLBACK_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    FALLBACK_EPOCH
        .get_or_init(std::time::Instant::now)
        .elapsed()
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

#[cfg(target_os = "macos")]
struct NativePowerAssertion {
    assertion_id: Option<u32>,
}

#[cfg(target_os = "macos")]
impl NativePowerAssertion {
    fn new(timeout: Duration) -> Result<Self, CommandError> {
        use std::ffi::CString;

        let kind = CString::new("PreventUserIdleSystemSleep").expect("literal has no NUL");
        let name = CString::new("CoreRobin Toolbox keep-awake").expect("literal has no NUL");
        let kind_ref = unsafe { cf_string(kind.as_c_str().as_ptr()) };
        let name_ref = unsafe { cf_string(name.as_c_str().as_ptr()) };
        if kind_ref.is_null() || name_ref.is_null() {
            if !kind_ref.is_null() {
                unsafe { cf_release(kind_ref) };
            }
            if !name_ref.is_null() {
                unsafe { cf_release(name_ref) };
            }
            return Err(CommandError::internal(
                "Could not allocate the macOS power assertion name.",
            ));
        }
        let mut assertion_id = 0_u32;
        let status =
            unsafe { IOPMAssertionCreateWithName(kind_ref, 255, name_ref, &mut assertion_id) };
        unsafe {
            cf_release(kind_ref);
            cf_release(name_ref);
        }
        if status != 0 {
            return Err(CommandError::new(
                "power_unavailable",
                format!("macOS refused the power assertion ({status})."),
            ));
        }
        let mut assertion = Self {
            assertion_id: Some(assertion_id),
        };
        if let Err(error) = assertion.set_timeout(timeout) {
            let _ = assertion.release();
            return Err(error);
        }
        Ok(assertion)
    }
}

#[cfg(target_os = "macos")]
impl PowerAssertion for NativePowerAssertion {
    fn set_timeout(&mut self, timeout: Duration) -> Result<(), CommandError> {
        let Some(assertion_id) = self.assertion_id else {
            return Err(CommandError::new(
                "power_release_failed",
                "The macOS power assertion was already released.",
            ));
        };
        let seconds = timeout.as_secs_f64().max(1.0);
        let status = unsafe { IOPMAssertionSetTimeout(assertion_id, seconds) };
        if status == 0 {
            Ok(())
        } else {
            Err(CommandError::new(
                "power_timeout_failed",
                format!("macOS could not set the power assertion timeout ({status})."),
            ))
        }
    }

    fn release(&mut self) -> Result<(), CommandError> {
        let Some(assertion_id) = self.assertion_id else {
            return Ok(());
        };
        let status = unsafe { IOPMAssertionRelease(assertion_id) };
        if status == 0 {
            self.assertion_id = None;
            Ok(())
        } else {
            Err(CommandError::new(
                "power_release_failed",
                format!("macOS could not release the power assertion ({status})."),
            ))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for NativePowerAssertion {
    fn drop(&mut self) {
        if let Some(assertion_id) = self.assertion_id.take() {
            unsafe {
                IOPMAssertionRelease(assertion_id);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_battery_state() -> BatteryState {
    use std::ffi::CString;

    let state_key = CString::new("Power Source State").expect("literal has no NUL");
    let battery_value = CString::new("Battery Power").expect("literal has no NUL");
    let capacity_key = CString::new("Current Capacity").expect("literal has no NUL");
    unsafe {
        let state_key = cf_string(state_key.as_c_str().as_ptr());
        let battery_value = cf_string(battery_value.as_c_str().as_ptr());
        let capacity_key = cf_string(capacity_key.as_c_str().as_ptr());
        if state_key.is_null() || battery_value.is_null() || capacity_key.is_null() {
            if !state_key.is_null() {
                cf_release(state_key);
            }
            if !battery_value.is_null() {
                cf_release(battery_value);
            }
            if !capacity_key.is_null() {
                cf_release(capacity_key);
            }
            return BatteryState::Unavailable;
        }
        let info = IOPSCopyPowerSourcesInfo();
        if info.is_null() {
            cf_release(state_key);
            cf_release(battery_value);
            cf_release(capacity_key);
            return BatteryState::Unavailable;
        }
        let list = IOPSCopyPowerSourcesList(info);
        if list.is_null() {
            cf_release(info);
            cf_release(state_key);
            cf_release(battery_value);
            cf_release(capacity_key);
            return BatteryState::Unavailable;
        }
        let mut result = BatteryState::Unavailable;
        for index in 0..CFArrayGetCount(list) {
            let source = CFArrayGetValueAtIndex(list, index);
            let description = IOPSGetPowerSourceDescription(info, source);
            if description.is_null() {
                continue;
            }
            let source_state = CFDictionaryGetValue(description, state_key);
            if source_state.is_null() || CFEqual(source_state, battery_value) == 0 {
                continue;
            }
            let value = CFDictionaryGetValue(description, capacity_key);
            let mut percent = 0_i32;
            if !value.is_null()
                && CFNumberGetValue(value, 3, &mut percent as *mut i32 as *mut _) != 0
            {
                result = u8::try_from(percent)
                    .ok()
                    .filter(|percent| *percent <= 100)
                    .map(BatteryState::Discharging)
                    .unwrap_or(BatteryState::Unavailable);
                break;
            }
        }
        cf_release(list);
        cf_release(info);
        cf_release(state_key);
        cf_release(battery_value);
        cf_release(capacity_key);
        result
    }
}

#[cfg(target_os = "macos")]
type CFStringRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFTypeRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFArrayRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFDictionaryRef = *const std::ffi::c_void;

#[cfg(target_os = "macos")]
unsafe fn cf_string(value: *const std::ffi::c_char) -> CFStringRef {
    unsafe { CFStringCreateWithCString(std::ptr::null(), value, 0x0800_0100) }
}

#[cfg(target_os = "macos")]
unsafe fn cf_release(value: CFTypeRef) {
    unsafe { CFRelease(value) }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: CFStringRef,
        level: u32,
        assertion_name: CFStringRef,
        assertion_id: *mut u32,
    ) -> i32;
    fn IOPMAssertionSetTimeout(assertion_id: u32, timeout: f64) -> i32;
    fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
    fn IOPSCopyPowerSourcesList(info: CFTypeRef) -> CFArrayRef;
    fn IOPSGetPowerSourceDescription(info: CFTypeRef, source: CFTypeRef) -> CFDictionaryRef;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const std::ffi::c_void,
        value: *const std::ffi::c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(value: CFTypeRef);
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> CFTypeRef;
    fn CFDictionaryGetValue(dictionary: CFDictionaryRef, key: *const std::ffi::c_void)
    -> CFTypeRef;
    fn CFEqual(left: CFTypeRef, right: CFTypeRef) -> u8;
    fn CFNumberGetValue(number: CFTypeRef, number_type: i32, value: *mut std::ffi::c_void) -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "System")]
unsafe extern "C" {
    fn mach_continuous_time() -> u64;
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
}

#[cfg(windows)]
struct NativePowerAssertion {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl NativePowerAssertion {
    fn new() -> Result<Self, CommandError> {
        use windows_sys::Win32::System::Power::{
            PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
        };
        use windows_sys::Win32::System::Threading::{
            POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
        };

        let mut reason = "CoreRobin Toolbox keep-awake"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() {
            return Err(CommandError::new(
                "power_unavailable",
                "Windows could not create a system power request.",
            ));
        }
        if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(CommandError::new(
                "power_unavailable",
                "Windows refused the system power request.",
            ));
        }
        Ok(Self { handle })
    }
}

#[cfg(windows)]
// Windows HANDLE values are process-owned kernel handles. Moving the opaque
// value to the deadline worker does not transfer access to any Rust memory.
unsafe impl Send for NativePowerAssertion {}

#[cfg(windows)]
impl PowerAssertion for NativePowerAssertion {
    fn set_timeout(&mut self, _timeout: Duration) -> Result<(), CommandError> {
        // Windows PowerRequest has no per-request timeout. The dedicated worker
        // retains this handle and clears it at the monotonic deadline.
        Ok(())
    }

    fn release(&mut self) -> Result<(), CommandError> {
        use windows_sys::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};

        let cleared = unsafe { PowerClearRequest(self.handle, PowerRequestSystemRequired) } != 0;
        if cleared {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
            Ok(())
        } else {
            Err(CommandError::new(
                "power_release_failed",
                "Windows could not confirm release of the system power request.",
            ))
        }
    }
}

#[cfg(windows)]
fn windows_battery_state() -> BatteryState {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 || status.BatteryLifePercent == u8::MAX {
        return BatteryState::Unavailable;
    }
    if status.ACLineStatus == 0 {
        BatteryState::Discharging(status.BatteryLifePercent)
    } else {
        BatteryState::NotDischarging
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetTickCount64() -> u64;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[derive(Clone)]
    struct MockBackend {
        battery: Arc<Mutex<BatteryState>>,
        acquisitions: Arc<AtomicUsize>,
        releases: Arc<AtomicUsize>,
        timeouts: Arc<Mutex<Vec<Duration>>>,
        release_error: bool,
    }

    impl MockBackend {
        fn new(battery: BatteryState) -> Self {
            Self {
                battery: Arc::new(Mutex::new(battery)),
                acquisitions: Arc::new(AtomicUsize::new(0)),
                releases: Arc::new(AtomicUsize::new(0)),
                timeouts: Arc::new(Mutex::new(Vec::new())),
                release_error: false,
            }
        }

        fn with_release_error(mut self) -> Self {
            self.release_error = true;
            self
        }
    }

    impl PowerBackend for MockBackend {
        fn acquire(&self, timeout: Duration) -> Result<Box<dyn PowerAssertion>, CommandError> {
            self.acquisitions.fetch_add(1, Ordering::SeqCst);
            self.timeouts.lock().unwrap().push(timeout);
            Ok(Box::new(MockAssertion {
                releases: Arc::clone(&self.releases),
                timeouts: Arc::clone(&self.timeouts),
                release_error: self.release_error,
            }))
        }

        fn battery_state(&self) -> BatteryState {
            *self.battery.lock().unwrap()
        }
    }

    struct MockAssertion {
        releases: Arc<AtomicUsize>,
        timeouts: Arc<Mutex<Vec<Duration>>>,
        release_error: bool,
    }

    impl PowerAssertion for MockAssertion {
        fn set_timeout(&mut self, timeout: Duration) -> Result<(), CommandError> {
            self.timeouts.lock().unwrap().push(timeout);
            Ok(())
        }

        fn release(&mut self) -> Result<(), CommandError> {
            self.releases.fetch_add(1, Ordering::SeqCst);
            if self.release_error {
                Err(CommandError::new("mock_release_failed", "release failed"))
            } else {
                Ok(())
            }
        }
    }

    fn service_with_backend(backend: MockBackend) -> PowerService {
        PowerService::with_backend_and_timing(
            Arc::new(backend),
            PowerTiming {
                battery_check_interval: Duration::from_millis(2),
            },
        )
    }

    fn request(id: &str, minutes: u64) -> PowerRequest {
        PowerRequest {
            request_id: id.to_owned(),
            duration_minutes: minutes,
        }
    }

    fn wait_for_state(service: &PowerService, expected_status: &str) -> PowerState {
        for _ in 0..100 {
            let state = service.snapshot();
            if state.status == expected_status {
                return state;
            }
            thread::sleep(Duration::from_millis(2));
        }
        panic!("power state did not reach {expected_status}");
    }

    fn wait_for_released(service: &PowerService) -> PowerState {
        for _ in 0..100 {
            let state = service.snapshot();
            if state.resource_status == "released" && state.release_confirmed {
                return state;
            }
            thread::sleep(Duration::from_millis(2));
        }
        panic!("power resource did not confirm release");
    }

    #[test]
    fn rejects_invalid_requests_without_touching_power_state() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend.clone());
        let error = service.start(request("power-1", 0)).unwrap_err();

        assert_eq!(error.code, "invalid_duration");
        assert_eq!(service.snapshot().status, "inactive");
        assert_eq!(backend.acquisitions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn scheduler_request_never_replaces_an_existing_keep_awake_demand() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend.clone());
        service.start(request("independent", 60)).unwrap();

        let error = service
            .start_if_vacant(request("schedule", 60))
            .unwrap_err();

        assert_eq!(error.code, "keep_awake_busy");
        assert_eq!(
            service.snapshot().request_id.as_deref(),
            Some("independent")
        );
        assert_eq!(backend.acquisitions.load(Ordering::SeqCst), 1);
        service.shutdown();
    }

    #[test]
    fn cancelling_the_independent_slot_keeps_an_attached_watch_alive() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend.clone());
        service.start(request("independent", 60)).unwrap();
        service
            .attach_process_watch(7, request("watch-7", 60))
            .unwrap();

        let state = service.cancel();

        assert_eq!(state.status, "active");
        assert_eq!(state.active_demand_count, 1);
        assert_eq!(
            state.reason.as_deref(),
            Some("other_keep_awake_demands_active")
        );
        assert_eq!(backend.releases.load(Ordering::SeqCst), 0);

        service.detach_process_watch(7);
        wait_for_released(&service);
        assert_eq!(backend.releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancelling_a_demand_emits_one_privacy_safe_completion() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend);
        service.start(request("independent", 60)).unwrap();

        service.cancel();

        let completions = service.take_completions();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].request_id, "independent");
        assert_eq!(completions[0].owner, PowerCompletionOwner::Independent);
        assert_eq!(completions[0].status, PowerCompletionStatus::Cancelled);
        assert!(service.take_completions().is_empty());
    }

    #[test]
    fn global_clear_ends_scheduler_demand_and_discards_old_completions() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend.clone());
        service.start(request("independent", 60)).unwrap();
        service.cancel();
        assert_eq!(service.take_completions().len(), 1);
        wait_for_released(&service);
        service
            .start_if_vacant(request("schedule", 60))
            .expect("scheduler demand starts when vacant");

        let state = service.clear_all();

        assert_eq!(state.active_demand_count, 0);
        assert!(service.take_completions().is_empty());
        let released = wait_for_released(&service);
        assert_eq!(released.active_demand_count, 0);
        assert_eq!(backend.releases.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn low_battery_releases_all_power_demands_but_records_process_attachment_state() {
        let backend = MockBackend::new(BatteryState::Unavailable);
        let mut service = service_with_backend(backend.clone());
        service.start(request("independent", 60)).unwrap();
        service
            .attach_process_watch(7, request("watch-7", 60))
            .unwrap();
        *backend.battery.lock().unwrap() = BatteryState::Discharging(LOW_BATTERY_PERCENT);

        let state = wait_for_state(&service, "inactive");

        assert_eq!(state.reason.as_deref(), Some("low_battery"));
        assert_eq!(state.resource_status, "released");
        assert!(state.release_confirmed);
        assert_eq!(
            service.process_watch_power_status(7),
            Some(ProcessWatchPowerStatus::LowBatteryEnded)
        );
        let completions = service.take_completions();
        assert_eq!(completions.len(), 2);
        assert!(
            completions
                .iter()
                .all(|completion| { completion.status == PowerCompletionStatus::LowBattery })
        );
        assert_eq!(backend.releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_release_stays_visible_as_release_unconfirmed() {
        let backend = MockBackend::new(BatteryState::Unavailable).with_release_error();
        let mut service = service_with_backend(backend);
        service.start(request("independent", 60)).unwrap();

        service.cancel();
        let state = wait_for_state(&service, "stopping");

        assert_eq!(state.resource_status, "release_unconfirmed");
        assert!(!state.release_confirmed);
        assert!(
            state
                .reason
                .as_deref()
                .unwrap()
                .starts_with("release_unconfirmed:")
        );
    }

    #[test]
    fn retry_release_wakes_the_release_worker_without_claiming_success() {
        let backend = MockBackend::new(BatteryState::Unavailable).with_release_error();
        let mut service = service_with_backend(backend.clone());
        service.start(request("independent", 60)).unwrap();
        service.cancel();
        let state = wait_for_state(&service, "stopping");
        assert_eq!(state.resource_status, "release_unconfirmed");

        let retry_state = service.retry_release().expect("retry request is accepted");
        assert_eq!(retry_state.resource_status, "releasing");
        assert!(!retry_state.release_confirmed);
        for _ in 0..100 {
            if backend.releases.load(Ordering::SeqCst) >= 2 {
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
        panic!("release retry was not delivered to the deadline worker");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "creates one one-second IOPM assertion and releases it immediately"]
    fn macos_iopm_assertion_sets_a_timeout_and_releases_immediately() {
        let mut assertion = NativePowerAssertion::new(Duration::from_secs(1))
            .expect("the current macOS session must accept a temporary IOPM assertion");
        assertion
            .release()
            .expect("the temporary IOPM assertion must release immediately");
    }
}
