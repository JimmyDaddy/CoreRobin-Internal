use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::CommandError;

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::ProtocolObject;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateTaskPhase {
    #[default]
    Idle,
    Downloading,
    Installing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateTaskSnapshot {
    pub version: Option<String>,
    pub phase: AppUpdateTaskPhase,
    pub downloaded_bytes: u64,
    pub content_length: Option<u64>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Default)]
pub struct AppUpdateTaskManager {
    snapshot: Arc<Mutex<AppUpdateTaskSnapshot>>,
}

impl AppUpdateTaskManager {
    pub fn snapshot(&self) -> Result<AppUpdateTaskSnapshot, CommandError> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| CommandError::internal("The app update task lock was poisoned."))
    }

    pub fn start(
        &self,
        app: AppHandle,
        requested_version: String,
    ) -> Result<AppUpdateTaskSnapshot, CommandError> {
        let requested_version = requested_version.trim();
        if requested_version.is_empty() {
            return Err(CommandError::new(
                "invalid_update_version",
                "The requested update version is empty.",
            ));
        }

        {
            let mut snapshot = self
                .snapshot
                .lock()
                .map_err(|_| CommandError::internal("The app update task lock was poisoned."))?;
            if matches!(
                snapshot.phase,
                AppUpdateTaskPhase::Downloading | AppUpdateTaskPhase::Installing
            ) {
                if snapshot.version.as_deref() == Some(requested_version) {
                    return Ok(snapshot.clone());
                }
                return Err(CommandError::new(
                    "app_update_in_progress",
                    "Another app update is already in progress.",
                ));
            }
            if snapshot.phase == AppUpdateTaskPhase::Ready
                && snapshot.version.as_deref() == Some(requested_version)
            {
                return Ok(snapshot.clone());
            }
            *snapshot = AppUpdateTaskSnapshot {
                version: Some(requested_version.to_owned()),
                phase: AppUpdateTaskPhase::Downloading,
                downloaded_bytes: 0,
                content_length: None,
                updated_at_ms: now_millis(),
            };
        }

        let expected_version = requested_version.to_owned();
        let state = Arc::clone(&self.snapshot);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("core-robin-app-update".to_owned())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                let _activity = AppUpdateActivity::begin();
                let result = tauri::async_runtime::block_on(run_update(
                    app,
                    expected_version,
                    Arc::clone(&worker_state),
                ));
                if result.is_err() {
                    update_snapshot(&worker_state, |snapshot| {
                        snapshot.phase = AppUpdateTaskPhase::Failed;
                    });
                }
            });

        if let Err(error) = worker {
            update_snapshot(&state, |snapshot| {
                snapshot.phase = AppUpdateTaskPhase::Failed;
            });
            return Err(CommandError::internal(format!(
                "Failed to start the app update task: {error}"
            )));
        }

        self.snapshot()
    }
}

async fn run_update(
    app: AppHandle,
    expected_version: String,
    state: Arc<Mutex<AppUpdateTaskSnapshot>>,
) -> Result<(), CommandError> {
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| CommandError::internal(format!("Updater setup failed: {error}")))?;
    let mut update = updater
        .check()
        .await
        .map_err(|error| CommandError::internal(format!("Update check failed: {error}")))?
        .ok_or_else(|| {
            CommandError::new(
                "app_update_unavailable",
                "The requested app update is no longer available.",
            )
        })?;
    if update.version != expected_version {
        return Err(CommandError::new(
            "app_update_version_changed",
            "A different app update is now available.",
        ));
    }
    // The metadata request should fail quickly, but a signed installer may need
    // much longer on a slow or temporarily backgrounded connection.
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let progress_state = Arc::clone(&state);
    let installing_state = Arc::clone(&state);
    update
        .download_and_install(
            move |chunk_length, content_length| {
                update_snapshot(&progress_state, |snapshot| {
                    snapshot.phase = AppUpdateTaskPhase::Downloading;
                    snapshot.downloaded_bytes = snapshot
                        .downloaded_bytes
                        .saturating_add(chunk_length as u64);
                    if content_length.is_some() {
                        snapshot.content_length = content_length;
                    }
                });
            },
            move || {
                update_snapshot(&installing_state, |snapshot| {
                    snapshot.phase = AppUpdateTaskPhase::Installing;
                });
            },
        )
        .await
        .map_err(|error| CommandError::internal(format!("Update installation failed: {error}")))?;

    update_snapshot(&state, |snapshot| {
        snapshot.phase = AppUpdateTaskPhase::Ready;
    });
    Ok(())
}

fn update_snapshot(
    state: &Arc<Mutex<AppUpdateTaskSnapshot>>,
    update: impl FnOnce(&mut AppUpdateTaskSnapshot),
) {
    if let Ok(mut snapshot) = state.lock() {
        update(&mut snapshot);
        snapshot.updated_at_ms = now_millis();
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(target_os = "macos")]
struct AppUpdateActivity {
    process_info: Retained<NSProcessInfo>,
    activity: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

#[cfg(target_os = "macos")]
impl AppUpdateActivity {
    fn begin() -> Self {
        let process_info = NSProcessInfo::processInfo();
        let reason = NSString::from_str("CoreRobin app update");
        let activity =
            process_info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &reason);
        Self {
            process_info,
            activity,
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for AppUpdateActivity {
    fn drop(&mut self) {
        // SAFETY: `activity` is the exact retained token returned by this
        // `NSProcessInfo` instance and is ended once when the guard is dropped.
        unsafe {
            self.process_info.endActivity(&self.activity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppUpdateTaskManager, AppUpdateTaskPhase, AppUpdateTaskSnapshot, update_snapshot};

    #[test]
    fn records_download_progress_without_losing_the_known_total() {
        let manager = AppUpdateTaskManager::default();
        {
            let mut snapshot = manager.snapshot.lock().unwrap();
            *snapshot = AppUpdateTaskSnapshot {
                version: Some("0.2.0".to_owned()),
                phase: AppUpdateTaskPhase::Downloading,
                ..AppUpdateTaskSnapshot::default()
            };
        }

        update_snapshot(&manager.snapshot, |snapshot| {
            snapshot.downloaded_bytes += 250;
            snapshot.content_length = Some(1_000);
        });
        update_snapshot(&manager.snapshot, |snapshot| {
            snapshot.downloaded_bytes += 750;
        });

        let snapshot = manager.snapshot().unwrap();
        assert_eq!(snapshot.downloaded_bytes, 1_000);
        assert_eq!(snapshot.content_length, Some(1_000));
        assert!(snapshot.updated_at_ms > 0);
    }
}
