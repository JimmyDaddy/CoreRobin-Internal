//! An invisible top-level window receives broadcasts as well as this session's
//! WTS notifications. A message-only HWND would miss power broadcasts.

use std::ptr::{null, null_mut};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    HPOWERNOTIFY, RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification,
};
use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentThreadId, INFINITE, SetEvent};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

use super::{PowerEvent, PowerEventCallbacks};

const REGISTRATION_RETRY_MS: u32 = 5_000;
const SHUTDOWN_WAIT: Duration = Duration::from_millis(500);

struct StopEvent(HANDLE);

// A kernel event may be signalled and waited on from different threads. Arc
// keeps the handle open until both the owner and message worker have exited.
unsafe impl Send for StopEvent {}
unsafe impl Sync for StopEvent {}

impl Drop for StopEvent {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) struct WindowsPowerEventObserver {
    stop: Arc<StopEvent>,
    finished: mpsc::Receiver<()>,
    worker: Option<JoinHandle<()>>,
}

impl WindowsPowerEventObserver {
    pub(super) fn register(callbacks: PowerEventCallbacks) -> Result<Self, String> {
        let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
        if handle.is_null() {
            return Err(format!(
                "cannot create notification stop event: {}",
                std::io::Error::last_os_error()
            ));
        }
        let stop = Arc::new(StopEvent(handle));
        let worker_stop = Arc::clone(&stop);
        let (finished_tx, finished) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("power-session-events".into())
            .spawn(move || {
                if let Err(error) = observe(&worker_stop, callbacks.clone()) {
                    callbacks.dispatch(PowerEvent::SessionInactive);
                    eprintln!("Windows power/session observation stopped: {error}");
                }
                let _ = finished_tx.send(());
            })
            .map_err(|error| format!("cannot start notification worker: {error}"))?;
        Ok(Self {
            stop,
            finished,
            worker: Some(worker),
        })
    }
}

impl Drop for WindowsPowerEventObserver {
    fn drop(&mut self) {
        unsafe {
            SetEvent(self.stop.0);
        }
        if self.finished.recv_timeout(SHUTDOWN_WAIT).is_ok()
            && let Some(worker) = self.worker.take()
        {
            let _ = worker.join();
        }
        // An already-running Tauri callback may need the main event loop to
        // finish. Never deadlock that loop by joining it indefinitely. The stop
        // event remains alive in the worker, which removes registrations when
        // the callback returns; the parent has already disabled new callbacks.
    }
}

struct NotificationWindow {
    hwnd: HWND,
    instance: HINSTANCE,
    class_name: Vec<u16>,
    class_registered: bool,
    callbacks: Box<PowerEventCallbacks>,
    session_registered: bool,
    suspend_registration: HPOWERNOTIFY,
    registration_failure_reported: bool,
}

impl NotificationWindow {
    fn create(callbacks: PowerEventCallbacks) -> Result<Self, String> {
        let instance = unsafe { GetModuleHandleW(null()) };
        let class_name: Vec<u16> =
            format!("CoreRobinPowerEvents-{}", unsafe { GetCurrentThreadId() })
                .encode_utf16()
                .chain(Some(0))
                .collect();
        let mut owner = Self {
            hwnd: null_mut(),
            instance,
            class_name,
            class_registered: false,
            callbacks: Box::new(callbacks),
            session_registered: false,
            suspend_registration: 0,
            registration_failure_reported: false,
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: owner.class_name.as_ptr(),
            ..Default::default()
        };
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err(format!(
                "cannot register notification window: {}",
                std::io::Error::last_os_error()
            ));
        }
        owner.class_registered = true;
        owner.hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                owner.class_name.as_ptr(),
                null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                (&mut *owner.callbacks as *mut PowerEventCallbacks).cast(),
            )
        };
        if owner.hwnd.is_null() {
            return Err(format!(
                "cannot create notification window: {}",
                std::io::Error::last_os_error()
            ));
        }
        owner.register_notifications();
        Ok(owner)
    }

    fn register_notifications(&mut self) {
        if !self.session_registered {
            self.session_registered =
                unsafe { WTSRegisterSessionNotification(self.hwnd, NOTIFY_FOR_THIS_SESSION) } != 0;
        }
        if self.suspend_registration == 0 {
            self.suspend_registration = unsafe {
                RegisterSuspendResumeNotification(self.hwnd, DEVICE_NOTIFY_WINDOW_HANDLE)
            };
        }
        if !self.fully_registered() && !self.registration_failure_reported {
            self.registration_failure_reported = true;
            self.callbacks.dispatch(PowerEvent::SessionInactive);
            eprintln!(
                "Windows session/power notification registration is unavailable; retrying every 5 seconds"
            );
        }
    }

    fn fully_registered(&self) -> bool {
        self.session_registered && self.suspend_registration != 0
    }
}

impl Drop for NotificationWindow {
    fn drop(&mut self) {
        unsafe {
            if self.session_registered {
                WTSUnRegisterSessionNotification(self.hwnd);
            }
            if self.suspend_registration != 0 {
                UnregisterSuspendResumeNotification(self.suspend_registration);
            }
            if !self.hwnd.is_null() {
                DestroyWindow(self.hwnd);
            }
            if self.class_registered {
                UnregisterClassW(self.class_name.as_ptr(), self.instance);
            }
        }
    }
}

fn observe(stop: &StopEvent, callbacks: PowerEventCallbacks) -> Result<(), String> {
    let mut window = NotificationWindow::create(callbacks)?;
    loop {
        let timeout = if window.fully_registered() {
            INFINITE
        } else {
            REGISTRATION_RETRY_MS
        };
        let result = unsafe {
            MsgWaitForMultipleObjectsEx(1, &stop.0, timeout, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        match result {
            WAIT_OBJECT_0 => return Ok(()),
            WAIT_TIMEOUT => window.register_notifications(),
            WAIT_FAILED => return Err(std::io::Error::last_os_error().to_string()),
            value if value == WAIT_OBJECT_0 + 1 => {
                let mut message = MSG::default();
                // Limit each batch so an event flood cannot starve shutdown.
                for _ in 0..64 {
                    if unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } == 0 {
                        break;
                    }
                    if message.message == WM_QUIT {
                        return Ok(());
                    }
                    unsafe {
                        DispatchMessageW(&message);
                    }
                }
            }
            _ => return Err(format!("unexpected message wait result {result}")),
        }
    }
}

fn classify_event(message: u32, detail: WPARAM) -> Option<PowerEvent> {
    match (message, detail as u32) {
        (
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_LOCK | WTS_SESSION_LOGOFF | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT,
        ) => Some(PowerEvent::SessionInactive),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(PowerEvent::Sleep),
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMECRITICAL) => {
            Some(PowerEvent::Wake)
        }
        // Unlock/reconnect and focus events never reveal or hide the chat.
        _ => None,
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let creation = unsafe { &*(lparam as *const CREATESTRUCTW) };
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, creation.lpCreateParams as isize);
        }
    }
    if message == WM_NCDESTROY {
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        }
    } else if let Some(event) = classify_event(message, wparam) {
        let callbacks =
            unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const PowerEventCallbacks };
        if !callbacks.is_null() {
            // Rust panics must never cross a Win32 callback boundary.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                unsafe { &*callbacks }.dispatch(event)
            }));
        }
        return 1;
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_and_disconnects_hide_private_content_but_unlock_and_focus_do_not() {
        for detail in [
            WTS_SESSION_LOCK,
            WTS_SESSION_LOGOFF,
            WTS_CONSOLE_DISCONNECT,
            WTS_REMOTE_DISCONNECT,
        ] {
            assert_eq!(
                classify_event(WM_WTSSESSION_CHANGE, detail as _),
                Some(PowerEvent::SessionInactive)
            );
        }
        for detail in [WTS_SESSION_UNLOCK, WTS_CONSOLE_CONNECT, WTS_REMOTE_CONNECT] {
            assert_eq!(classify_event(WM_WTSSESSION_CHANGE, detail as _), None);
        }
        assert_eq!(classify_event(WM_KILLFOCUS, 0), None);
        assert_eq!(classify_event(WM_ACTIVATE, WA_INACTIVE as _), None);
    }

    #[test]
    fn suspend_and_automatic_resume_use_separate_callbacks() {
        assert_eq!(
            classify_event(WM_POWERBROADCAST, PBT_APMSUSPEND as _),
            Some(PowerEvent::Sleep)
        );
        assert_eq!(
            classify_event(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC as _),
            Some(PowerEvent::Wake)
        );
        assert_eq!(
            classify_event(WM_POWERBROADCAST, PBT_APMRESUMESUSPEND as _),
            None
        );
    }
}
