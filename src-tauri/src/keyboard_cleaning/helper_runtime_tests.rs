use super::super::helper_protocol::encode_command;
use super::*;
use std::collections::VecDeque;
use std::io::{Cursor, Read};

fn start_command() -> HelperCommand {
    HelperCommand::Start(StartCommand {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        request_id: "request-1".to_owned(),
        duration_seconds: 30,
        prepare_deadline_ms: 3_000,
        hard_deadline_ms: HARD_LIMIT_MS,
    })
}

fn stop_command() -> HelperCommand {
    HelperCommand::Stop(super::super::helper_protocol::StopCommand {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        request_id: "request-1".to_owned(),
        reason: super::super::helper_protocol::HelperStopReason::Cancelled,
    })
}

fn frames(commands: &[HelperCommand]) -> Cursor<Vec<u8>> {
    let mut bytes = Vec::new();
    for command in commands {
        bytes.extend(encode_command(command).unwrap());
        bytes.push(b'\n');
    }
    Cursor::new(bytes)
}

fn signals(output: Vec<u8>) -> Vec<HelperSignal> {
    output
        .split(|byte| *byte == b'\n')
        .filter(|frame| !frame.is_empty())
        .map(|frame| super::super::helper_protocol::decode_signal(frame).unwrap())
        .collect()
}

#[derive(Default)]
struct FakeBackend {
    install_result: Option<Result<FakeTap, HookFailure>>,
}

impl FakeBackend {
    fn with_notices(notices: impl IntoIterator<Item = CallbackNotice>) -> Self {
        Self {
            install_result: Some(Ok(FakeTap {
                callback_state: None,
                notices: notices.into_iter().collect(),
                released: false,
            })),
        }
    }

    fn failing(failure: HookFailure) -> Self {
        Self {
            install_result: Some(Err(failure)),
        }
    }
}

impl TapBackend for FakeBackend {
    type Tap = FakeTap;

    fn install(&mut self, callback_state: Arc<CallbackState>) -> Result<Self::Tap, HookFailure> {
        let mut tap = self.install_result.take().expect("install once");
        if let Ok(tap) = &mut tap {
            tap.callback_state = Some(callback_state);
        }
        tap
    }
}

struct FakeTap {
    callback_state: Option<Arc<CallbackState>>,
    notices: VecDeque<CallbackNotice>,
    released: bool,
}

impl InstalledTap for FakeTap {
    fn pump(&mut self, _wait: Duration) {
        if let (Some(callback_state), Some(notice)) =
            (&self.callback_state, self.notices.pop_front())
        {
            callback_state.record(notice);
        } else if !_wait.is_zero() {
            std::thread::sleep(_wait);
        }
    }

    fn release(mut self) -> bool {
        self.released = true;
        assert!(
            self.released,
            "release acknowledgement must follow tap release"
        );
        true
    }
}

fn test_timing() -> RuntimeTiming {
    RuntimeTiming {
        control_poll_interval: Duration::from_millis(1),
        heartbeat_interval: Duration::from_millis(5),
        host_heartbeat_grace: Duration::from_millis(50),
        hard_limit: Duration::from_millis(500),
    }
}

#[test]
fn helper_stops_and_confirms_release_without_observing_key_data() {
    let output = Vec::new();
    let exit = run_with_io(
        frames(&[start_command(), stop_command()]),
        output,
        FakeBackend::with_notices([]),
        test_timing(),
    );
    assert_eq!(exit, 0);
}

#[test]
fn mouse_activity_is_reported_then_the_tap_is_released() {
    let mut output = Vec::new();
    let exit = run_with_io(
        frames(&[start_command()]),
        &mut output,
        FakeBackend::with_notices([CallbackNotice::MouseActivity]),
        test_timing(),
    );
    assert_eq!(exit, 0);
    assert!(matches!(
        signals(output).as_slice(),
        [
            HelperSignal::Ready(_),
            HelperSignal::Lifecycle(LifecycleSignal {
                reason: HelperLifecycleReason::MouseActivity,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));
}

#[test]
fn disabled_tap_and_permission_failure_are_both_fail_closed() {
    let mut disabled_output = Vec::new();
    let disabled_exit = run_with_io(
        frames(&[start_command()]),
        &mut disabled_output,
        FakeBackend::with_notices([CallbackNotice::TapDisabled]),
        test_timing(),
    );
    assert_eq!(disabled_exit, 0);
    assert!(matches!(
        signals(disabled_output).as_slice(),
        [
            HelperSignal::Ready(_),
            HelperSignal::HookIneffective(HookIneffectiveSignal {
                failure: HookFailure::HookStopped,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));

    let mut permission_output = Vec::new();
    let permission_exit = run_with_io(
        frames(&[start_command()]),
        &mut permission_output,
        FakeBackend::failing(HookFailure::PermissionRevoked),
        test_timing(),
    );
    assert_eq!(permission_exit, 0);
    assert!(matches!(
        signals(permission_output).as_slice(),
        [
            HelperSignal::HookIneffective(HookIneffectiveSignal {
                failure: HookFailure::PermissionRevoked,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));

    let mut unconfirmed_output = Vec::new();
    let unconfirmed_exit = run_with_io(
        frames(&[start_command()]),
        &mut unconfirmed_output,
        FakeBackend::failing(HookFailure::HookNotConfirmed),
        test_timing(),
    );
    assert_eq!(unconfirmed_exit, 1);
    assert!(matches!(
        signals(unconfirmed_output).as_slice(),
        [
            HelperSignal::HookIneffective(HookIneffectiveSignal {
                failure: HookFailure::HookNotConfirmed,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: false,
                ..
            })
        ]
    ));
}

#[test]
fn stdin_eof_reports_host_exit_before_release() {
    let mut output = Vec::new();
    let exit = run_with_io(
        frames(&[start_command()]),
        &mut output,
        FakeBackend::with_notices([]),
        test_timing(),
    );
    assert_eq!(exit, 0);
    assert!(matches!(
        signals(output).as_slice(),
        [
            HelperSignal::Ready(_),
            HelperSignal::Heartbeat(_),
            HelperSignal::Lifecycle(LifecycleSignal {
                reason: HelperLifecycleReason::HostExited,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));
}

struct HoldOpenInput {
    bytes: Cursor<Vec<u8>>,
    hold_for: Duration,
    held: bool,
}

impl Read for HoldOpenInput {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let read = self.bytes.read(output)?;
        if read > 0 {
            return Ok(read);
        }
        if !self.held {
            self.held = true;
            std::thread::sleep(self.hold_for);
        }
        Ok(0)
    }
}

#[test]
fn missing_host_heartbeat_releases_before_the_hard_limit() {
    let mut start = Vec::new();
    start.extend(encode_command(&start_command()).unwrap());
    start.push(b'\n');
    let mut output = Vec::new();
    let exit = run_with_io(
        HoldOpenInput {
            bytes: Cursor::new(start),
            hold_for: Duration::from_millis(100),
            held: false,
        },
        &mut output,
        FakeBackend::with_notices([]),
        RuntimeTiming {
            control_poll_interval: Duration::from_millis(1),
            heartbeat_interval: Duration::from_millis(5),
            host_heartbeat_grace: Duration::from_millis(10),
            hard_limit: Duration::from_millis(500),
        },
    );
    assert_eq!(exit, 0);
    let signals = signals(output);
    assert!(signals.iter().any(|signal| matches!(
        signal,
        HelperSignal::Lifecycle(LifecycleSignal {
            reason: HelperLifecycleReason::HeartbeatLost,
            ..
        })
    )));
    assert!(matches!(
        signals.last(),
        Some(HelperSignal::Released(ReleasedSignal {
            confirmed: true,
            ..
        }))
    ));
}

#[test]
fn hard_cutoff_reports_ineffective_then_releases() {
    let mut output = Vec::new();
    let exit = run_with_io(
        frames(&[start_command()]),
        &mut output,
        FakeBackend::with_notices([]),
        RuntimeTiming {
            control_poll_interval: Duration::from_millis(1),
            heartbeat_interval: Duration::from_secs(1),
            host_heartbeat_grace: Duration::from_millis(500),
            hard_limit: Duration::ZERO,
        },
    );
    assert_eq!(exit, 0);
    assert!(matches!(
        signals(output).as_slice(),
        [
            HelperSignal::Ready(_),
            HelperSignal::HookIneffective(HookIneffectiveSignal {
                failure: HookFailure::HookStopped,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));
}

#[test]
fn unavailable_platform_signals_capability_unavailable_and_never_installs_a_tap() {
    let mut output = Vec::new();
    let exit = run_with_io(
        frames(&[start_command()]),
        &mut output,
        FakeBackend::failing(HookFailure::CapabilityUnavailable),
        test_timing(),
    );
    assert_eq!(exit, 0);
    assert!(matches!(
        signals(output).as_slice(),
        [
            HelperSignal::Ready(ReadySignal {
                capability: HelperCapability::Unavailable,
                ..
            }),
            HelperSignal::Released(ReleasedSignal {
                confirmed: true,
                ..
            })
        ]
    ));
}

#[cfg(not(any(
    all(target_os = "macos", feature = "keyboard-cleaning-macos"),
    all(target_os = "windows", feature = "keyboard-cleaning-validated-windows")
)))]
#[test]
fn builds_without_a_platform_backend_are_explicitly_unavailable() {
    assert_eq!(helper_capability(), Capability::Unavailable);
}

#[cfg(all(target_os = "macos", feature = "keyboard-cleaning-macos"))]
#[test]
fn macos_build_exposes_a_runtime_capability_without_installing_a_tap() {
    assert_eq!(helper_capability(), Capability::Available);
    let snapshot =
        crate::toolbox_service::ToolboxService::with_keyboard_capability(helper_capability())
            .snapshot();
    assert_eq!(
        snapshot.capabilities["keyboard-cleaning"].state,
        "available"
    );
    assert_eq!(
        snapshot.capabilities["keyboard-cleaning"]
            .platform
            .as_deref(),
        Some("macos")
    );
}

#[cfg(all(target_os = "windows", feature = "keyboard-cleaning-validated-windows"))]
#[test]
fn validated_windows_build_exposes_a_runtime_capability_without_installing_a_hook() {
    assert_eq!(helper_capability(), Capability::Available);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_keyboard_filter_only_classifies_keyboard_messages() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_KEYDOWN, WM_KEYUP, WM_MOUSEMOVE, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    assert!(super::windows::is_keyboard_message(WM_KEYDOWN));
    assert!(super::windows::is_keyboard_message(WM_KEYUP));
    assert!(super::windows::is_keyboard_message(WM_SYSKEYDOWN));
    assert!(super::windows::is_keyboard_message(WM_SYSKEYUP));
    assert!(!super::windows::is_keyboard_message(WM_MOUSEMOVE));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_callback_only_drops_keyboard_events_and_never_consumes_mouse_events() {
    use core_graphics::event::{CGEventType, CallbackResult};

    let callback_state = CallbackState::default();
    for event_type in [
        CGEventType::KeyDown,
        CGEventType::KeyUp,
        CGEventType::FlagsChanged,
    ] {
        assert!(matches!(
            super::macos::callback(&callback_state, event_type),
            CallbackResult::Drop
        ));
    }
    assert!(matches!(
        super::macos::callback(&callback_state, CGEventType::MouseMoved),
        CallbackResult::Keep
    ));
    assert_eq!(callback_state.take(), CallbackNotice::MouseActivity);
}

#[test]
fn helper_deadline_is_bounded_by_the_selected_duration_and_hard_limit() {
    let HelperCommand::Start(mut start) = start_command() else {
        unreachable!()
    };
    for seconds in [30, 60, 120] {
        start.duration_seconds = seconds;
        assert_eq!(
            session_limit(&start, HELPER_HARD_LIMIT),
            Duration::from_secs(seconds + 3)
        );
    }
    assert_eq!(
        session_limit(&start, Duration::from_secs(1)),
        Duration::from_secs(1)
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn helper_accepts_its_own_executable_as_the_parent_without_installing_a_tap() {
    const CHILD_MARKER: &str = "CORE_ROBIN_KEYBOARD_PARENT_TEST";
    if std::env::var_os(CHILD_MARKER).is_some() {
        assert!(trusted_parent_process());
        return;
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "keyboard_cleaning::helper_runtime::tests::helper_accepts_its_own_executable_as_the_parent_without_installing_a_tap",
        ])
        .env(CHILD_MARKER, "1")
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_callback_passes_keys_after_its_deadline_even_before_the_control_loop_pumps() {
    use core_graphics::event::{CGEventType, CallbackResult};

    let state = CallbackState {
        deadline: Some(Instant::now()),
        ..CallbackState::default()
    };
    assert!(matches!(
        super::macos::callback(&state, CGEventType::KeyDown),
        CallbackResult::Keep
    ));
    assert_eq!(state.take(), CallbackNotice::TapDisabled);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_event_pump_services_the_registered_run_loop_mode_without_a_keyboard_tap() {
    use core_foundation::date::CFDate;
    use core_foundation::runloop::{
        CFRunLoop, CFRunLoopTimer, CFRunLoopTimerContext, CFRunLoopTimerRef, kCFRunLoopDefaultMode,
    };
    use std::ffi::c_void;
    use std::sync::atomic::AtomicBool;

    extern "C" fn fired(_timer: CFRunLoopTimerRef, info: *mut c_void) {
        unsafe { &*info.cast::<AtomicBool>() }.store(true, Ordering::Release);
        CFRunLoop::get_current().stop();
    }

    let did_fire = AtomicBool::new(false);
    let mut context = CFRunLoopTimerContext {
        version: 0,
        info: std::ptr::from_ref(&did_fire).cast_mut().cast(),
        retain: None,
        release: None,
        copyDescription: None,
    };
    let timer = CFRunLoopTimer::new(CFDate::now().abs_time(), 0.0, 0, 0, fired, &mut context);
    let run_loop = CFRunLoop::get_current();
    run_loop.add_timer(&timer, unsafe { kCFRunLoopDefaultMode });
    super::macos::pump_events(Duration::from_millis(100));
    run_loop.remove_timer(&timer, unsafe { kCFRunLoopDefaultMode });
    assert!(
        did_fire.load(Ordering::Acquire),
        "the helper must pump the actual registered mode"
    );
}
