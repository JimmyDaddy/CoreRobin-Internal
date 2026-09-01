//! Standalone, fail-closed runtime for the keyboard-cleaning helper process.
//!
//! The main application is expected to route `--keyboard-helper` to
//! [`run_helper`].  This module deliberately does not parse application
//! arguments itself, start a Tauri runtime, or expose keyboard data.  The
//! process communicates exclusively over bounded newline-delimited frames on
//! stdin and stdout.

#![allow(dead_code)] // The future --keyboard-helper argument adapter owns these entry points.

use super::helper_protocol::{
    HelperCapability, HelperCommand, HelperLifecycleReason, HelperSignal, HookEffectiveness,
    HookFailure, HookIneffectiveSignal, LifecycleSignal, PROTOCOL_VERSION, ProtocolError,
    ReadySignal, ReleasedSignal, StartCommand, decode_command, encode_signal,
};
use super::{ALLOWED_DURATION_SECONDS, Capability, HARD_LIMIT_MS};
use std::io::{BufReader, Read, Write};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
    mpsc::{self, Receiver, TryRecvError},
};
use std::thread;
use std::time::{Duration, Instant};

const REQUEST_ID_MAX_BYTES: usize = 128;
const INPUT_QUEUE_CAPACITY: usize = 2;
const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
const HOST_HEARTBEAT_GRACE: Duration = Duration::from_secs(3);
const HELPER_HARD_LIMIT: Duration = Duration::from_millis(HARD_LIMIT_MS);
#[cfg(target_os = "windows")]
const WINDOWS_MAX_MESSAGES_PER_PUMP: usize = 256;

/// Returns the build-time helper capability without attempting to install an
/// event hook. Ordinary builds remain disabled until an explicitly gated,
/// signed platform build has passed the permission and abnormal-release matrix.
pub const fn helper_capability() -> Capability {
    #[cfg(all(target_os = "macos", feature = "keyboard-cleaning-validated"))]
    {
        Capability::Available
    }

    #[cfg(all(target_os = "windows", feature = "keyboard-cleaning-validated-windows"))]
    {
        Capability::Available
    }

    #[cfg(not(any(
        all(target_os = "macos", feature = "keyboard-cleaning-validated"),
        all(target_os = "windows", feature = "keyboard-cleaning-validated-windows")
    )))]
    {
        Capability::Unavailable
    }
}

/// Runs the helper's stdin/stdout protocol and returns a process exit code.
///
/// This is intentionally a small, crate-callable entry point. The normal
/// application process must opt into it only after detecting
/// `--keyboard-helper`, before it starts Tauri or any other UI runtime.
pub fn run_helper() -> i32 {
    if !helper_capability().is_available() || !trusted_parent_process() {
        return 1;
    }
    run_with_io(
        std::io::stdin(),
        std::io::stdout(),
        PlatformTapBackend,
        RuntimeTiming::production(),
    )
}

fn run_with_io<R, W, B>(input: R, output: W, backend: B, timing: RuntimeTiming) -> i32
where
    R: Read + Send + 'static,
    W: Write,
    B: TapBackend,
{
    match HelperRuntime::new(backend, timing).run(input, output) {
        Ok(()) => 0,
        Err(()) => 1,
    }
}

#[derive(Clone, Copy)]
struct RuntimeTiming {
    control_poll_interval: Duration,
    heartbeat_interval: Duration,
    host_heartbeat_grace: Duration,
    hard_limit: Duration,
}

impl RuntimeTiming {
    const fn production() -> Self {
        Self {
            control_poll_interval: CONTROL_POLL_INTERVAL,
            heartbeat_interval: HEARTBEAT_INTERVAL,
            host_heartbeat_grace: HOST_HEARTBEAT_GRACE,
            hard_limit: HELPER_HARD_LIMIT,
        }
    }
}

enum InputMessage {
    Command(Result<HelperCommand, ProtocolError>),
    Disconnected,
}

struct HelperRuntime<B> {
    backend: B,
    timing: RuntimeTiming,
}

impl<B: TapBackend> HelperRuntime<B> {
    const fn new(backend: B, timing: RuntimeTiming) -> Self {
        Self { backend, timing }
    }

    fn run<R, W>(&mut self, input: R, mut output: W) -> Result<(), ()>
    where
        R: Read + Send + 'static,
        W: Write,
    {
        let input_messages = spawn_input_reader(input);
        let start = match input_messages.recv() {
            Ok(InputMessage::Command(Ok(HelperCommand::Start(start)))) => start,
            Ok(InputMessage::Disconnected) | Err(_) => return Ok(()),
            Ok(InputMessage::Command(_)) => return Err(()),
        };
        if !valid_start(&start) {
            return Err(());
        }

        let request_id = start.request_id.clone();
        let callback_state = Arc::new(CallbackState::default());
        let mut tap = match self.backend.install(Arc::clone(&callback_state)) {
            Ok(tap) => {
                emit(
                    &mut output,
                    HelperSignal::Ready(ReadySignal {
                        protocol_version: PROTOCOL_VERSION.to_owned(),
                        request_id: request_id.clone(),
                        capability: HelperCapability::Available,
                        effectiveness: HookEffectiveness::Confirmed,
                    }),
                )?;
                tap
            }
            Err(HookFailure::CapabilityUnavailable) => {
                emit(
                    &mut output,
                    HelperSignal::Ready(ReadySignal {
                        protocol_version: PROTOCOL_VERSION.to_owned(),
                        request_id: request_id.clone(),
                        capability: HelperCapability::Unavailable,
                        effectiveness: HookEffectiveness::Unconfirmed,
                    }),
                )?;
                return emit_released(&mut output, &request_id, true);
            }
            Err(failure) => {
                emit_hook_ineffective(&mut output, &request_id, failure)?;
                let release_confirmed = !matches!(failure, HookFailure::HookNotConfirmed);
                emit_released(&mut output, &request_id, release_confirmed)?;
                return if release_confirmed { Ok(()) } else { Err(()) };
            }
        };

        let deadline = Instant::now() + self.timing.hard_limit;
        let mut next_heartbeat = Instant::now();
        let mut sequence = 0_u64;
        let mut last_host_heartbeat = 0_u64;
        let mut last_host_heartbeat_at = Instant::now();
        let exit_result = loop {
            let now = Instant::now();
            let heartbeat_wait = next_heartbeat.saturating_duration_since(now);
            tap.pump(self.timing.control_poll_interval.min(heartbeat_wait));

            match callback_state.take() {
                CallbackNotice::None => {}
                CallbackNotice::MouseActivity => {
                    emit_lifecycle(
                        &mut output,
                        &request_id,
                        HelperLifecycleReason::MouseActivity,
                    )?;
                    break Ok(());
                }
                CallbackNotice::TapDisabled => {
                    emit_hook_ineffective(&mut output, &request_id, HookFailure::HookStopped)?;
                    break Ok(());
                }
            }

            if !tap.verify_effectiveness(callback_state.as_ref()) {
                emit_hook_ineffective(&mut output, &request_id, HookFailure::HookStopped)?;
                break Ok(());
            }

            if Instant::now() >= deadline {
                emit_hook_ineffective(&mut output, &request_id, HookFailure::HookStopped)?;
                break Ok(());
            }

            if Instant::now() >= next_heartbeat {
                sequence = sequence.saturating_add(1);
                emit(
                    &mut output,
                    HelperSignal::Heartbeat(super::helper_protocol::HeartbeatSignal {
                        protocol_version: PROTOCOL_VERSION.to_owned(),
                        request_id: request_id.clone(),
                        sequence,
                    }),
                )?;
                next_heartbeat = Instant::now() + self.timing.heartbeat_interval;
            }

            match input_messages.try_recv() {
                Ok(InputMessage::Command(Ok(HelperCommand::Stop(stop))))
                    if valid_stop(&stop, &request_id) =>
                {
                    break Ok(());
                }
                Ok(InputMessage::Command(Ok(HelperCommand::Heartbeat(heartbeat))))
                    if valid_heartbeat(&heartbeat, &request_id)
                        && heartbeat.sequence > last_host_heartbeat =>
                {
                    last_host_heartbeat = heartbeat.sequence;
                    last_host_heartbeat_at = Instant::now();
                }
                Ok(InputMessage::Disconnected) => {
                    emit_lifecycle(&mut output, &request_id, HelperLifecycleReason::HostExited)?;
                    break Ok(());
                }
                Ok(InputMessage::Command(_)) | Err(TryRecvError::Disconnected) => break Err(()),
                Err(TryRecvError::Empty) => {}
            }

            if last_host_heartbeat_at.elapsed() >= self.timing.host_heartbeat_grace {
                emit_lifecycle(
                    &mut output,
                    &request_id,
                    HelperLifecycleReason::HeartbeatLost,
                )?;
                break Ok(());
            }
        };

        // Consuming the tap invalidates its Mach port after its run-loop source
        // has been removed. Only then may `Released { confirmed: true }` be
        // emitted.
        let release_confirmed = tap.release();
        emit_released(&mut output, &request_id, release_confirmed)?;
        if !release_confirmed {
            return Err(());
        }
        exit_result
    }
}

#[cfg(target_os = "macos")]
fn trusted_parent_process() -> bool {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::path::PathBuf;

    let Ok(current_executable) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return false;
    };
    let parent_pid = unsafe { libc::getppid() };
    if parent_pid <= 1 {
        return false;
    }
    let mut buffer = Vec::<u8>::with_capacity(libc::PROC_PIDPATHINFO_MAXSIZE as usize);
    let length = unsafe {
        libc::proc_pidpath(
            parent_pid,
            buffer.as_mut_ptr().cast(),
            libc::PROC_PIDPATHINFO_MAXSIZE as u32,
        )
    };
    if length <= 0 {
        return false;
    }
    unsafe { buffer.set_len(length as usize) };
    let parent_executable = PathBuf::from(OsString::from_vec(buffer));
    std::fs::canonicalize(parent_executable).is_ok_and(|path| path == current_executable)
}

#[cfg(target_os = "windows")]
fn trusted_parent_process() -> bool {
    windows_parent_is_same_executable()
}

#[cfg(target_os = "windows")]
fn windows_parent_is_same_executable() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    fn process_image_path(pid: u32) -> Option<Vec<u16>> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }

        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let result =
            unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe {
            CloseHandle(handle);
        }
        if result == 0 || length == 0 {
            return None;
        }
        buffer.truncate(length as usize);
        Some(buffer)
    }

    fn parent_pid(pid: u32) -> Option<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut result = None;
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    result = Some(entry.th32ParentProcessID);
                    break;
                }
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        unsafe {
            CloseHandle(snapshot);
        }
        result
    }

    let current_pid = unsafe { GetCurrentProcessId() };
    let Some(parent_pid) = parent_pid(current_pid).filter(|pid| *pid > 1) else {
        return false;
    };
    let Some(current_path) = process_image_path(current_pid) else {
        return false;
    };
    let Some(parent_path) = process_image_path(parent_pid) else {
        return false;
    };
    String::from_utf16_lossy(&current_path)
        .eq_ignore_ascii_case(&String::from_utf16_lossy(&parent_path))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const fn trusted_parent_process() -> bool {
    false
}

fn valid_start(start: &StartCommand) -> bool {
    start.protocol_version == PROTOCOL_VERSION
        && ALLOWED_DURATION_SECONDS.contains(&start.duration_seconds)
        && valid_request_id(&start.request_id)
}

fn valid_stop(stop: &super::helper_protocol::StopCommand, request_id: &str) -> bool {
    stop.protocol_version == PROTOCOL_VERSION && stop.request_id == request_id
}

fn valid_heartbeat(heartbeat: &super::helper_protocol::HeartbeatCommand, request_id: &str) -> bool {
    heartbeat.protocol_version == PROTOCOL_VERSION && heartbeat.request_id == request_id
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= REQUEST_ID_MAX_BYTES
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

fn emit<W: Write>(output: &mut W, signal: HelperSignal) -> Result<(), ()> {
    let frame = encode_signal(&signal).map_err(|_| ())?;
    output.write_all(&frame).map_err(|_| ())?;
    output.write_all(b"\n").map_err(|_| ())?;
    output.flush().map_err(|_| ())
}

fn emit_hook_ineffective<W: Write>(
    output: &mut W,
    request_id: &str,
    failure: HookFailure,
) -> Result<(), ()> {
    emit(
        output,
        HelperSignal::HookIneffective(HookIneffectiveSignal {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request_id.to_owned(),
            failure,
        }),
    )
}

fn emit_lifecycle<W: Write>(
    output: &mut W,
    request_id: &str,
    reason: HelperLifecycleReason,
) -> Result<(), ()> {
    emit(
        output,
        HelperSignal::Lifecycle(LifecycleSignal {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request_id.to_owned(),
            reason,
        }),
    )
}

fn emit_released<W: Write>(output: &mut W, request_id: &str, confirmed: bool) -> Result<(), ()> {
    emit(
        output,
        HelperSignal::Released(ReleasedSignal {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request_id.to_owned(),
            confirmed,
        }),
    )
}

fn spawn_input_reader<R: Read + Send + 'static>(input: R) -> Receiver<InputMessage> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let mut input = BufReader::new(input);
        loop {
            let message = match read_frame(&mut input) {
                Ok(Some(frame)) => InputMessage::Command(decode_command(&frame)),
                Ok(None) => InputMessage::Disconnected,
                Err(error) => InputMessage::Command(Err(error)),
            };
            let disconnected = matches!(message, InputMessage::Disconnected);
            let malformed = matches!(message, InputMessage::Command(Err(_)));
            if sender.send(message).is_err() || disconnected || malformed {
                return;
            }
        }
    });
    receiver
}

/// Reads one bounded line without retaining bytes beyond the helper protocol
/// limit. This thread handles untrusted stdin; it never runs in an event tap
/// callback.
fn read_frame<R: Read>(input: &mut R) -> Result<Option<Vec<u8>>, ProtocolError> {
    let mut frame = Vec::with_capacity(super::helper_protocol::MAX_FRAME_BYTES);
    loop {
        let mut byte = [0_u8; 1];
        match input.read(&mut byte) {
            Ok(0) if frame.is_empty() => return Ok(None),
            Ok(0) => return Err(ProtocolError::MissingLineBreak),
            Ok(_) if byte[0] == b'\n' => return Ok(Some(frame)),
            Ok(_) if frame.len() == super::helper_protocol::MAX_FRAME_BYTES => {
                return Err(ProtocolError::FrameTooLarge);
            }
            Ok(_) => frame.push(byte[0]),
            Err(_) => return Ok(None),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
enum CallbackNotice {
    None = 0,
    MouseActivity = 1,
    TapDisabled = 2,
}

#[derive(Default)]
struct CallbackState {
    notice: AtomicU8,
    input_events: std::sync::atomic::AtomicU64,
    keyboard_events: std::sync::atomic::AtomicU64,
}

impl CallbackState {
    /// This method is the complete callback-side state transition: one atomic
    /// max operation, no allocation, no locks, no IPC, and no key inspection.
    fn record(&self, notice: CallbackNotice) {
        self.notice.fetch_max(notice as u8, Ordering::Release);
    }

    fn take(&self) -> CallbackNotice {
        match self
            .notice
            .swap(CallbackNotice::None as u8, Ordering::AcqRel)
        {
            value if value == CallbackNotice::TapDisabled as u8 => CallbackNotice::TapDisabled,
            value if value == CallbackNotice::MouseActivity as u8 => CallbackNotice::MouseActivity,
            _ => CallbackNotice::None,
        }
    }

    fn record_keyboard_event(&self) {
        self.keyboard_events.fetch_add(1, Ordering::Relaxed);
    }

    fn record_input_event(&self) {
        self.input_events.fetch_add(1, Ordering::Relaxed);
    }

    fn input_event_count(&self) -> u64 {
        self.input_events.load(Ordering::Acquire)
    }
}

trait TapBackend {
    type Tap: InstalledTap;

    fn install(&mut self, callback_state: Arc<CallbackState>) -> Result<Self::Tap, HookFailure>;
}

trait InstalledTap {
    fn pump(&mut self, wait: Duration);
    fn verify_effectiveness(&mut self, _callback_state: &CallbackState) -> bool {
        true
    }
    fn release(self) -> bool;
}

struct PlatformTapBackend;

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
impl TapBackend for PlatformTapBackend {
    type Tap = UnavailableTap;

    fn install(&mut self, _callback_state: Arc<CallbackState>) -> Result<Self::Tap, HookFailure> {
        Err(HookFailure::CapabilityUnavailable)
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
struct UnavailableTap;

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
impl InstalledTap for UnavailableTap {
    fn pump(&mut self, _wait: Duration) {}

    fn release(self) -> bool {
        true
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_foundation::base::TCFType;
    use core_foundation::mach_port::CFMachPortRef;
    use core_foundation::runloop::{CFRunLoop, CFRunLoopSource, kCFRunLoopCommonModes};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        #[link_name = "CGEventTapIsEnabled"]
        fn cg_event_tap_is_enabled(tap: CFMachPortRef) -> bool;
    }

    pub(super) struct MacTap {
        run_loop: CFRunLoop,
        source: CFRunLoopSource,
        tap: CGEventTap<'static>,
    }

    impl TapBackend for PlatformTapBackend {
        type Tap = MacTap;

        fn install(
            &mut self,
            callback_state: Arc<CallbackState>,
        ) -> Result<Self::Tap, HookFailure> {
            let tap = CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                event_types(),
                move |_proxy, event_type, _event| callback(callback_state.as_ref(), event_type),
            )
            .map_err(|_| HookFailure::PermissionRevoked)?;
            let source = tap
                .mach_port()
                .create_runloop_source(0)
                .map_err(|_| HookFailure::HookStopped)?;
            let run_loop = CFRunLoop::get_current();
            run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            if !unsafe { cg_event_tap_is_enabled(tap.mach_port().as_concrete_TypeRef()) } {
                run_loop.remove_source(&source, unsafe { kCFRunLoopCommonModes });
                return Err(HookFailure::PermissionRevoked);
            }
            Ok(MacTap {
                run_loop,
                source,
                tap,
            })
        }
    }

    impl InstalledTap for MacTap {
        fn pump(&mut self, wait: Duration) {
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopCommonModes }, wait, true);
        }

        fn release(self) -> bool {
            self.run_loop
                .remove_source(&self.source, unsafe { kCFRunLoopCommonModes });
            // `self` drops next, invalidating the CFMachPort before the caller
            // can send a confirmed release acknowledgement.
            true
        }
    }

    pub(super) fn callback(
        callback_state: &CallbackState,
        event_type: CGEventType,
    ) -> CallbackResult {
        match event_type {
            CGEventType::KeyDown | CGEventType::KeyUp | CGEventType::FlagsChanged => {
                CallbackResult::Drop
            }
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                callback_state.record(CallbackNotice::TapDisabled);
                CallbackResult::Keep
            }
            _ if is_mouse_event(event_type) => {
                callback_state.record(CallbackNotice::MouseActivity);
                CallbackResult::Keep
            }
            _ => CallbackResult::Keep,
        }
    }

    fn event_types() -> Vec<CGEventType> {
        vec![
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGEventType::MouseMoved,
            CGEventType::LeftMouseDragged,
            CGEventType::RightMouseDragged,
            CGEventType::ScrollWheel,
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
            CGEventType::OtherMouseDragged,
        ]
    }

    pub(super) fn is_mouse_event(event_type: CGEventType) -> bool {
        matches!(
            event_type,
            CGEventType::LeftMouseDown
                | CGEventType::LeftMouseUp
                | CGEventType::RightMouseDown
                | CGEventType::RightMouseUp
                | CGEventType::MouseMoved
                | CGEventType::LeftMouseDragged
                | CGEventType::RightMouseDragged
                | CGEventType::ScrollWheel
                | CGEventType::OtherMouseDown
                | CGEventType::OtherMouseUp
                | CGEventType::OtherMouseDragged
        )
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, HC_ACTION, HHOOK, MSG, PM_REMOVE, PeekMessageW,
        SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP,
        WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static CALLBACK_STATE: OnceLock<Arc<CallbackState>> = OnceLock::new();

    pub(super) struct WindowsTap {
        keyboard_hook: HHOOK,
        mouse_hook: HHOOK,
        last_input_tick: u32,
        callback_event_count: u64,
    }

    impl TapBackend for PlatformTapBackend {
        type Tap = WindowsTap;

        fn install(
            &mut self,
            callback_state: Arc<CallbackState>,
        ) -> Result<Self::Tap, HookFailure> {
            let Some(last_input_tick) = last_input_tick() else {
                return Err(HookFailure::HookStopped);
            };
            if CALLBACK_STATE.set(callback_state).is_err() {
                return Err(HookFailure::HookStopped);
            }

            let module: HINSTANCE = unsafe { GetModuleHandleW(std::ptr::null()) };
            if module.is_null() {
                return Err(HookFailure::PermissionRevoked);
            }
            let keyboard_hook =
                unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_callback), module, 0) };
            if keyboard_hook.is_null() {
                return Err(HookFailure::PermissionRevoked);
            }
            let mouse_hook =
                unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_callback), module, 0) };
            if mouse_hook.is_null() {
                let keyboard_released = unsafe { UnhookWindowsHookEx(keyboard_hook) != 0 };
                return Err(if keyboard_released {
                    HookFailure::PermissionRevoked
                } else {
                    HookFailure::HookNotConfirmed
                });
            }

            Ok(WindowsTap {
                keyboard_hook,
                mouse_hook,
                last_input_tick,
                callback_event_count: 0,
            })
        }
    }

    impl InstalledTap for WindowsTap {
        fn pump(&mut self, wait: Duration) {
            let deadline = Instant::now() + wait;
            let mut processed_messages = 0;
            loop {
                if Instant::now() >= deadline {
                    return;
                }
                let mut message = MSG::default();
                let mut had_message = false;
                while processed_messages < WINDOWS_MAX_MESSAGES_PER_PUMP
                    && Instant::now() < deadline
                    && unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) }
                        != 0
                {
                    processed_messages += 1;
                    had_message = true;
                    if message.message == WM_QUIT {
                        if let Some(state) = CALLBACK_STATE.get() {
                            state.record(CallbackNotice::TapDisabled);
                        }
                    } else {
                        unsafe {
                            DispatchMessageW(&message);
                        }
                    }
                }

                if had_message || Instant::now() >= deadline {
                    return;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return;
                }
                thread::sleep(remaining.min(Duration::from_millis(1)));
            }
        }

        fn verify_effectiveness(&mut self, callback_state: &CallbackState) -> bool {
            let Some(current_input_tick) = last_input_tick() else {
                return false;
            };
            let current_callback_events = callback_state.input_event_count();
            let input_changed = current_input_tick != self.last_input_tick;
            let callback_seen = current_callback_events != self.callback_event_count;
            if input_changed && !callback_seen {
                return false;
            }
            self.last_input_tick = current_input_tick;
            self.callback_event_count = current_callback_events;
            true
        }

        fn release(self) -> bool {
            let keyboard_released = unsafe { UnhookWindowsHookEx(self.keyboard_hook) != 0 };
            let mouse_released = unsafe { UnhookWindowsHookEx(self.mouse_hook) != 0 };
            keyboard_released && mouse_released
        }
    }

    fn last_input_tick() -> Option<u32> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        (unsafe { GetLastInputInfo(&mut info) } != 0).then_some(info.dwTime)
    }

    pub(super) fn is_keyboard_message(message: u32) -> bool {
        matches!(message, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP)
    }

    unsafe extern "system" fn keyboard_callback(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && is_keyboard_message(wparam as u32) {
            if let Some(state) = CALLBACK_STATE.get() {
                state.record_input_event();
                state.record_keyboard_event();
            }
            return 1;
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_callback(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            if let Some(state) = CALLBACK_STATE.get() {
                state.record_input_event();
                state.record(CallbackNotice::MouseActivity);
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }
}

#[cfg(test)]
#[path = "helper_runtime_tests.rs"]
mod tests;
