mod application_icon;
mod cleanup;
mod error;
mod identity;
mod models;
mod monitor;
mod network_connections;
mod process_control;
mod sensors;
mod startup;

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use application_icon::load_application_icon;
use cleanup::{
    CleanupDeleteController, CleanupScanCoordinator, inspect_cleanup_path, load_cleanup_scan_cache,
    remove_cleanup_scan_cache, save_cleanup_scan_snapshot_cache, scan_cleanup,
    scan_cleanup_subtree,
};
use error::CommandError;
use models::{
    ApplicationIcon, CleanupDeleteExecutionRequest, CleanupDeleteLease,
    CleanupDeleteLeaseReleaseRequest, CleanupDeleteLeaseRequest, CleanupDeleteResult,
    CleanupPathState, CleanupScan, CleanupScanProgress, CleanupSubtreeRequest,
    NetworkConnectionsSnapshot, ProcessActionRequest, ProcessActionResult, ProcessControlLease,
    ProcessControlLeaseReleaseRequest, ProcessControlLeaseRequest, ProcessDetail,
    ProcessDetailRequest, StartupItemsSnapshot, StartupManagementExecutionRequest,
    StartupManagementLease, StartupManagementLeaseReleaseRequest, StartupManagementLeaseRequest,
    StartupManagementResult, SystemSnapshot,
};
use monitor::SystemMonitor;
use network_connections::sample_network_connections;
use process_control::ProcessController;
use startup::{StartupController, scan_startup_items};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent,
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[derive(Clone)]
struct AppState {
    monitor: Arc<Mutex<SystemMonitor>>,
    process_controller: Arc<Mutex<ProcessController>>,
    cleanup_scan: Arc<CleanupScanCoordinator>,
    cleanup_delete_controller: Arc<Mutex<CleanupDeleteController>>,
    startup_controller: Arc<Mutex<StartupController>>,
}

impl AppState {
    fn new() -> Self {
        let process_controller = ProcessController::new();
        let process_control_capabilities = process_controller.capabilities();
        let process_controller = Arc::new(Mutex::new(process_controller));
        start_lease_reaper(Arc::downgrade(&process_controller));
        Self {
            monitor: Arc::new(Mutex::new(SystemMonitor::new(process_control_capabilities))),
            process_controller,
            cleanup_scan: Arc::new(CleanupScanCoordinator::default()),
            cleanup_delete_controller: Arc::new(Mutex::new(CleanupDeleteController::default())),
            startup_controller: Arc::new(Mutex::new(StartupController::default())),
        }
    }
}

fn start_lease_reaper(controller: Weak<Mutex<ProcessController>>) {
    std::thread::Builder::new()
        .name("status-orbit-control-lease-reaper".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(controller) = controller.upgrade() else {
                    break;
                };
                let Ok(mut controller) = controller.lock() else {
                    break;
                };
                controller.purge_expired();
            }
        })
        .expect("failed to start the process-control lease reaper");
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

async fn with_process_controller<T, F>(
    controller: Arc<Mutex<ProcessController>>,
    operation: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut ProcessController) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut controller = controller
            .lock()
            .map_err(|_| CommandError::internal("The process controller lock was poisoned."))?;
        operation(&mut controller)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Process control task failed: {error}")))?
}

async fn with_cleanup_delete_controller<T, F>(
    controller: Arc<Mutex<CleanupDeleteController>>,
    operation: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut CleanupDeleteController) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut controller = controller
            .lock()
            .map_err(|_| CommandError::internal("The cleanup controller lock was poisoned."))?;
        operation(&mut controller)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Cleanup task failed: {error}")))?
}

async fn with_startup_controller<T, F>(
    controller: Arc<Mutex<StartupController>>,
    operation: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut StartupController) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut controller = controller
            .lock()
            .map_err(|_| CommandError::internal("The startup controller lock was poisoned."))?;
        operation(&mut controller)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Startup task failed: {error}")))?
}

#[tauri::command]
async fn get_system_snapshot(state: State<'_, AppState>) -> Result<SystemSnapshot, CommandError> {
    with_monitor(Arc::clone(&state.monitor), |monitor| Ok(monitor.sample())).await
}

#[tauri::command]
async fn get_network_connections() -> Result<NetworkConnectionsSnapshot, CommandError> {
    tauri::async_runtime::spawn_blocking(sample_network_connections)
        .await
        .map_err(|error| CommandError::internal(format!("Connection scan failed: {error}")))?
}

#[tauri::command]
async fn get_startup_items() -> Result<StartupItemsSnapshot, CommandError> {
    tauri::async_runtime::spawn_blocking(scan_startup_items)
        .await
        .map_err(|error| CommandError::internal(format!("Startup item scan failed: {error}")))?
}

#[tauri::command]
async fn create_startup_management_lease(
    state: State<'_, AppState>,
    request: StartupManagementLeaseRequest,
) -> Result<StartupManagementLease, CommandError> {
    with_startup_controller(Arc::clone(&state.startup_controller), move |controller| {
        controller.create_lease(request)
    })
    .await
}

#[tauri::command]
async fn release_startup_management_lease(
    state: State<'_, AppState>,
    request: StartupManagementLeaseReleaseRequest,
) -> Result<(), CommandError> {
    with_startup_controller(Arc::clone(&state.startup_controller), move |controller| {
        controller.release_lease(&request.lease_id);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn execute_startup_management(
    state: State<'_, AppState>,
    request: StartupManagementExecutionRequest,
) -> Result<StartupManagementResult, CommandError> {
    with_startup_controller(Arc::clone(&state.startup_controller), move |controller| {
        controller.execute(request)
    })
    .await
}

#[tauri::command]
async fn get_cleanup_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<CleanupScanProgress>,
) -> Result<CleanupScan, CommandError> {
    let cache_path = cleanup_scan_cache_path(&app)?;
    let coordinator = Arc::clone(&state.cleanup_scan);
    let cancelled = coordinator.begin()?;
    let worker_cancelled = Arc::clone(&cancelled);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let scan = scan_cleanup(&worker_cancelled, &mut |progress| {
            let _ = on_progress.send(progress);
        })?;
        let _ = save_cleanup_scan_snapshot_cache(&cache_path, &scan);
        Ok::<_, CommandError>(scan)
    })
    .await;
    coordinator.finish(&cancelled);
    result.map_err(|error| CommandError::internal(format!("Cleanup scan failed: {error}")))?
}

#[tauri::command]
async fn get_cleanup_path_state(path: String) -> Result<CleanupPathState, CommandError> {
    tauri::async_runtime::spawn_blocking(move || inspect_cleanup_path(&path))
        .await
        .map_err(|error| CommandError::internal(format!("Cleanup path check failed: {error}")))?
}

#[tauri::command]
async fn get_cleanup_subtree(
    request: CleanupSubtreeRequest,
) -> Result<models::CleanupNode, CommandError> {
    tauri::async_runtime::spawn_blocking(move || scan_cleanup_subtree(request))
        .await
        .map_err(|error| CommandError::internal(format!("Cleanup subtree scan failed: {error}")))?
}

fn cleanup_scan_cache_path(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("cleanup-scan-v3.json"))
        .map_err(|error| {
            CommandError::internal(format!(
                "Could not resolve the application data folder: {error}"
            ))
        })
}

#[tauri::command]
async fn load_persisted_cleanup_scan(app: AppHandle) -> Result<Option<String>, CommandError> {
    let path = cleanup_scan_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_cleanup_scan_cache(&path))
        .await
        .map_err(|error| CommandError::internal(format!("Cleanup cache read failed: {error}")))?
}

#[tauri::command]
async fn clear_persisted_cleanup_scan(app: AppHandle) -> Result<(), CommandError> {
    let path = cleanup_scan_cache_path(&app)?;
    let legacy_path = path.with_file_name("cleanup-scan-v2.json");
    tauri::async_runtime::spawn_blocking(move || {
        remove_cleanup_scan_cache(&path)?;
        remove_cleanup_scan_cache(&legacy_path)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Cleanup cache removal failed: {error}")))?
}

#[tauri::command]
fn cancel_cleanup_scan(state: State<'_, AppState>) -> Result<bool, CommandError> {
    state.cleanup_scan.cancel()
}

#[tauri::command]
async fn create_cleanup_delete_lease(
    state: State<'_, AppState>,
    request: CleanupDeleteLeaseRequest,
) -> Result<CleanupDeleteLease, CommandError> {
    with_cleanup_delete_controller(
        Arc::clone(&state.cleanup_delete_controller),
        move |controller| controller.create_lease(request),
    )
    .await
}

#[tauri::command]
async fn release_cleanup_delete_lease(
    state: State<'_, AppState>,
    request: CleanupDeleteLeaseReleaseRequest,
) -> Result<(), CommandError> {
    with_cleanup_delete_controller(
        Arc::clone(&state.cleanup_delete_controller),
        move |controller| {
            controller.release_lease(&request.lease_id);
            Ok(())
        },
    )
    .await
}

#[tauri::command]
async fn execute_cleanup_delete(
    state: State<'_, AppState>,
    request: CleanupDeleteExecutionRequest,
) -> Result<CleanupDeleteResult, CommandError> {
    with_cleanup_delete_controller(
        Arc::clone(&state.cleanup_delete_controller),
        move |controller| controller.execute(request),
    )
    .await
}

#[tauri::command]
fn complete_startup(app: AppHandle) {
    show_main(&app);
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn navigate_main(app: &AppHandle, view: &str) {
    show_main(app);
    let _ = app.emit_to("main", "status-orbit:navigate", view);
}

fn toggle_tray_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window("tray") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    if let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) {
        let work_area = monitor.work_area();
        let right = work_area.position.x + work_area.size.width as i32;
        let x = right.saturating_sub(size.width as i32).saturating_sub(12);
        let y = work_area.position.y.saturating_add(10);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn tray_icon_image() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
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
async fn get_application_icon(
    state: State<'_, AppState>,
    request: ProcessDetailRequest,
) -> Result<Option<ApplicationIcon>, CommandError> {
    let executable = with_monitor(Arc::clone(&state.monitor), move |monitor| {
        Ok(monitor.process_detail(request)?.executable)
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || load_application_icon(executable.as_deref()))
        .await
        .map_err(|error| CommandError::internal(format!("Application icon task failed: {error}")))
}

#[tauri::command]
async fn create_process_control_lease(
    state: State<'_, AppState>,
    request: ProcessControlLeaseRequest,
) -> Result<ProcessControlLease, CommandError> {
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.create_lease(request)
    })
    .await
}

#[tauri::command]
async fn release_process_control_lease(
    state: State<'_, AppState>,
    request: ProcessControlLeaseReleaseRequest,
) -> Result<(), CommandError> {
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.release_lease(request);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn execute_process_action(
    state: State<'_, AppState>,
    request: ProcessActionRequest,
) -> Result<ProcessActionResult, CommandError> {
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.execute_action(request)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open StatusOrbit", true, None::<&str>)?;
            let cleanup = MenuItem::with_id(app, "cleanup", "Space Cleanup", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit StatusOrbit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &cleanup, &quit])?;
            let mut tray = TrayIconBuilder::with_id("status-orbit-status")
                .tooltip("StatusOrbit · Local Monitor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "cleanup" => navigate_main(app, "cleanup"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        toggle_tray_panel(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon(tray_icon_image()?).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("status-orbit-splash-fallback".to_owned())
                .spawn(move || {
                    std::thread::sleep(Duration::from_secs(10));
                    if handle.get_webview_window("splashscreen").is_some() {
                        complete_startup(handle);
                    }
                })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_snapshot,
            get_network_connections,
            get_startup_items,
            create_startup_management_lease,
            release_startup_management_lease,
            execute_startup_management,
            get_cleanup_scan,
            get_cleanup_path_state,
            get_cleanup_subtree,
            load_persisted_cleanup_scan,
            clear_persisted_cleanup_scan,
            cancel_cleanup_scan,
            create_cleanup_delete_lease,
            release_cleanup_delete_lease,
            execute_cleanup_delete,
            complete_startup,
            show_main_window,
            get_process_detail,
            get_application_icon,
            create_process_control_lease,
            release_process_control_lease,
            execute_process_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running StatusOrbit");
}
