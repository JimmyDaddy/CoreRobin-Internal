mod error;
mod identity;
mod models;
mod monitor;

use std::sync::{Arc, Mutex};

use error::CommandError;
use models::{
    ProcessActionRequest, ProcessActionResult, ProcessDetail, ProcessDetailRequest, SystemSnapshot,
};
use monitor::SystemMonitor;
use tauri::State;

#[derive(Clone)]
struct AppState {
    monitor: Arc<Mutex<SystemMonitor>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            monitor: Arc::new(Mutex::new(SystemMonitor::new())),
        }
    }
}

async fn with_monitor<T, F>(
    monitor: Arc<Mutex<SystemMonitor>>,
    operation: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut SystemMonitor) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut monitor = monitor
            .lock()
            .map_err(|_| CommandError::internal("The system monitor lock was poisoned."))?;
        operation(&mut monitor)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Monitor task failed: {error}")))?
}

#[tauri::command]
async fn get_system_snapshot(state: State<'_, AppState>) -> Result<SystemSnapshot, CommandError> {
    with_monitor(Arc::clone(&state.monitor), |monitor| Ok(monitor.sample())).await
}

#[tauri::command]
async fn get_process_detail(
    state: State<'_, AppState>,
    request: ProcessDetailRequest,
) -> Result<ProcessDetail, CommandError> {
    with_monitor(Arc::clone(&state.monitor), move |monitor| {
        monitor.process_detail(request)
    })
    .await
}

#[tauri::command]
async fn execute_process_action(
    state: State<'_, AppState>,
    request: ProcessActionRequest,
) -> Result<ProcessActionResult, CommandError> {
    with_monitor(Arc::clone(&state.monitor), move |monitor| {
        monitor.execute_action(request)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            get_system_snapshot,
            get_process_detail,
            execute_process_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pulse");
}
