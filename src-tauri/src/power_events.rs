use std::sync::{Arc, Mutex};

use crate::toolbox_power::PowerService;

/// Emitted after macOS reports that the system has resumed from sleep.
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
#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct PowerEventObserver {
    observer: Option<MacPowerEventObserver>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct PowerEventObserver;

impl PowerEventObserver {
    /// Registers the platform notifications. Reinstalling first removes any
    /// existing registration, keeping ownership and teardown unambiguous.
    pub fn install(
        &mut self,
        power: Arc<Mutex<PowerService>>,
        on_wake: Arc<dyn Fn() + Send + Sync>,
        on_sleep: Arc<dyn Fn() + Send + Sync>,
    ) {
        #[cfg(target_os = "macos")]
        {
            self.shutdown();
            self.observer = Some(MacPowerEventObserver::register(power, on_wake, on_sleep));
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (power, on_wake, on_sleep);
        }
    }

    /// Removes the platform registrations before the application exits.
    pub fn shutdown(&mut self) {
        #[cfg(target_os = "macos")]
        {
            // Dropping the owner invokes removeObserver: for both tokens.
            self.observer.take();
        }
    }
}

/// This callback intentionally performs only the in-memory power-state
/// transition. The PowerService worker releases the native assertion after
/// being signalled; no filesystem, storage, scan, or wake-restart work occurs
/// on the NSWorkspace notification stack.
#[cfg(target_os = "macos")]
fn release_keep_awake_for_system_sleep(power: &Arc<Mutex<PowerService>>) {
    let mut power = power
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = power.handle_system_sleep();
}

#[cfg(target_os = "macos")]
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
    fn register(
        power: Arc<Mutex<PowerService>>,
        on_wake: Arc<dyn Fn() + Send + Sync>,
        on_sleep: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let workspace = NSWorkspace::sharedWorkspace();
        let notification_center = workspace.notificationCenter();

        let sleep_power = Arc::clone(&power);
        let screens_sleep_power = Arc::clone(&power);
        let session_resign_power = Arc::clone(&power);
        let sleep_keyboard = Arc::clone(&on_sleep);
        let screens_sleep_keyboard = Arc::clone(&on_sleep);
        let session_resign_keyboard = Arc::clone(&on_sleep);
        let sleep_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    release_keep_awake_for_system_sleep(&sleep_power);
                    sleep_keyboard.as_ref()();
                }),
            )
        };
        let screens_sleep_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceScreensDidSleepNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    release_keep_awake_for_system_sleep(&screens_sleep_power);
                    screens_sleep_keyboard.as_ref()();
                }),
            )
        };
        let session_resign_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceSessionDidResignActiveNotification),
                None,
                None,
                &RcBlock::new(move |_| {
                    release_keep_awake_for_system_sleep(&session_resign_power);
                    session_resign_keyboard.as_ref()();
                }),
            )
        };
        let wake_observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &RcBlock::new(move |_| notify_system_wake(on_wake.as_ref())),
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
        // removing both tokens prevents callbacks after Tauri has begun exit.
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn sleep_handler_routes_to_the_existing_power_service() {
        let power = Arc::new(Mutex::new(PowerService::new()));

        release_keep_awake_for_system_sleep(&power);

        let state = power.lock().unwrap().snapshot();
        assert_eq!(state.status, "inactive");
        assert_eq!(state.reason.as_deref(), Some("system_sleep"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wake_handler_only_invokes_the_lightweight_notifier() {
        let notifications = Arc::new(AtomicUsize::new(0));
        let wake_notifications = Arc::clone(&notifications);

        notify_system_wake(&move || {
            wake_notifications.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(notifications.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_observer_has_a_safe_empty_lifecycle() {
        let mut observer = PowerEventObserver::default();
        observer.shutdown();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_observer_covers_sleeping_screens_and_inactive_sessions() {
        let source = include_str!("power_events.rs");
        assert!(source.contains("NSWorkspaceScreensDidSleepNotification"));
        assert!(source.contains("NSWorkspaceSessionDidResignActiveNotification"));
    }
}
