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

use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;

use application_icon::load_application_icon;
use cleanup::{
    CleanupDeleteController, CleanupDeleteCoordinator, CleanupScanCoordinator, cleanup_scan_access,
    inspect_cleanup_path, load_cleanup_scan_cache, open_full_disk_access_settings,
    remove_cleanup_scan_cache, reveal_cleanup_application_bundle, save_cleanup_scan_snapshot_cache,
    save_cleanup_scan_snapshot_cache_at, scan_cleanup, scan_cleanup_subtree,
};
use error::CommandError;
use models::{
    ApplicationIcon, CleanupDeleteExecutionRequest, CleanupDeleteLease,
    CleanupDeleteLeaseReleaseRequest, CleanupDeleteLeaseRequest, CleanupDeleteProgress,
    CleanupDeleteResult, CleanupPathState, CleanupScan, CleanupScanAccess, CleanupScanProgress,
    CleanupSubtreeRequest, NetworkConnectionsSnapshot, ProcessActionRequest, ProcessActionResult,
    ProcessControlLease, ProcessControlLeaseReleaseRequest, ProcessControlLeaseRequest,
    ProcessDetail, ProcessDetailRequest, StartupItemsSnapshot, StartupManagementExecutionRequest,
    StartupManagementLease, StartupManagementLeaseReleaseRequest, StartupManagementLeaseRequest,
    StartupManagementResult, SystemSnapshot,
};
use monitor::SystemMonitor;
use network_connections::sample_network_connections;
use process_control::ProcessController;
use startup::{StartupController, scan_startup_items};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WindowEvent,
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[derive(Clone)]
struct AppState {
    monitor: Arc<Mutex<SystemMonitor>>,
    process_controller: Arc<Mutex<ProcessController>>,
    cleanup_scan: Arc<CleanupScanCoordinator>,
    cleanup_delete: Arc<CleanupDeleteCoordinator>,
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
            cleanup_delete: Arc::new(CleanupDeleteCoordinator::default()),
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
        // Keep the on-disk location stable so a fresh scan replaces or clears
        // the previous schema instead of leaving an orphaned cache file.
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
async fn save_persisted_cleanup_scan(
    app: AppHandle,
    snapshot: CleanupScan,
) -> Result<(), CommandError> {
    let path = cleanup_scan_cache_path(&app)?;
    let saved_at_ms = snapshot.sampled_at_ms;
    tauri::async_runtime::spawn_blocking(move || {
        save_cleanup_scan_snapshot_cache_at(&path, &snapshot, saved_at_ms)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Cleanup cache update failed: {error}")))?
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
fn get_cleanup_scan_access() -> CleanupScanAccess {
    cleanup_scan_access()
}

#[tauri::command]
fn open_cleanup_full_disk_access_settings() -> Result<(), CommandError> {
    open_full_disk_access_settings()
}

#[tauri::command]
fn reveal_cleanup_app_bundle() -> Result<(), CommandError> {
    reveal_cleanup_application_bundle()
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
    on_progress: Channel<CleanupDeleteProgress>,
) -> Result<CleanupDeleteResult, CommandError> {
    let coordinator = Arc::clone(&state.cleanup_delete);
    let cancelled = coordinator.begin()?;
    let worker_cancelled = Arc::clone(&cancelled);
    let controller = Arc::clone(&state.cleanup_delete_controller);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut controller = controller
            .lock()
            .map_err(|_| CommandError::internal("The cleanup controller lock was poisoned."))?;
        controller.execute_cancellable(request, &worker_cancelled, &mut |progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await;
    coordinator.finish(&cancelled);
    result.map_err(|error| CommandError::internal(format!("Cleanup task failed: {error}")))?
}

#[tauri::command]
fn cancel_cleanup_delete(state: State<'_, AppState>) -> Result<bool, CommandError> {
    state.cleanup_delete.cancel()
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

#[tauri::command]
fn toggle_companion_window(app: AppHandle) {
    toggle_companion(&app);
}

const COMPANION_COLLAPSED_SIZE: (f64, f64) = (92.0, 92.0);
const COMPANION_EXPANDED_SIZE: (f64, f64) = (386.0, 92.0);
const COMPANION_EXIT_ANIMATION_MS: u64 = 300;
static COMPANION_TRANSITION_EPOCH: AtomicU64 = AtomicU64::new(0);
static COMPANION_EXIT_PENDING: AtomicBool = AtomicBool::new(false);

fn resize_companion(window: &tauri::WebviewWindow, expanded: bool) {
    let (width, height) = if expanded {
        COMPANION_EXPANDED_SIZE
    } else {
        COMPANION_COLLAPSED_SIZE
    };
    let position = window.outer_position().ok();
    let previous_size = window.outer_size().ok();
    let monitor = window.current_monitor().ok().flatten();
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let physical_width = (width * scale_factor).round() as i32;
    let physical_height = (height * scale_factor).round() as i32;

    let (Some(position), Some(previous_size), Some(monitor)) = (position, previous_size, monitor)
    else {
        let _ = window.set_size(LogicalSize::new(width, height));
        return;
    };
    let work_area = monitor.work_area();
    let min_x = work_area.position.x;
    let min_y = work_area.position.y;
    let max_x = min_x
        .saturating_add(work_area.size.width as i32)
        .saturating_sub(physical_width)
        .max(min_x);
    let max_y = min_y
        .saturating_add(work_area.size.height as i32)
        .saturating_sub(physical_height)
        .max(min_y);
    let anchor_bottom = position.y.saturating_add(previous_size.height as i32);
    // The mascot lives at the expanded window's bottom-left. Preserve that
    // screen-space anchor so showing a bubble never makes Orbit jump sideways.
    let x = if expanded {
        position.x.max(min_x)
    } else {
        position.x.clamp(min_x, max_x)
    };
    let y = anchor_bottom
        .saturating_sub(physical_height)
        .clamp(min_y, max_y);
    let target_position = PhysicalPosition::new(x, y);

    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(target_position);
}

fn collapse_companion(app: &AppHandle, window: &tauri::WebviewWindow) {
    resize_companion(window, false);
    let _ = app.emit_to("companion", "status-orbit:companion-collapse", ());
}

fn publish_companion_visibility(app: &AppHandle, window: &tauri::WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let _ = app.emit_to("main", "status-orbit:companion-visibility", visible);
}

fn show_companion(app: &AppHandle, window: &tauri::WebviewWindow) {
    COMPANION_TRANSITION_EPOCH.fetch_add(1, Ordering::SeqCst);
    let was_hiding = COMPANION_EXIT_PENDING.swap(false, Ordering::SeqCst);
    let was_visible = window.is_visible().unwrap_or(false);
    if !was_visible || was_hiding {
        collapse_companion(app, window);
    }
    if !was_visible {
        let _ = window.show();
    }
    if !was_visible || was_hiding {
        let _ = app.emit_to("companion", "status-orbit:companion-enter", ());
    }
    // Focus enables Escape and the companion context menu without forcing it open.
    let _ = window.set_focus();
    publish_companion_visibility(app, window);
}

fn hide_companion(app: &AppHandle, window: &tauri::WebviewWindow) {
    let transition = COMPANION_TRANSITION_EPOCH
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    if !window.is_visible().unwrap_or(false) {
        COMPANION_EXIT_PENDING.store(false, Ordering::SeqCst);
        publish_companion_visibility(app, window);
        return;
    }

    COMPANION_EXIT_PENDING.store(true, Ordering::SeqCst);
    collapse_companion(app, window);
    let _ = app.emit_to("companion", "status-orbit:companion-exit", ());
    let app = app.clone();
    let window = window.clone();
    std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(COMPANION_EXIT_ANIMATION_MS));
        if COMPANION_TRANSITION_EPOCH.load(Ordering::SeqCst) != transition {
            return;
        }
        let _ = window.hide();
        COMPANION_EXIT_PENDING.store(false, Ordering::SeqCst);
        publish_companion_visibility(&app, &window);
    }));
}

#[tauri::command]
fn set_companion_expanded(app: AppHandle, expanded: bool) {
    if let Some(window) = app.get_webview_window("companion") {
        resize_companion(&window, expanded);
    }
}

#[tauri::command]
fn hide_companion_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("companion") {
        hide_companion(&app, &window);
    }
}

#[tauri::command]
fn configure_companion_window(app: AppHandle, always_on_top: bool, show: bool) {
    let Some(window) = app.get_webview_window("companion") else {
        return;
    };
    let _ = window.set_always_on_top(always_on_top);
    if show {
        show_companion(&app, &window);
    } else {
        hide_companion(&app, &window);
    }
}

fn toggle_companion(app: &AppHandle) {
    let Some(window) = app.get_webview_window("companion") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        hide_companion(app, &window);
        return;
    }

    show_companion(app, &window);
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
            let companion =
                MenuItem::with_id(app, "companion", "Orbit Companion", true, None::<&str>)?;
            let cleanup = MenuItem::with_id(app, "cleanup", "Space Cleanup", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit StatusOrbit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &companion, &cleanup, &quit])?;
            let mut tray = TrayIconBuilder::with_id("status-orbit-status")
                .tooltip("StatusOrbit · Local Monitor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "companion" => toggle_companion(app),
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
            save_persisted_cleanup_scan,
            clear_persisted_cleanup_scan,
            cancel_cleanup_scan,
            get_cleanup_scan_access,
            open_cleanup_full_disk_access_settings,
            reveal_cleanup_app_bundle,
            create_cleanup_delete_lease,
            release_cleanup_delete_lease,
            execute_cleanup_delete,
            cancel_cleanup_delete,
            complete_startup,
            show_main_window,
            toggle_companion_window,
            hide_companion_window,
            set_companion_expanded,
            configure_companion_window,
            get_process_detail,
            get_application_icon,
            create_process_control_lease,
            release_process_control_lease,
            execute_process_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running StatusOrbit");
}
