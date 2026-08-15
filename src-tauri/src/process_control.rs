use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::background_processes::managed_process_protection_reason;
use crate::error::CommandError;
use crate::models::{
    ProcessAction, ProcessActionOutcome, ProcessActionRequest, ProcessActionResult,
    ProcessControlCapabilities, ProcessControlLease, ProcessControlLeaseReleaseRequest,
    ProcessControlLeaseRequest, ProcessControlTargeting, ProcessKey,
};
use crate::monitor::protected_reason;

const LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_ACTIVE_LEASES: usize = 64;
static NEXT_LEASE_ID: AtomicU64 = AtomicU64::new(1);

pub struct ProcessController {
    leases: LeaseCache<platform::NativeBinding>,
    capabilities: ProcessControlCapabilities,
    own_pid: u32,
}

impl ProcessController {
    pub fn new() -> Self {
        Self {
            leases: LeaseCache::new(MAX_ACTIVE_LEASES),
            capabilities: platform::capabilities(LEASE_TTL.as_millis() as u64),
            own_pid: std::process::id(),
        }
    }

    pub fn capabilities(&self) -> ProcessControlCapabilities {
        self.capabilities.clone()
    }

    pub fn create_lease(
        &mut self,
        request: ProcessControlLeaseRequest,
    ) -> Result<ProcessControlLease, CommandError> {
        if let Some(reason) = process_protection_reason(request.key.pid, self.own_pid) {
            return Err(CommandError::new("protected_process", reason));
        }

        let action_capability = match request.action {
            ProcessAction::RequestClose => &self.capabilities.request_close,
            ProcessAction::ForceKill => &self.capabilities.force_kill,
        };
        if !action_capability.enabled {
            return Err(CommandError::new(
                "unsupported_action",
                action_capability
                    .disabled_reason
                    .clone()
                    .unwrap_or_else(|| "This process action is unavailable.".to_owned()),
            ));
        }

        if self.capabilities.targeting == ProcessControlTargeting::BestEffortPid
            && !request.acknowledge_best_effort
        {
            return Err(CommandError::new(
                "best_effort_confirmation_required",
                "CoreRobin must confirm the selected process again before continuing.",
            ));
        }

        let binding = platform::bind(&request.key, request.action)?;
        let now = Instant::now();
        let id = next_lease_id();
        let expires_at = now + LEASE_TTL;
        self.leases.insert(
            id.clone(),
            request.key.clone(),
            request.action,
            expires_at,
            binding,
            now,
        )?;

        Ok(ProcessControlLease {
            id,
            key: request.key,
            action: request.action,
            targeting: self.capabilities.targeting,
            expires_at_ms: unix_time_ms().saturating_add(LEASE_TTL.as_millis() as u64),
        })
    }

    pub fn release_lease(&mut self, request: ProcessControlLeaseReleaseRequest) {
        self.leases.release(&request.lease_id);
    }

    pub fn purge_expired(&mut self) {
        self.leases.purge_expired(Instant::now());
    }

    pub fn execute_action(
        &mut self,
        request: ProcessActionRequest,
    ) -> Result<ProcessActionResult, CommandError> {
        if let Some(reason) = process_protection_reason(request.key.pid, self.own_pid) {
            return Err(CommandError::new("protected_process", reason));
        }

        let binding = self.leases.take(
            &request.lease_id,
            &request.key,
            request.action,
            Instant::now(),
        )?;
        let execution = binding.execute(request.action)?;

        Ok(ProcessActionResult {
            signal_sent: execution.signal_sent,
            outcome: execution.outcome,
            message: action_result_message(request.action, execution, self.capabilities.targeting),
        })
    }
}

fn process_protection_reason(pid: u32, own_pid: u32) -> Option<&'static str> {
    protected_reason(pid, own_pid).or_else(|| managed_process_protection_reason(pid))
}

#[derive(Clone, Copy)]
struct ActionExecution {
    signal_sent: bool,
    outcome: ProcessActionOutcome,
}

trait ProcessBinding {
    fn execute(self, action: ProcessAction) -> Result<ActionExecution, CommandError>;
}

struct LeaseEntry<B> {
    id: String,
    key: ProcessKey,
    action: ProcessAction,
    expires_at: Instant,
    binding: B,
}

struct LeaseCache<B> {
    entries: Vec<LeaseEntry<B>>,
    max_entries: usize,
}

impl<B> LeaseCache<B> {
    fn new(max_entries: usize) -> Self {
        Self {
            entries: Vec::new(),
            max_entries,
        }
    }

    fn insert(
        &mut self,
        id: String,
        key: ProcessKey,
        action: ProcessAction,
        expires_at: Instant,
        binding: B,
        now: Instant,
    ) -> Result<(), CommandError> {
        self.purge_expired(now);
        if self.entries.len() >= self.max_entries {
            return Err(CommandError::new(
                "resource_exhausted",
                "Too many process confirmations are open. Cancel an existing confirmation and try again.",
            ));
        }
        self.entries.push(LeaseEntry {
            id,
            key,
            action,
            expires_at,
            binding,
        });
        Ok(())
    }

    fn take(
        &mut self,
        id: &str,
        key: &ProcessKey,
        action: ProcessAction,
        now: Instant,
    ) -> Result<B, CommandError> {
        let position = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| {
                CommandError::new(
                    "control_lease_unavailable",
                    "This process confirmation was already used, released, or is no longer available.",
                )
            })?;

        // Remove first so every execution attempt consumes the lease exactly once,
        // including expired or tampered requests.
        let entry = self.entries.remove(position);
        if entry.expires_at <= now {
            return Err(CommandError::new(
                "control_lease_expired",
                "This process confirmation expired. Review the current process and confirm again.",
            ));
        }
        if entry.key != *key || entry.action != action {
            return Err(CommandError::new(
                "control_lease_mismatch",
                "The confirmation does not belong to this process action; no signal was sent.",
            ));
        }
        Ok(entry.binding)
    }

    fn release(&mut self, id: &str) {
        if let Some(position) = self.entries.iter().position(|entry| entry.id == id) {
            self.entries.remove(position);
        }
    }

    fn purge_expired(&mut self, now: Instant) {
        self.entries.retain(|entry| entry.expires_at > now);
    }
}

fn next_lease_id() -> String {
    let sequence = NEXT_LEASE_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    format!("{nanos:032x}-{sequence:016x}")
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn action_result_message(
    action: ProcessAction,
    execution: ActionExecution,
    targeting: ProcessControlTargeting,
) -> String {
    match execution.outcome {
        ProcessActionOutcome::AlreadyExited => {
            "目标进程在执行前已经退出；CoreRobin 未发送任何信号。".to_owned()
        }
        ProcessActionOutcome::Exited => match action {
            ProcessAction::RequestClose => "已发送结束请求，并确认目标进程退出。".to_owned(),
            ProcessAction::ForceKill => "已发送强制结束请求，并确认目标进程退出。".to_owned(),
        },
        ProcessActionOutcome::StillRunning => {
            let suffix = if targeting == ProcessControlTargeting::BestEffortPid {
                "CoreRobin 已在执行前重新确认目标，并会继续检查它是否退出。"
            } else {
                "CoreRobin 已确认操作仍指向同一目标，并会继续检查它是否退出。"
            };
            match action {
                ProcessAction::RequestClose => {
                    format!("已发送结束请求，但尚未确认目标退出。{suffix}")
                }
                ProcessAction::ForceKill => {
                    format!("已发送强制结束请求，但系统尚未确认退出。{suffix}")
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::thread;
    use std::time::{Duration, Instant};

    use crate::error::CommandError;
    use crate::identity::{ensure_birth_token, read_birth_token};
    use crate::models::{
        ProcessAction, ProcessActionCapability, ProcessActionOutcome, ProcessActionSemantic,
        ProcessControlCapabilities, ProcessControlTargeting, ProcessKey,
    };

    use super::{ActionExecution, ProcessBinding};

    pub struct NativeBinding {
        key: ProcessKey,
    }

    pub fn capabilities(lease_ttl_ms: u64) -> ProcessControlCapabilities {
        ProcessControlCapabilities {
            targeting: ProcessControlTargeting::BestEffortPid,
            request_close: ProcessActionCapability {
                enabled: true,
                semantic: Some(ProcessActionSemantic::Sigterm),
                disabled_reason: None,
            },
            force_kill: ProcessActionCapability {
                enabled: true,
                semantic: Some(ProcessActionSemantic::Sigkill),
                disabled_reason: None,
            },
            lease_ttl_ms,
        }
    }

    pub fn bind(key: &ProcessKey, _action: ProcessAction) -> Result<NativeBinding, CommandError> {
        ensure_birth_token(key.pid, &key.birth_token)
            .map_err(|error| normalize_identity_error(error, key.pid))?;
        Ok(NativeBinding { key: key.clone() })
    }

    impl ProcessBinding for NativeBinding {
        fn execute(self, action: ProcessAction) -> Result<ActionExecution, CommandError> {
            if let Err(error) = ensure_birth_token(self.key.pid, &self.key.birth_token) {
                return if error.code == "identity_unavailable"
                    && process_presence(self.key.pid) == PidPresence::Missing
                {
                    Ok(ActionExecution {
                        signal_sent: false,
                        outcome: ProcessActionOutcome::AlreadyExited,
                    })
                } else {
                    Err(error)
                };
            }

            let signal = match action {
                ProcessAction::RequestClose => libc::SIGTERM,
                ProcessAction::ForceKill => libc::SIGKILL,
            };
            if unsafe { libc::kill(self.key.pid as libc::pid_t, signal) } != 0 {
                let error = std::io::Error::last_os_error();
                return match error.raw_os_error() {
                    Some(libc::ESRCH) => Ok(ActionExecution {
                        signal_sent: false,
                        outcome: ProcessActionOutcome::AlreadyExited,
                    }),
                    Some(libc::EPERM) | Some(libc::EACCES) => Err(CommandError::new(
                        "permission_denied",
                        "macOS denied permission to control this process.",
                    )),
                    _ => Err(CommandError::new(
                        "internal_error",
                        format!("macOS rejected the process signal: {error}"),
                    )),
                };
            }

            let deadline = Instant::now() + Duration::from_millis(350);
            while Instant::now() < deadline {
                match bound_process_state(&self.key) {
                    BoundProcessState::Gone => {
                        return Ok(ActionExecution {
                            signal_sent: true,
                            outcome: ProcessActionOutcome::Exited,
                        });
                    }
                    BoundProcessState::Unknown => break,
                    BoundProcessState::Same => {}
                }
                thread::sleep(Duration::from_millis(20));
            }

            Ok(ActionExecution {
                signal_sent: true,
                outcome: ProcessActionOutcome::StillRunning,
            })
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum PidPresence {
        Present,
        Missing,
        Unknown,
    }

    enum BoundProcessState {
        Same,
        Gone,
        Unknown,
    }

    fn bound_process_state(key: &ProcessKey) -> BoundProcessState {
        match read_birth_token(key.pid) {
            Ok(current) if current == key.birth_token => BoundProcessState::Same,
            Ok(_) => BoundProcessState::Gone,
            Err(_) if process_presence(key.pid) == PidPresence::Missing => BoundProcessState::Gone,
            Err(_) => BoundProcessState::Unknown,
        }
    }

    fn process_presence(pid: u32) -> PidPresence {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return PidPresence::Present;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EPERM) | Some(libc::EACCES) => PidPresence::Present,
            Some(libc::ESRCH) => PidPresence::Missing,
            _ => PidPresence::Unknown,
        }
    }

    fn normalize_identity_error(error: CommandError, pid: u32) -> CommandError {
        if error.code == "identity_unavailable" && process_presence(pid) == PidPresence::Missing {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        } else {
            error
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::time::{Duration, Instant};

    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    use rustix::fd::OwnedFd;
    use rustix::io::Errno;
    use rustix::process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal};

    use crate::error::CommandError;
    use crate::identity::ensure_birth_token;
    use crate::models::{
        ProcessAction, ProcessActionCapability, ProcessActionOutcome, ProcessActionSemantic,
        ProcessControlCapabilities, ProcessControlTargeting, ProcessKey,
    };

    use super::{ActionExecution, ProcessBinding};

    pub struct NativeBinding {
        handle: OwnedFd,
    }

    pub fn capabilities(lease_ttl_ms: u64) -> ProcessControlCapabilities {
        let probe = Pid::from_raw(std::process::id() as i32)
            .ok_or(Errno::INVAL)
            .and_then(|pid| pidfd_open(pid, PidfdFlags::empty()));
        let (targeting, request_close, force_kill) = match probe {
            Ok(_) => (
                ProcessControlTargeting::StableHandle,
                enabled(ProcessActionSemantic::Sigterm),
                enabled(ProcessActionSemantic::Sigkill),
            ),
            Err(error) => {
                let reason = if error == Errno::NOSYS || error == Errno::INVAL {
                    "This Linux kernel does not provide pidfd process control."
                } else {
                    "CoreRobin could not initialize Linux pidfd process control."
                };
                (
                    ProcessControlTargeting::Unavailable,
                    disabled(reason),
                    disabled(reason),
                )
            }
        };

        ProcessControlCapabilities {
            targeting,
            request_close,
            force_kill,
            lease_ttl_ms,
        }
    }

    pub fn bind(key: &ProcessKey, _action: ProcessAction) -> Result<NativeBinding, CommandError> {
        ensure_birth_token(key.pid, &key.birth_token)?;
        let raw_pid = i32::try_from(key.pid).map_err(|_| {
            CommandError::new(
                "control_unavailable",
                "The process ID is outside Linux PID range.",
            )
        })?;
        let pid = Pid::from_raw(raw_pid).ok_or_else(|| {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        })?;
        let handle = pidfd_open(pid, PidfdFlags::empty()).map_err(map_open_error)?;

        // The second token check proves the pidfd opened between the checks
        // still belongs to the identity selected in the snapshot.
        ensure_birth_token(key.pid, &key.birth_token)?;
        Ok(NativeBinding { handle })
    }

    impl ProcessBinding for NativeBinding {
        fn execute(self, action: ProcessAction) -> Result<ActionExecution, CommandError> {
            if pidfd_exited(&self.handle, Duration::ZERO)? {
                return Ok(ActionExecution {
                    signal_sent: false,
                    outcome: ProcessActionOutcome::AlreadyExited,
                });
            }

            let signal = match action {
                ProcessAction::RequestClose => Signal::TERM,
                ProcessAction::ForceKill => Signal::KILL,
            };
            if let Err(error) = pidfd_send_signal(&self.handle, signal) {
                if error == Errno::SRCH {
                    return Ok(ActionExecution {
                        signal_sent: false,
                        outcome: ProcessActionOutcome::AlreadyExited,
                    });
                }
                return Err(map_signal_error(error));
            }

            let exited = pidfd_exited(&self.handle, Duration::from_millis(500)).unwrap_or(false);
            Ok(ActionExecution {
                signal_sent: true,
                outcome: if exited {
                    ProcessActionOutcome::Exited
                } else {
                    ProcessActionOutcome::StillRunning
                },
            })
        }
    }

    fn pidfd_exited(handle: &OwnedFd, timeout: Duration) -> Result<bool, CommandError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let timeout = Timespec {
                tv_sec: remaining.as_secs().min(i64::MAX as u64) as i64,
                tv_nsec: remaining.subsec_nanos().into(),
            };
            let mut fds = [PollFd::new(handle, PollFlags::IN)];
            match poll(&mut fds, Some(&timeout)) {
                Ok(ready) => return Ok(ready > 0),
                Err(error) if error == Errno::INTR && Instant::now() < deadline => continue,
                Err(error) if error == Errno::INTR => return Ok(false),
                Err(error) => {
                    return Err(CommandError::new(
                        "internal_error",
                        format!("Unable to inspect the Linux pidfd: {error}"),
                    ));
                }
            }
        }
    }

    fn enabled(semantic: ProcessActionSemantic) -> ProcessActionCapability {
        ProcessActionCapability {
            enabled: true,
            semantic: Some(semantic),
            disabled_reason: None,
        }
    }

    fn disabled(reason: &str) -> ProcessActionCapability {
        ProcessActionCapability {
            enabled: false,
            semantic: None,
            disabled_reason: Some(reason.to_owned()),
        }
    }

    fn map_open_error(error: Errno) -> CommandError {
        if error == Errno::SRCH {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        } else if error == Errno::PERM || error == Errno::ACCESS {
            CommandError::new("permission_denied", "Linux denied access to this process.")
        } else if error == Errno::NOSYS || error == Errno::INVAL {
            CommandError::new(
                "control_unavailable",
                "This Linux kernel does not provide pidfd process control.",
            )
        } else if error == Errno::MFILE || error == Errno::NFILE || error == Errno::NOMEM {
            CommandError::new(
                "resource_exhausted",
                "Linux could not allocate another stable process handle.",
            )
        } else {
            CommandError::new(
                "internal_error",
                format!("Unable to open a Linux pidfd: {error}"),
            )
        }
    }

    fn map_signal_error(error: Errno) -> CommandError {
        if error == Errno::PERM || error == Errno::ACCESS {
            CommandError::new("permission_denied", "Linux denied the process signal.")
        } else if error == Errno::NOSYS {
            CommandError::new(
                "control_unavailable",
                "Linux pidfd signaling is unavailable on this kernel.",
            )
        } else {
            CommandError::new(
                "internal_error",
                format!("Linux rejected the pidfd signal: {error}"),
            )
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::{
        GetLastError, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    use crate::error::CommandError;
    use crate::identity::windows_birth_token_from_handle;
    use crate::models::{
        ProcessAction, ProcessActionCapability, ProcessActionOutcome, ProcessActionSemantic,
        ProcessControlCapabilities, ProcessControlTargeting, ProcessKey,
    };

    use super::{ActionExecution, ProcessBinding};

    pub struct NativeBinding {
        handle: OwnedHandle,
        pid: u32,
    }

    pub fn capabilities(lease_ttl_ms: u64) -> ProcessControlCapabilities {
        ProcessControlCapabilities {
            targeting: ProcessControlTargeting::StableHandle,
            request_close: ProcessActionCapability {
                enabled: true,
                semantic: Some(ProcessActionSemantic::WmClose),
                disabled_reason: None,
            },
            force_kill: ProcessActionCapability {
                enabled: true,
                semantic: Some(ProcessActionSemantic::TerminateProcess),
                disabled_reason: None,
            },
            lease_ttl_ms,
        }
    }

    pub fn bind(key: &ProcessKey, action: ProcessAction) -> Result<NativeBinding, CommandError> {
        let rights = PROCESS_QUERY_LIMITED_INFORMATION
            | PROCESS_SYNCHRONIZE
            | if action == ProcessAction::ForceKill {
                PROCESS_TERMINATE
            } else {
                0
            };
        let handle = unsafe { OpenProcess(rights, 0, key.pid) };
        if handle.is_null() {
            return Err(map_windows_error(
                unsafe { GetLastError() },
                "open a stable process handle",
            ));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let current = windows_birth_token_from_handle(raw_handle(&handle))?;
        if current != key.birth_token {
            return Err(CommandError::new(
                "stale_process",
                "The PID now belongs to a different process; no action was taken.",
            ));
        }
        Ok(NativeBinding {
            handle,
            pid: key.pid,
        })
    }

    impl ProcessBinding for NativeBinding {
        fn execute(self, action: ProcessAction) -> Result<ActionExecution, CommandError> {
            if has_exited(&self.handle, 0)? {
                return Ok(ActionExecution {
                    signal_sent: false,
                    outcome: ProcessActionOutcome::AlreadyExited,
                });
            }
            if action == ProcessAction::RequestClose {
                let posted = post_close_to_top_level_windows(self.pid)?;
                if posted == 0 {
                    return Err(CommandError::new(
                        "graceful_close_unavailable",
                        "This process has no top-level window that Windows can ask to close.",
                    ));
                }
                return Ok(ActionExecution {
                    signal_sent: true,
                    outcome: if has_exited(&self.handle, 750)? {
                        ProcessActionOutcome::Exited
                    } else {
                        ProcessActionOutcome::StillRunning
                    },
                });
            }
            if unsafe { TerminateProcess(raw_handle(&self.handle), 1) } == 0 {
                let terminate_error = unsafe { GetLastError() };
                if has_exited(&self.handle, 0)? {
                    return Ok(ActionExecution {
                        signal_sent: false,
                        outcome: ProcessActionOutcome::AlreadyExited,
                    });
                }
                return Err(map_windows_error(terminate_error, "terminate the process"));
            }

            Ok(ActionExecution {
                signal_sent: true,
                outcome: if has_exited(&self.handle, 500)? {
                    ProcessActionOutcome::Exited
                } else {
                    ProcessActionOutcome::StillRunning
                },
            })
        }
    }

    struct WindowCloseContext {
        pid: u32,
        posted: u32,
    }

    unsafe extern "system" fn close_window_for_pid(
        window: windows_sys::Win32::Foundation::HWND,
        parameter: windows_sys::Win32::Foundation::LPARAM,
    ) -> i32 {
        let context = unsafe { &mut *(parameter as *mut WindowCloseContext) };
        let mut owner_pid = 0;
        unsafe { GetWindowThreadProcessId(window, &mut owner_pid) };
        if owner_pid == context.pid && unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } != 0 {
            context.posted = context.posted.saturating_add(1);
        }
        1
    }

    fn post_close_to_top_level_windows(pid: u32) -> Result<u32, CommandError> {
        let mut context = WindowCloseContext { pid, posted: 0 };
        if unsafe {
            EnumWindows(
                Some(close_window_for_pid),
                (&mut context as *mut WindowCloseContext) as isize,
            )
        } == 0
        {
            return Err(map_windows_error(
                unsafe { GetLastError() },
                "enumerate application windows",
            ));
        }
        Ok(context.posted)
    }

    fn raw_handle(handle: &OwnedHandle) -> HANDLE {
        handle.as_raw_handle()
    }

    fn has_exited(handle: &OwnedHandle, timeout_ms: u32) -> Result<bool, CommandError> {
        match unsafe { WaitForSingleObject(raw_handle(handle), timeout_ms) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(map_windows_error(
                unsafe { GetLastError() },
                "wait for the process",
            )),
            value => Err(CommandError::new(
                "internal_error",
                format!("Windows returned an unexpected process wait status: {value}"),
            )),
        }
    }

    pub(super) fn map_windows_error(code: u32, operation: &str) -> CommandError {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_PRIVILEGE_NOT_HELD,
        };

        if code == ERROR_ACCESS_DENIED || code == ERROR_PRIVILEGE_NOT_HELD {
            CommandError::new(
                "permission_denied",
                format!("Windows denied permission to {operation}."),
            )
        } else if code == ERROR_INVALID_PARAMETER {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        } else {
            CommandError::new(
                "internal_error",
                format!("Windows could not {operation} (error {code})."),
            )
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use crate::error::CommandError;
    use crate::models::{
        ProcessAction, ProcessActionCapability, ProcessControlCapabilities,
        ProcessControlTargeting, ProcessKey,
    };

    use super::{ActionExecution, ProcessBinding};

    pub struct NativeBinding;

    pub fn capabilities(lease_ttl_ms: u64) -> ProcessControlCapabilities {
        let disabled = || ProcessActionCapability {
            enabled: false,
            semantic: None,
            disabled_reason: Some(
                "Stable process control is not implemented for this platform.".to_owned(),
            ),
        };
        ProcessControlCapabilities {
            targeting: ProcessControlTargeting::Unavailable,
            request_close: disabled(),
            force_kill: disabled(),
            lease_ttl_ms,
        }
    }

    pub fn bind(_key: &ProcessKey, _action: ProcessAction) -> Result<NativeBinding, CommandError> {
        Err(CommandError::new(
            "control_unavailable",
            "Stable process control is not implemented for this platform.",
        ))
    }

    impl ProcessBinding for NativeBinding {
        fn execute(self, _action: ProcessAction) -> Result<ActionExecution, CommandError> {
            Err(CommandError::new(
                "control_unavailable",
                "Stable process control is not implemented for this platform.",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use crate::models::{ProcessAction, ProcessActionOutcome, ProcessKey};

    use super::{ActionExecution, LeaseCache, ProcessBinding};

    struct FakeBinding {
        executions: Arc<AtomicUsize>,
    }

    impl ProcessBinding for FakeBinding {
        fn execute(
            self,
            _action: ProcessAction,
        ) -> Result<ActionExecution, crate::error::CommandError> {
            self.executions.fetch_add(1, Ordering::SeqCst);
            Ok(ActionExecution {
                signal_sent: true,
                outcome: ProcessActionOutcome::Exited,
            })
        }
    }

    fn key(pid: u32, token: &str) -> ProcessKey {
        ProcessKey {
            pid,
            birth_token: token.to_owned(),
        }
    }

    fn insert_fake(
        cache: &mut LeaseCache<FakeBinding>,
        id: &str,
        process_key: ProcessKey,
        action: ProcessAction,
        now: Instant,
        ttl: Duration,
        executions: &Arc<AtomicUsize>,
    ) {
        cache
            .insert(
                id.to_owned(),
                process_key,
                action,
                now + ttl,
                FakeBinding {
                    executions: Arc::clone(executions),
                },
                now,
            )
            .unwrap();
    }

    #[test]
    fn lease_is_single_use() {
        let now = Instant::now();
        let executions = Arc::new(AtomicUsize::new(0));
        let process_key = key(42, "birth");
        let mut cache = LeaseCache::new(4);
        insert_fake(
            &mut cache,
            "lease",
            process_key.clone(),
            ProcessAction::ForceKill,
            now,
            Duration::from_secs(1),
            &executions,
        );

        cache
            .take("lease", &process_key, ProcessAction::ForceKill, now)
            .unwrap()
            .execute(ProcessAction::ForceKill)
            .unwrap();
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        let error = cache
            .take("lease", &process_key, ProcessAction::ForceKill, now)
            .err()
            .expect("a used lease must be rejected");
        assert_eq!(error.code, "control_lease_unavailable");
    }

    #[test]
    fn expired_lease_never_executes() {
        let now = Instant::now();
        let executions = Arc::new(AtomicUsize::new(0));
        let process_key = key(42, "birth");
        let mut cache = LeaseCache::new(4);
        insert_fake(
            &mut cache,
            "expired",
            process_key.clone(),
            ProcessAction::RequestClose,
            now,
            Duration::from_millis(5),
            &executions,
        );

        let error = cache
            .take(
                "expired",
                &process_key,
                ProcessAction::RequestClose,
                now + Duration::from_millis(6),
            )
            .err()
            .expect("an expired lease must be rejected");
        assert_eq!(error.code, "control_lease_expired");
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn mismatched_identity_or_action_never_executes() {
        for (requested_key, requested_action) in [
            (key(43, "replacement"), ProcessAction::ForceKill),
            (key(42, "birth"), ProcessAction::RequestClose),
        ] {
            let now = Instant::now();
            let executions = Arc::new(AtomicUsize::new(0));
            let mut cache = LeaseCache::new(4);
            insert_fake(
                &mut cache,
                "lease",
                key(42, "birth"),
                ProcessAction::ForceKill,
                now,
                Duration::from_secs(1),
                &executions,
            );

            let error = cache
                .take("lease", &requested_key, requested_action, now)
                .err()
                .expect("a mismatched lease must be rejected");
            assert_eq!(error.code, "control_lease_mismatch");
            assert_eq!(executions.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn released_lease_never_executes() {
        let now = Instant::now();
        let executions = Arc::new(AtomicUsize::new(0));
        let process_key = key(42, "birth");
        let mut cache = LeaseCache::new(4);
        insert_fake(
            &mut cache,
            "released",
            process_key.clone(),
            ProcessAction::ForceKill,
            now,
            Duration::from_secs(1),
            &executions,
        );
        cache.release("released");

        assert!(
            cache
                .take("released", &process_key, ProcessAction::ForceKill, now,)
                .is_err()
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn periodic_purge_releases_expired_bindings_without_another_insert() {
        let now = Instant::now();
        let executions = Arc::new(AtomicUsize::new(0));
        let mut cache = LeaseCache::new(4);
        insert_fake(
            &mut cache,
            "expired",
            key(42, "birth"),
            ProcessAction::ForceKill,
            now,
            Duration::from_millis(5),
            &executions,
        );
        assert_eq!(cache.entries.len(), 1);

        cache.purge_expired(now + Duration::from_millis(6));

        assert!(cache.entries.is_empty());
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }

    #[cfg(target_os = "macos")]
    mod macos_process_tests {
        use std::process::Command;

        use crate::identity::read_birth_token;
        use crate::models::{
            ProcessAction, ProcessActionOutcome, ProcessActionRequest,
            ProcessControlLeaseReleaseRequest, ProcessControlLeaseRequest, ProcessKey,
        };

        use super::super::super::ProcessController;

        #[test]
        fn force_kill_only_terminates_the_bound_helper() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            let lease = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: key.clone(),
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: true,
                })
                .unwrap();

            let result = controller
                .execute_action(ProcessActionRequest {
                    lease_id: lease.id,
                    key,
                    action: ProcessAction::ForceKill,
                })
                .unwrap();
            assert!(result.signal_sent);
            assert!(!helper.wait().unwrap().success());
        }

        #[test]
        fn stale_identity_does_not_signal_the_helper() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let mut controller = ProcessController::new();
            let error = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: ProcessKey {
                        pid,
                        birth_token: "macos:stale:identity".to_owned(),
                    },
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: true,
                })
                .unwrap_err();

            assert_eq!(error.code, "stale_process");
            assert!(helper.try_wait().unwrap().is_none());
            helper.kill().unwrap();
            helper.wait().unwrap();
        }

        #[test]
        fn released_lease_does_not_signal_the_helper() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            let lease = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: key.clone(),
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: true,
                })
                .unwrap();
            controller.release_lease(ProcessControlLeaseReleaseRequest {
                lease_id: lease.id.clone(),
            });

            assert!(
                controller
                    .execute_action(ProcessActionRequest {
                        lease_id: lease.id,
                        key,
                        action: ProcessAction::ForceKill,
                    })
                    .is_err()
            );
            assert!(helper.try_wait().unwrap().is_none());
            helper.kill().unwrap();
            helper.wait().unwrap();
        }

        #[test]
        fn exited_helper_returns_already_exited_without_signaling() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            let lease = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: key.clone(),
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: true,
                })
                .unwrap();
            helper.kill().unwrap();
            helper.wait().unwrap();

            let result = controller
                .execute_action(ProcessActionRequest {
                    lease_id: lease.id,
                    key,
                    action: ProcessAction::ForceKill,
                })
                .unwrap();
            assert!(!result.signal_sent);
            assert_eq!(result.outcome, ProcessActionOutcome::AlreadyExited);
        }

        #[test]
        fn best_effort_control_requires_explicit_acknowledgement() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            let error = controller
                .create_lease(ProcessControlLeaseRequest {
                    key,
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: false,
                })
                .unwrap_err();

            assert_eq!(error.code, "best_effort_confirmation_required");
            assert!(helper.try_wait().unwrap().is_none());
            helper.kill().unwrap();
            helper.wait().unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_process_tests {
        use std::process::Command;

        use crate::identity::read_birth_token;
        use crate::models::{
            ProcessAction, ProcessActionOutcome, ProcessActionRequest, ProcessControlLeaseRequest,
            ProcessControlTargeting, ProcessKey,
        };

        use super::super::super::ProcessController;

        #[test]
        fn pidfd_request_close_terminates_only_the_bound_helper() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            assert_eq!(
                controller.capabilities().targeting,
                ProcessControlTargeting::StableHandle
            );
            let lease = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: key.clone(),
                    action: ProcessAction::RequestClose,
                    acknowledge_best_effort: false,
                })
                .unwrap();
            let result = controller
                .execute_action(ProcessActionRequest {
                    lease_id: lease.id,
                    key,
                    action: ProcessAction::RequestClose,
                })
                .unwrap();

            assert!(result.signal_sent);
            assert!(matches!(
                result.outcome,
                ProcessActionOutcome::Exited | ProcessActionOutcome::StillRunning
            ));
            helper.wait().unwrap();
        }

        #[test]
        fn stale_linux_identity_never_signals_the_helper() {
            let mut helper = Command::new("sleep").arg("30").spawn().unwrap();
            let mut controller = ProcessController::new();
            let error = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: ProcessKey {
                        pid: helper.id(),
                        birth_token: "linux:stale".to_owned(),
                    },
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: false,
                })
                .unwrap_err();
            assert_eq!(error.code, "stale_process");
            assert!(helper.try_wait().unwrap().is_none());
            helper.kill().unwrap();
            helper.wait().unwrap();
        }
    }

    #[cfg(windows)]
    mod windows_process_tests {
        use std::process::Command;

        use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

        use crate::identity::read_birth_token;
        use crate::models::{
            ProcessAction, ProcessActionRequest, ProcessControlLeaseRequest,
            ProcessControlTargeting, ProcessKey,
        };

        use crate::process_control::platform;

        use super::super::super::ProcessController;

        #[test]
        fn stable_handle_force_kill_terminates_the_bound_helper() {
            let mut helper = Command::new("cmd")
                .args(["/C", "ping 127.0.0.1 -n 30 >NUL"])
                .spawn()
                .unwrap();
            let pid = helper.id();
            let key = ProcessKey {
                pid,
                birth_token: read_birth_token(pid).unwrap(),
            };
            let mut controller = ProcessController::new();
            assert_eq!(
                controller.capabilities().targeting,
                ProcessControlTargeting::StableHandle
            );
            let lease = controller
                .create_lease(ProcessControlLeaseRequest {
                    key: key.clone(),
                    action: ProcessAction::ForceKill,
                    acknowledge_best_effort: false,
                })
                .unwrap();
            let result = controller
                .execute_action(ProcessActionRequest {
                    lease_id: lease.id,
                    key,
                    action: ProcessAction::ForceKill,
                })
                .unwrap();
            assert!(result.signal_sent);
            helper.wait().unwrap();
        }

        #[test]
        fn windows_permission_errors_are_not_reported_as_internal_failures() {
            assert_eq!(
                platform::map_windows_error(ERROR_ACCESS_DENIED, "control the process").code,
                "permission_denied"
            );
        }
    }
}
