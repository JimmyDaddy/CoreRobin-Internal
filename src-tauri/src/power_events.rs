use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::toolbox_power::PowerService;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

/// Emitted after the operating system reports that it has resumed from sleep.
///
/// The notification deliberately carries no system details. Consumers should
/// refresh only on their usual cadence instead of starting work in the native
/// wake callback.
pub const SYSTEM_WAKE_EVENT: &str = "system-wake";

/// Owns the platform power-notification registrations for the app lifetime.
///
/// On macOS the native observer tokens are main-thread-affine, so this type is
/// held by the Tauri event-loop closure rather than managed application state.
/// Tauri requires managed state to be Send + Sync, which those Objective-C
/// tokens intentionally are not.
#[derive(Default)]
pub struct PowerEventObserver {
    #[cfg(target_os = "macos")]
    observer: Option<MacPowerEventObserver>,
    #[cfg(windows)]
    observer: Option<windows::WindowsPowerEventObserver>,
    #[cfg(target_os = "linux")]
    observer: Option<linux::LinuxPowerEventObserver>,
    callbacks: Option<PowerEventCallbacks>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PowerEvent {
    Sleep,
    SessionInactive,
    Wake,
}

#[derive(Clone)]
struct PowerEventCallbacks {
    power: Arc<Mutex<PowerService>>,
    on_wake: Arc<dyn Fn() + Send + Sync>,
    on_sleep: Arc<dyn Fn() + Send + Sync>,
    active: Arc<AtomicBool>,
}

impl PowerEventCallbacks {
    fn dispatch(&self, event: PowerEvent) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        match event {
            PowerEvent::Sleep | PowerEvent::SessionInactive => {
                // Hide private content before touching the power-service mutex.
                (self.on_sleep)();
                release_keep_awake_for_system_sleep(&self.power);
            }
            // Wake/unlock notifications never restore the private chat window.
            PowerEvent::Wake => notify_system_wake(self.on_wake.as_ref()),
        }
    }
}

impl PowerEventObserver {
    /// Registers the platform notifications. Reinstalling first removes any
    /// existing registration, keeping ownership and teardown unambiguous.
    pub fn install(
        &mut self,
        power: Arc<Mutex<PowerService>>,
        on_wake: Arc<dyn Fn() + Send + Sync>,
        on_sleep: Arc<dyn Fn() + Send + Sync>,
    ) {
        self.shutdown();
        let callbacks = PowerEventCallbacks {
            power,
            on_wake,
            on_sleep,
            active: Arc::new(AtomicBool::new(true)),
        };
        #[cfg(target_os = "macos")]
        {
            self.observer = Some(MacPowerEventObserver::register(callbacks.clone()));
        }
        #[cfg(windows)]
        {
            match windows::WindowsPowerEventObserver::register(callbacks.clone()) {
                Ok(observer) => self.observer = Some(observer),
                Err(error) => {
                    callbacks.dispatch(PowerEvent::SessionInactive);
                    eprintln!("Windows power/session observation unavailable: {error}");
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            match linux::LinuxPowerEventObserver::register(callbacks.clone()) {
                Ok(observer) => self.observer = Some(observer),
                Err(error) => {
                    callbacks.dispatch(PowerEvent::SessionInactive);
                    eprintln!("Linux power/session observation unavailable: {error}");
                }
            }
        }
        self.callbacks = Some(callbacks);
    }

    /// Removes the platform registrations before the application exits.
    pub fn shutdown(&mut self) {
        if let Some(callbacks) = self.callbacks.take() {
            callbacks.active.store(false, Ordering::Release);
        }
        #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
        {
            self.observer.take();
        }
    }
}

impl Drop for PowerEventObserver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// This callback intentionally performs only the in-memory power-state
/// transition. The PowerService worker releases the native assertion after
/// being signalled; no filesystem, storage, scan, or wake-restart work occurs
/// on the native notification stack.
fn release_keep_awake_for_system_sleep(power: &Arc<Mutex<PowerService>>) {
    let mut power = power
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = power.handle_system_sleep();
}

fn notify_system_wake(on_wake: &dyn Fn()) {
    on_wake();
}

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSNotificationCenter;

#[cfg(target_os = "macos")]
struct MacPowerEventObserver {
    notification_center: Retained<NSNotificationCenter>,
    sleep_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    screens_sleep_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    session_resign_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    wake_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

#[cfg(target_os = "macos")]
impl MacPowerEventObserver {
    fn register(callbacks: PowerEventCallbacks) -> Self {
        let workspace = NSWorkspace::sharedWorkspace();
        let notification_center = workspace.notificationCenter();

        let sleep_callbacks = callbacks.clone();
        let screens_sleep_callbacks = callbacks.clone();
        let session_resign_callbacks = callbacks.clone();
        let sleep_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    sleep_callbacks.dispatch(PowerEvent::Sleep);
                }),
            )
        };
        let screens_sleep_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceScreensDidSleepNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    screens_sleep_callbacks.dispatch(PowerEvent::SessionInactive);
                }),
            )
        };
        let session_resign_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceSessionDidResignActiveNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    session_resign_callbacks.dispatch(PowerEvent::SessionInactive);
                }),
            )
        };
        let wake_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &RcBlock::new(move |_| callbacks.dispatch(PowerEvent::Wake)),
            )
        };

        Self {
            notification_center,
            sleep_observer: Some(sleep_observer),
            screens_sleep_observer: Some(screens_sleep_observer),
            session_resign_observer: Some(session_resign_observer),
            wake_observer: Some(wake_observer),
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacPowerEventObserver {
    fn drop(&mut self) {
        // NSNotificationCenter retains the block-backed token. Explicitly
        // removing every token prevents callbacks after Tauri has begun exit.
        unsafe {
            if let Some(observer) = self.sleep_observer.take() {
                let observer: &AnyObject = (*observer).as_ref();
                self.notification_center.removeObserver(observer);
            }
            if let Some(observer) = self.screens_sleep_observer.take() {
                let observer: &AnyObject = (*observer).as_ref();
                self.notification_center.removeObserver(observer);
            }
            if let Some(observer) = self.session_resign_observer.take() {
                let observer: &AnyObject = (*observer).as_ref();
                self.notification_center.removeObserver(observer);
            }
            if let Some(observer) = self.wake_observer.take() {
                let observer: &AnyObject = (*observer).as_ref();
                self.notification_center.removeObserver(observer);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn sleep_handler_routes_to_the_existing_power_service() {
        let power = Arc::new(Mutex::new(PowerService::new()));

        release_keep_awake_for_system_sleep(&power);

        let state = power.lock().unwrap().snapshot();
        assert_eq!(state.status, "inactive");
        assert_eq!(state.reason.as_deref(), Some("system_sleep"));
    }

    #[test]
    fn wake_handler_only_invokes_the_lightweight_notifier() {
        let notifications = Arc::new(AtomicUsize::new(0));
        let wake_notifications = Arc::clone(&notifications);

        notify_system_wake(&move || {
            wake_notifications.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(notifications.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn observer_has_a_safe_empty_lifecycle() {
        let mut observer = PowerEventObserver::default();
        observer.shutdown();
    }

    #[test]
    fn session_inactivity_hides_private_content_and_shutdown_blocks_late_callbacks() {
        let hides = Arc::new(AtomicUsize::new(0));
        let wakes = Arc::new(AtomicUsize::new(0));
        let hide_count = Arc::clone(&hides);
        let wake_count = Arc::clone(&wakes);
        let callbacks = PowerEventCallbacks {
            power: Arc::new(Mutex::new(PowerService::new())),
            on_wake: Arc::new(move || {
                wake_count.fetch_add(1, Ordering::SeqCst);
            }),
            on_sleep: Arc::new(move || {
                hide_count.fetch_add(1, Ordering::SeqCst);
            }),
            active: Arc::new(AtomicBool::new(true)),
        };
        callbacks.dispatch(PowerEvent::SessionInactive);
        assert_eq!(hides.load(Ordering::SeqCst), 1);
        assert_eq!(wakes.load(Ordering::SeqCst), 0);
        callbacks.dispatch(PowerEvent::Wake);
        assert_eq!(hides.load(Ordering::SeqCst), 1);
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        callbacks.active.store(false, Ordering::Release);
        for event in [
            PowerEvent::Sleep,
            PowerEvent::SessionInactive,
            PowerEvent::Wake,
        ] {
            callbacks.dispatch(event);
        }
        assert_eq!(hides.load(Ordering::SeqCst), 1);
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_observer_covers_sleeping_screens_and_inactive_sessions() {
        let source = include_str!("power_events.rs");
        assert!(source.contains("NSWorkspaceScreensDidSleepNotification"));
        assert!(source.contains("NSWorkspaceSessionDidResignActiveNotification"));
    }
}
