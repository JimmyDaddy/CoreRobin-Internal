use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;

const MINUTES_MIN: u64 = 1;
const MINUTES_MAX: u64 = 12 * 60;
const POWER_CHECK_INTERVAL: Duration = Duration::from_secs(15);

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
}

struct PowerLease {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PowerLease {
    fn stop_and_join(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for PowerLease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub struct PowerService {
    active: Option<(PowerState, PowerLease)>,
}

impl PowerService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> PowerState {
        self.active
            .as_ref()
            .map(|(state, _)| state.clone())
            .unwrap_or_else(|| PowerState {
                status: "inactive".to_owned(),
                request_id: None,
                expires_at_ms: None,
                platform: platform_name().to_owned(),
                reason: None,
            })
    }

    pub fn start(&mut self, request: PowerRequest) -> Result<PowerState, CommandError> {
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
        if let Some((_, lease)) = self.active.take() {
            lease.stop_and_join();
        }
        let assertion = acquire_assertion()?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let duration = Duration::from_secs(request.duration_minutes.saturating_mul(60));
        let thread = thread::Builder::new()
            .name("core-robin-toolbox-power-lease".to_owned())
            .spawn(move || {
                let deadline = std::time::Instant::now() + duration;
                while !thread_stop.load(Ordering::Acquire) {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        break;
                    }
                    thread::sleep(
                        POWER_CHECK_INTERVAL.min(deadline.saturating_duration_since(now)),
                    );
                }
                release_assertion(assertion);
            })
            .map_err(|error| {
                release_assertion(assertion);
                CommandError::internal(format!("Could not start the power lease: {error}"))
            })?;
        let state = PowerState {
            status: "active".to_owned(),
            request_id: Some(request.request_id),
            expires_at_ms: Some(
                now_millis().saturating_add(duration.as_millis().min(u64::MAX as u128) as u64),
            ),
            platform: platform_name().to_owned(),
            reason: None,
        };
        self.active = Some((
            state.clone(),
            PowerLease {
                stop,
                thread: Some(thread),
            },
        ));
        Ok(state)
    }

    pub fn cancel(&mut self) -> PowerState {
        if let Some((mut state, lease)) = self.active.take() {
            lease.stop_and_join();
            state.status = "cancelled".to_owned();
            state.reason = Some("user_requested".to_owned());
            return state;
        }
        self.snapshot()
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
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
fn acquire_assertion() -> Result<u32, CommandError> {
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
    let status = unsafe { IOPMAssertionCreateWithName(kind_ref, 255, name_ref, &mut assertion_id) };
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
    Ok(assertion_id)
}

#[cfg(not(target_os = "macos"))]
fn acquire_assertion() -> Result<u32, CommandError> {
    Err(CommandError::new(
        "power_unavailable",
        "A safe native keep-awake backend is not available on this build.",
    ))
}

#[cfg(target_os = "macos")]
fn release_assertion(assertion: u32) {
    unsafe {
        IOPMAssertionRelease(assertion);
    }
}

#[cfg(not(target_os = "macos"))]
fn release_assertion(_assertion: u32) {}

#[cfg(target_os = "macos")]
type CFStringRef = *const std::ffi::c_void;

#[cfg(target_os = "macos")]
unsafe fn cf_string(value: *const std::ffi::c_char) -> CFStringRef {
    unsafe { CFStringCreateWithCString(std::ptr::null(), value, 0x0800_0100) }
}

#[cfg(target_os = "macos")]
unsafe fn cf_release(value: CFStringRef) {
    unsafe { CFRelease(value) }
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
    fn IOPMAssertionRelease(assertion_id: u32) -> i32;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const std::ffi::c_void,
        value: *const std::ffi::c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(value: CFStringRef);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_out_of_range_duration_without_touching_power_state() {
        let mut service = PowerService::new();
        let error = service
            .start(PowerRequest {
                request_id: "power-1".to_owned(),
                duration_minutes: 0,
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid_duration");
        assert_eq!(service.snapshot().status, "inactive");
    }
}
