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
const HELPER_HARD_LIMIT: Duration = Duration::from_millis(HARD_LIMIT_MS);

/// Returns the build-time helper capability without attempting to install an
/// event tap. A macOS build can still fail closed at runtime when accessibility
/// permission is absent or CoreGraphics refuses the tap.
pub const fn helper_capability() -> Capability {
    #[cfg(target_os = "macos")]
    {
        Capability::Available
    }

    #[cfg(not(target_os = "macos"))]
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
    hard_limit: Duration,
}

impl RuntimeTiming {
    const fn production() -> Self {
        Self {
            control_poll_interval: CONTROL_POLL_INTERVAL,
            heartbeat_interval: HEARTBEAT_INTERVAL,
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
                return emit_released(&mut output, &request_id, true);
            }
        };

        let deadline = Instant::now() + self.timing.hard_limit;
        let mut next_heartbeat = Instant::now();
        let mut sequence = 0_u64;
        let mut last_host_heartbeat = 0_u64;
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
                }
                Ok(InputMessage::Disconnected) => {
                    emit_lifecycle(&mut output, &request_id, HelperLifecycleReason::HostExited)?;
                    break Ok(());
                }
                Ok(InputMessage::Command(_)) | Err(TryRecvError::Disconnected) => break Err(()),
                Err(TryRecvError::Empty) => {}
            }
        };

        // Consuming the tap invalidates its Mach port after its run-loop source
        // has been removed. Only then may `Released { confirmed: true }` be
        // emitted.
        tap.release();
        emit_released(&mut output, &request_id, true)?;
        exit_result
    }
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
}

trait TapBackend {
    type Tap: InstalledTap;

    fn install(&mut self, callback_state: Arc<CallbackState>) -> Result<Self::Tap, HookFailure>;
}

trait InstalledTap {
    fn pump(&mut self, wait: Duration);
    fn release(self);
}

struct PlatformTapBackend;

#[cfg(not(target_os = "macos"))]
impl TapBackend for PlatformTapBackend {
    type Tap = UnavailableTap;

    fn install(&mut self, _callback_state: Arc<CallbackState>) -> Result<Self::Tap, HookFailure> {
        Err(HookFailure::CapabilityUnavailable)
    }
}

#[cfg(not(target_os = "macos"))]
struct UnavailableTap;

#[cfg(not(target_os = "macos"))]
impl InstalledTap for UnavailableTap {
    fn pump(&mut self, _wait: Duration) {}

    fn release(self) {}
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_foundation::runloop::{CFRunLoop, CFRunLoopSource, kCFRunLoopCommonModes};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };

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

        fn release(self) {
            self.run_loop
                .remove_source(&self.source, unsafe { kCFRunLoopCommonModes });
            // `self` drops next, invalidating the CFMachPort before the caller
            // can send a confirmed release acknowledgement.
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

#[cfg(test)]
#[path = "helper_runtime_tests.rs"]
mod tests;
