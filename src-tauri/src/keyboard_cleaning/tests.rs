use super::*;

fn start(controller: &mut Controller, now_ms: u64) -> Transition {
    controller
        .dispatch(Event::Start {
            request_id: "request-1".to_owned(),
            duration_seconds: 30,
            now_ms,
        })
        .expect("start should be accepted")
}

fn confirm(controller: &mut Controller, now_ms: u64) {
    controller
        .dispatch(Event::HookReady {
            request_id: "request-1".to_owned(),
            capability: Capability::Available,
            effectiveness: HookEffectiveness::Confirmed,
            now_ms,
        })
        .expect("helper confirmation should be accepted");
}

#[test]
fn unavailable_capability_never_enters_preparing_or_active() {
    let mut controller = Controller::new(Capability::Unavailable);
    assert_eq!(controller.snapshot().status, Status::Unavailable);
    assert_eq!(
        controller
            .dispatch(Event::Start {
                request_id: "request-1".to_owned(),
                duration_seconds: 30,
                now_ms: 0,
            })
            .expect_err("unavailable capability must be rejected"),
        ControllerError::CapabilityUnavailable
    );
    assert_eq!(controller.snapshot().status, Status::Unavailable);
}

#[test]
fn preparation_is_exactly_three_seconds_and_requires_effective_hook() {
    let mut controller = Controller::new(Capability::Available);
    let transition = start(&mut controller, 10_000);
    assert_eq!(transition.snapshot.status, Status::Preparing);
    assert!(matches!(transition.effects[0], Effect::StartHelper(_)));

    confirm(&mut controller, 12_999);
    assert_eq!(controller.snapshot().status, Status::Preparing);
    let transition = controller
        .dispatch(Event::Tick { now_ms: 13_000 })
        .expect("preparation deadline should be processable");
    assert_eq!(transition.snapshot.status, Status::Active);
    assert_eq!(transition.snapshot.hook, HookStatus::Confirmed);
}

#[test]
fn unconfirmed_or_silent_hook_can_never_be_reported_active() {
    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    let transition = controller
        .dispatch(Event::Tick {
            now_ms: PREPARATION_WINDOW_MS,
        })
        .expect("unconfirmed preparation should release");
    assert_eq!(transition.snapshot.status, Status::Releasing);
    assert_eq!(
        transition.snapshot.end_reason,
        Some(EndReason::HookUnconfirmed)
    );
    assert!(
        !transition
            .effects
            .iter()
            .all(|effect| !matches!(effect, Effect::StopHelper(_)))
    );

    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    controller
        .dispatch(Event::HookReady {
            request_id: "request-1".to_owned(),
            capability: Capability::Available,
            effectiveness: HookEffectiveness::SilentlyIneffective,
            now_ms: 1_000,
        })
        .expect("ineffective hook should be released");
    assert_eq!(controller.snapshot().status, Status::Releasing);
    assert_ne!(controller.snapshot().status, Status::Active);
}

#[test]
fn heartbeat_loss_releases_after_three_seconds() {
    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    confirm(&mut controller, 1_000);
    controller
        .dispatch(Event::Tick { now_ms: 3_000 })
        .expect("activation should succeed");
    controller
        .dispatch(Event::Heartbeat {
            request_id: "request-1".to_owned(),
            sequence: 1,
            now_ms: 3_001,
        })
        .expect("heartbeat should renew lease");
    let transition = controller
        .dispatch(Event::Tick { now_ms: 6_001 })
        .expect("heartbeat timeout should release");
    assert_eq!(transition.snapshot.status, Status::Releasing);
    assert_eq!(
        transition.snapshot.end_reason,
        Some(EndReason::HeartbeatLost)
    );
}

#[test]
fn mouse_focus_host_sleep_and_permission_events_all_release() {
    for (event, reason) in [
        (
            Event::MouseActivity { now_ms: 3_001 },
            EndReason::MouseActivity,
        ),
        (Event::FocusLost { now_ms: 3_001 }, EndReason::FocusLost),
        (Event::HostExited { now_ms: 3_001 }, EndReason::HostExited),
        (Event::Sleeping { now_ms: 3_001 }, EndReason::Sleeping),
        (
            Event::PermissionRevoked { now_ms: 3_001 },
            EndReason::PermissionRevoked,
        ),
    ] {
        let mut controller = Controller::new(Capability::Available);
        start(&mut controller, 0);
        confirm(&mut controller, 1_000);
        controller
            .dispatch(Event::Tick { now_ms: 3_000 })
            .expect("activation should succeed");
        let transition = controller
            .dispatch(event)
            .expect("release event should work");
        assert_eq!(transition.snapshot.status, Status::Releasing);
        assert_eq!(transition.snapshot.end_reason, Some(reason));
    }
}

#[test]
fn duration_and_hard_deadline_are_bounded() {
    for duration in ALLOWED_DURATION_SECONDS {
        let mut controller = Controller::new(Capability::Available);
        let transition = controller
            .dispatch(Event::Start {
                request_id: format!("request-{duration}"),
                duration_seconds: duration,
                now_ms: 0,
            })
            .expect("allowed duration should start");
        assert_eq!(transition.snapshot.hard_deadline_ms, Some(HARD_LIMIT_MS));
        assert_eq!(
            transition.snapshot.active_deadline_ms,
            Some(PREPARATION_WINDOW_MS + duration * 1000)
        );
    }
    let mut controller = Controller::new(Capability::Available);
    assert_eq!(
        controller
            .dispatch(Event::Start {
                request_id: "request-1".to_owned(),
                duration_seconds: 181,
                now_ms: 0,
            })
            .expect_err("arbitrary duration should be rejected"),
        ControllerError::InvalidDuration
    );
}

#[test]
fn late_hook_confirmation_after_preparation_never_revives_session() {
    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    controller
        .dispatch(Event::Tick { now_ms: 3_000 })
        .expect("preparation should time out");
    let transition = controller
        .apply_helper_signal(
            HelperSignal::Ready(ReadySignal {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                request_id: "request-1".to_owned(),
                capability: HelperCapability::Available,
                effectiveness: HookEffectiveness::Confirmed,
            }),
            3_001,
        )
        .expect("late signal should be harmless");
    assert_eq!(transition.snapshot.status, Status::Releasing);
    assert_ne!(transition.snapshot.status, Status::Active);
}

#[test]
fn release_must_be_acknowledged_and_unconfirmed_release_is_not_active() {
    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    confirm(&mut controller, 1_000);
    controller
        .dispatch(Event::Tick { now_ms: 3_000 })
        .expect("activation should succeed");
    controller
        .dispatch(Event::Cancel { now_ms: 3_001 })
        .expect("cancel should release");
    let transition = controller
        .dispatch(Event::ReleaseUnconfirmed {
            request_id: "request-1".to_owned(),
            now_ms: 3_002,
        })
        .expect("unconfirmed release should be terminal");
    assert_eq!(transition.snapshot.status, Status::Ended);
    assert!(!transition.snapshot.release_confirmed);
    assert_ne!(transition.snapshot.status, Status::Active);
}

#[test]
fn hard_deadline_is_independent_from_the_selected_duration() {
    let mut controller = Controller::new(Capability::Available);
    controller
        .dispatch(Event::Start {
            request_id: "request-1".to_owned(),
            duration_seconds: 120,
            now_ms: 0,
        })
        .expect("start should be accepted");
    controller
        .dispatch(Event::HookReady {
            request_id: "request-1".to_owned(),
            capability: Capability::Available,
            effectiveness: HookEffectiveness::Confirmed,
            now_ms: 1_000,
        })
        .expect("hook should be confirmed");
    controller
        .dispatch(Event::Tick {
            now_ms: PREPARATION_WINDOW_MS,
        })
        .expect("preparation should complete");
    let transition = controller
        .dispatch(Event::Tick {
            now_ms: HARD_LIMIT_MS,
        })
        .expect("hard deadline should release");
    assert_eq!(transition.snapshot.status, Status::Releasing);
    assert_eq!(
        transition.snapshot.end_reason,
        Some(EndReason::HardDeadline)
    );
}

#[test]
fn helper_lifecycle_signal_is_request_bound_and_ends_on_mouse_activity() {
    let mut controller = Controller::new(Capability::Available);
    start(&mut controller, 0);
    confirm(&mut controller, 1_000);
    controller
        .dispatch(Event::Tick {
            now_ms: PREPARATION_WINDOW_MS,
        })
        .expect("activation should succeed");
    let transition = controller
        .apply_helper_signal(
            HelperSignal::Lifecycle(LifecycleSignal {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                request_id: "request-1".to_owned(),
                reason: HelperLifecycleReason::MouseActivity,
            }),
            PREPARATION_WINDOW_MS + 1,
        )
        .expect("lifecycle signal should be accepted");
    assert_eq!(transition.snapshot.status, Status::Releasing);
    assert_eq!(
        transition.snapshot.end_reason,
        Some(EndReason::MouseActivity)
    );
}
