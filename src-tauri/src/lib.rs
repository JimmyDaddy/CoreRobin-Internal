mod application_icon;
mod cleanup;
#[cfg(test)]
mod command_names;
mod error;
mod health_state;
mod identity;
mod models;
mod monitor;
mod network_connections;
mod private_storage;
mod process_control;
mod safe_fs;
mod sensors;
mod startup;

pub use cleanup::{
    CleanupBenchmarkResult, benchmark_cleanup_root, benchmark_cleanup_root_with_cancel,
};

use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use application_icon::load_application_icon;
use cleanup::{
    CleanupDeleteController, CleanupDeleteCoordinator, CleanupWorkCoordinator,
    canonical_cleanup_subtree_path, cleanup_scan_access, inspect_cleanup_path,
    load_cleanup_scan_cache, open_full_disk_access_settings, remove_cleanup_scan_cache,
    reveal_cleanup_application_bundle, save_cleanup_scan_snapshot_cache,
    save_cleanup_scan_snapshot_cache_at, scan_cleanup, scan_cleanup_subtree,
};
use error::CommandError;
use health_state::{HEALTH_STATE_EVENT, HealthStateSnapshot, HealthStateStore, HealthStateUpdate};
use models::{
    ApplicationIcon, CleanupDeleteExecutionRequest, CleanupDeleteLease,
    CleanupDeleteLeaseReleaseRequest, CleanupDeleteLeaseRequest, CleanupDeleteProgress,
    CleanupDeleteResult, CleanupPathState, CleanupScan, CleanupScanAccess, CleanupScanProgress,
    CleanupSubtreeRequest, NetworkConnectionsSnapshot, ProcessActionRequest, ProcessActionResult,
    ProcessControlLease, ProcessControlLeaseReleaseRequest, ProcessControlLeaseRequest,
    ProcessDetail, ProcessDetailRequest, StartupItemsSnapshot, StartupManagementExecutionRequest,
    StartupManagementLease, StartupManagementLeaseReleaseRequest, StartupManagementLeaseRequest,
    StartupManagementResult, SystemSnapshot, SystemSummary,
};
use monitor::SystemMonitor;
use network_connections::sample_network_connections;
#[cfg(target_os = "macos")]
use objc2::runtime::NSObjectProtocol;
#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, sel};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSApplication, NSEvent, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use process_control::ProcessController;
use startup::{StartupController, scan_startup_items};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, State,
    WebviewWindow, WindowEvent,
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(target_os = "macos")]
use tauri_nspanel::{ManagerExt as PanelManagerExt, WebviewWindowExt as PanelWindowExt};
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

#[cfg(target_os = "macos")]
mod tray_panel_native {
    use tauri::Manager;

    tauri_nspanel::tauri_panel! {
        panel!(StatusOrbitTrayPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false
            }
        })
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorBenchmarkResult {
    pub iterations: usize,
    pub spacing_milliseconds: u64,
    pub process_count: usize,
    pub full_snapshot: MonitorTimingStats,
    pub light_summary: MonitorTimingStats,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorTimingStats {
    pub median_microseconds: u64,
    pub p95_microseconds: u64,
    pub maximum_microseconds: u64,
}

pub fn benchmark_monitor_sampling(
    iterations: usize,
    spacing_milliseconds: u64,
) -> Result<MonitorBenchmarkResult, String> {
    if iterations == 0 {
        return Err("Monitor benchmark iterations must be greater than zero.".to_owned());
    }

    let process_controller = ProcessController::new();
    let mut monitor = SystemMonitor::new(process_controller.capabilities());
    let process_count = monitor.sample().processes.len();
    let spacing = Duration::from_millis(spacing_milliseconds);
    let full_snapshot = benchmark_monitor_operation(iterations, spacing, || {
        let _ = monitor.sample();
    });
    let light_summary = benchmark_monitor_operation(iterations, spacing, || {
        let _ = monitor.sample_summary();
    });

    Ok(MonitorBenchmarkResult {
        iterations,
        spacing_milliseconds,
        process_count,
        full_snapshot,
        light_summary,
    })
}

fn benchmark_monitor_operation<F>(
    iterations: usize,
    spacing: Duration,
    mut operation: F,
) -> MonitorTimingStats
where
    F: FnMut(),
{
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        std::thread::sleep(spacing);
        let started_at = Instant::now();
        operation();
        samples.push(started_at.elapsed().as_micros().min(u64::MAX as u128) as u64);
    }
    samples.sort_unstable();
    let p95_index = ((samples.len() * 95).div_ceil(100)).saturating_sub(1);
    MonitorTimingStats {
        median_microseconds: samples[samples.len() / 2],
        p95_microseconds: samples[p95_index],
        maximum_microseconds: *samples.last().unwrap_or(&0),
    }
}

fn require_main_window_label(label: &str) -> Result<(), CommandError> {
    if label == "main" {
        Ok(())
    } else {
        Err(CommandError::new(
            "window_not_authorized",
            "This operation is only available from the main StatusOrbit window.",
        ))
    }
}

fn require_main_window(window: &WebviewWindow) -> Result<(), CommandError> {
    require_main_window_label(window.label())
}

#[derive(Clone)]
struct AppState {
    background_launch: bool,
    monitor: Arc<Mutex<SystemMonitor>>,
    health_state: Arc<HealthStateStore>,
    process_controller: Arc<Mutex<ProcessController>>,
    cleanup_scan: Arc<CleanupWorkCoordinator>,
    cleanup_delete: Arc<CleanupDeleteCoordinator>,
    cleanup_delete_controller: Arc<Mutex<CleanupDeleteController>>,
    startup_controller: Arc<Mutex<StartupController>>,
}

impl AppState {
    fn new(background_launch: bool) -> Self {
        let process_controller = ProcessController::new();
        let process_control_capabilities = process_controller.capabilities();
        let process_controller = Arc::new(Mutex::new(process_controller));
        start_lease_reaper(Arc::downgrade(&process_controller));
        Self {
            background_launch,
            monitor: Arc::new(Mutex::new(SystemMonitor::new(process_control_capabilities))),
            health_state: Arc::new(HealthStateStore::default()),
            process_controller,
            cleanup_scan: Arc::new(CleanupWorkCoordinator::default()),
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
async fn get_system_summary(state: State<'_, AppState>) -> Result<SystemSummary, CommandError> {
    with_monitor(Arc::clone(&state.monitor), |monitor| {
        Ok(monitor.sample_summary())
    })
    .await
}

#[tauri::command]
fn publish_health_state(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    update: HealthStateUpdate,
) -> Result<HealthStateSnapshot, CommandError> {
    require_main_window(&window)?;
    let snapshot = state.health_state.publish(update)?;
    app.emit(HEALTH_STATE_EVENT, &snapshot).map_err(|error| {
        CommandError::internal(format!("Health state broadcast failed: {error}"))
    })?;
    Ok(snapshot)
}

#[tauri::command]
fn get_health_state(
    state: State<'_, AppState>,
) -> Result<Option<HealthStateSnapshot>, CommandError> {
    state.health_state.current()
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
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: StartupManagementLeaseRequest,
) -> Result<StartupManagementLease, CommandError> {
    require_main_window(&window)?;
    with_startup_controller(Arc::clone(&state.startup_controller), move |controller| {
        controller.create_lease(request)
    })
    .await
}

#[tauri::command]
async fn release_startup_management_lease(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: StartupManagementLeaseReleaseRequest,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    with_startup_controller(Arc::clone(&state.startup_controller), move |controller| {
        controller.release_lease(&request.lease_id);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn execute_startup_management(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: StartupManagementExecutionRequest,
) -> Result<StartupManagementResult, CommandError> {
    require_main_window(&window)?;
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
    let cancelled = coordinator.begin_full_scan()?;
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_coordinator = Arc::clone(&coordinator);
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker_coordinator.run_exclusive(&worker_cancelled, || {
            let scan = scan_cleanup(&worker_cancelled, &mut |progress| {
                let _ = on_progress.send(progress);
            })?;
            let _ = save_cleanup_scan_snapshot_cache(&cache_path, &scan);
            Ok::<_, CommandError>(scan)
        })
    })
    .await;
    coordinator.finish_full_scan(&cancelled);
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
    state: State<'_, AppState>,
    request: CleanupSubtreeRequest,
) -> Result<models::CleanupNode, CommandError> {
    let canonical_path = canonical_cleanup_subtree_path(&request.path)?;
    let coordinator = Arc::clone(&state.cleanup_scan);
    let cancelled = coordinator.begin_subtree(request.request_id.clone(), canonical_path)?;
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_coordinator = Arc::clone(&coordinator);
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker_coordinator.run_exclusive(&worker_cancelled, || {
            scan_cleanup_subtree(request, &worker_cancelled)
        })
    })
    .await;
    coordinator.finish_subtree(&cancelled);
    result
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
    state.cleanup_scan.cancel_full_scan()
}

#[tauri::command]
fn cancel_cleanup_subtree(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<bool, CommandError> {
    state.cleanup_scan.cancel_subtree(&request_id)
}

#[tauri::command]
fn get_cleanup_scan_access() -> CleanupScanAccess {
    cleanup_scan_access()
}

#[tauri::command]
fn open_cleanup_full_disk_access_settings(window: WebviewWindow) -> Result<(), CommandError> {
    require_main_window(&window)?;
    open_full_disk_access_settings()
}

#[tauri::command]
fn reveal_cleanup_app_bundle(window: WebviewWindow) -> Result<(), CommandError> {
    require_main_window(&window)?;
    reveal_cleanup_application_bundle()
}

#[tauri::command]
async fn create_cleanup_delete_lease(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CleanupDeleteLeaseRequest,
) -> Result<CleanupDeleteLease, CommandError> {
    require_main_window(&window)?;
    with_cleanup_delete_controller(
        Arc::clone(&state.cleanup_delete_controller),
        move |controller| controller.create_lease(request),
    )
    .await
}

#[tauri::command]
async fn release_cleanup_delete_lease(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CleanupDeleteLeaseReleaseRequest,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
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
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CleanupDeleteExecutionRequest,
    on_progress: Channel<CleanupDeleteProgress>,
) -> Result<CleanupDeleteResult, CommandError> {
    require_main_window(&window)?;
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
fn cancel_cleanup_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    require_main_window(&window)?;
    state.cleanup_delete.cancel()
}

#[tauri::command]
fn complete_startup(app: AppHandle) {
    finish_startup(&app);
}

fn finish_startup(app: &AppHandle) {
    if !app.state::<AppState>().background_launch {
        show_main(app);
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn set_dock_icon_visible(
    window: WebviewWindow,
    app: AppHandle,
    visible: bool,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        };
        app.set_activation_policy(policy).map_err(|error| {
            CommandError::new(
                "dock_visibility_failed",
                format!("Could not update the macOS Dock visibility: {error}"),
            )
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
    Ok(())
}

#[tauri::command]
fn get_launch_at_login(window: WebviewWindow, app: AppHandle) -> Result<bool, CommandError> {
    require_main_window(&window)?;
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        app.autolaunch().is_enabled().map_err(|error| {
            CommandError::new(
                "autostart_status_failed",
                format!("Could not read the login startup status: {error}"),
            )
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
fn set_launch_at_login(
    window: WebviewWindow,
    app: AppHandle,
    enabled: bool,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        let manager = app.autolaunch();
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|error| {
            CommandError::new(
                "autostart_update_failed",
                format!("Could not update the login startup status: {error}"),
            )
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            let main_window = window.clone();
            if app
                .run_on_main_thread(move || reveal_main_window(&main_window))
                .is_err()
            {
                reveal_main_window(&window);
            }
        }
        #[cfg(not(target_os = "macos"))]
        reveal_main_window(&window);
        let _ = app.emit_to("main", "status-orbit:main-visibility", true);
    }
}

fn reveal_main_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    #[cfg(target_os = "macos")]
    if let Some(mtm) = MainThreadMarker::new() {
        if let Ok(ns_window) = window.ns_window()
            && let Some(ns_window) = unsafe { ns_window.cast::<NSWindow>().as_ref() }
        {
            ns_window.makeKeyAndOrderFront(None);
        }
        let application = NSApplication::sharedApplication(mtm);
        if application.respondsToSelector(sel!(activate)) {
            application.activate();
        } else {
            #[allow(deprecated)]
            application.activateIgnoringOtherApps(true);
        }
    }
    let _ = window.set_focus();
}

fn navigate_main(app: &AppHandle, view: &str) {
    show_main(app);
    let _ = app.emit_to("main", "status-orbit:navigate", view);
}

const TRAY_PANEL_GAP_LOGICAL: f64 = 4.0;
const TRAY_PANEL_SCREEN_MARGIN_LOGICAL: f64 = 6.0;
const TRAY_DOUBLE_CLICK_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq, Eq)]
enum TrayLeftClickAction {
    TogglePanel,
    OpenMain,
    Ignore,
}

#[derive(Default)]
struct TrayLeftClickTracker {
    last_click_up: Option<Instant>,
    suppress_click_up_until: Option<Instant>,
}

impl TrayLeftClickTracker {
    fn register_click_up(&mut self, clicked_at: Instant) -> TrayLeftClickAction {
        if self
            .suppress_click_up_until
            .is_some_and(|deadline| clicked_at <= deadline)
        {
            self.suppress_click_up_until = None;
            self.last_click_up = None;
            return TrayLeftClickAction::Ignore;
        }
        self.suppress_click_up_until = None;

        if self.last_click_up.is_some_and(|previous| {
            clicked_at.saturating_duration_since(previous) <= TRAY_DOUBLE_CLICK_INTERVAL
        }) {
            self.last_click_up = None;
            TrayLeftClickAction::OpenMain
        } else {
            self.last_click_up = Some(clicked_at);
            TrayLeftClickAction::TogglePanel
        }
    }

    fn register_native_double_click(&mut self, clicked_at: Instant) {
        self.last_click_up = None;
        self.suppress_click_up_until = Some(clicked_at + TRAY_DOUBLE_CLICK_INTERVAL);
    }
}

fn open_main_from_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("tray") {
        let _ = window.hide();
    }
    show_main(app);
}

fn toggle_tray_panel(app: &AppHandle, tray_rect: Rect) {
    let Some(window) = app.get_webview_window("tray") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        #[cfg(target_os = "macos")]
        if let Ok(panel) = app.get_webview_panel("tray") {
            panel.hide();
            return;
        }
        let _ = window.hide();
        return;
    }

    position_tray_panel(&window, tray_rect);
    #[cfg(target_os = "macos")]
    if let Ok(panel) = app.get_webview_panel("tray") {
        panel.show_and_make_key();
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn position_tray_panel(window: &tauri::WebviewWindow, tray_rect: Rect) {
    #[cfg(target_os = "macos")]
    if position_tray_panel_on_cursor_screen(window) {
        return;
    }

    let Ok(panel_size) = window.outer_size() else {
        return;
    };
    let anchor_position = tray_rect.position.to_physical::<i32>(1.0);
    let anchor_size = tray_rect.size.to_physical::<u32>(1.0);
    let anchor_center_x = f64::from(anchor_position.x) + f64::from(anchor_size.width) / 2.0;
    let anchor_center_y = f64::from(anchor_position.y) + f64::from(anchor_size.height) / 2.0;
    let monitor = window
        .monitor_from_point(anchor_center_x, anchor_center_y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let gap = (TRAY_PANEL_GAP_LOGICAL * scale_factor).round() as i32;
    let margin = (TRAY_PANEL_SCREEN_MARGIN_LOGICAL * scale_factor).round() as i32;
    let position = calculate_tray_panel_position(
        anchor_position,
        anchor_size,
        panel_size,
        work_area.position,
        work_area.size,
        gap,
        margin,
    );
    let _ = window.set_position(position);
}

#[cfg(target_os = "macos")]
fn position_tray_panel_on_cursor_screen(window: &tauri::WebviewWindow) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let cursor = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    let Some(screen) = screens.iter().find(|screen| {
        let frame = screen.frame();
        cursor.x >= frame.origin.x
            && cursor.x < frame.origin.x + frame.size.width
            && cursor.y >= frame.origin.y
            && cursor.y < frame.origin.y + frame.size.height
    }) else {
        return false;
    };
    let Ok(ns_window) = window.ns_window() else {
        return false;
    };
    let Some(ns_window) = (unsafe { ns_window.cast::<NSWindow>().as_ref() }) else {
        return false;
    };
    let mut collection_behavior = ns_window.collectionBehavior();
    collection_behavior.remove(NSWindowCollectionBehavior::MoveToActiveSpace);
    collection_behavior.insert(NSWindowCollectionBehavior::CanJoinAllSpaces);
    collection_behavior.insert(NSWindowCollectionBehavior::Transient);
    collection_behavior.insert(NSWindowCollectionBehavior::FullScreenAuxiliary);
    ns_window.setCollectionBehavior(collection_behavior);
    let panel_frame = ns_window.frame();
    let work_area = screen.visibleFrame();
    let (x, y) = calculate_tray_panel_origin_on_screen(
        cursor.x,
        panel_frame.size.width,
        panel_frame.size.height,
        work_area.origin.x,
        work_area.origin.y,
        work_area.size.width,
        work_area.size.height,
        TRAY_PANEL_GAP_LOGICAL,
        TRAY_PANEL_SCREEN_MARGIN_LOGICAL,
    );
    let mut origin = panel_frame.origin;
    origin.x = x;
    origin.y = y;
    ns_window.setFrameOrigin(origin);
    true
}

#[allow(clippy::too_many_arguments)]
fn calculate_tray_panel_origin_on_screen(
    anchor_x: f64,
    panel_width: f64,
    panel_height: f64,
    work_area_x: f64,
    work_area_y: f64,
    work_area_width: f64,
    work_area_height: f64,
    gap: f64,
    margin: f64,
) -> (f64, f64) {
    let min_x = work_area_x + margin;
    let max_x = (work_area_x + work_area_width - panel_width - margin).max(min_x);
    let x = (anchor_x - panel_width / 2.0).clamp(min_x, max_x);
    let min_y = work_area_y + margin;
    let y = (work_area_y + work_area_height - panel_height - gap).max(min_y);
    (x, y)
}

fn calculate_tray_panel_position(
    anchor_position: PhysicalPosition<i32>,
    anchor_size: PhysicalSize<u32>,
    panel_size: PhysicalSize<u32>,
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    gap: i32,
    margin: i32,
) -> PhysicalPosition<i32> {
    let anchor_width = anchor_size.width as i32;
    let anchor_height = anchor_size.height as i32;
    let panel_width = panel_size.width as i32;
    let panel_height = panel_size.height as i32;
    let work_width = work_area_size.width as i32;
    let work_height = work_area_size.height as i32;
    let desired_x = anchor_position
        .x
        .saturating_add(anchor_width / 2)
        .saturating_sub(panel_width / 2);
    let desired_y = anchor_position
        .y
        .saturating_add(anchor_height)
        .saturating_add(gap);
    let min_x = work_area_position.x.saturating_add(margin);
    let min_y = work_area_position.y.saturating_add(gap);
    let max_x = work_area_position
        .x
        .saturating_add(work_width)
        .saturating_sub(panel_width)
        .saturating_sub(margin)
        .max(min_x);
    let max_y = work_area_position
        .y
        .saturating_add(work_height)
        .saturating_sub(panel_height)
        .saturating_sub(margin)
        .max(min_y);

    PhysicalPosition::new(desired_x.clamp(min_x, max_x), desired_y.clamp(min_y, max_y))
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
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProcessControlLeaseRequest,
) -> Result<ProcessControlLease, CommandError> {
    require_main_window(&window)?;
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.create_lease(request)
    })
    .await
}

#[tauri::command]
async fn release_process_control_lease(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProcessControlLeaseReleaseRequest,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.release_lease(request);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn execute_process_action(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProcessActionRequest,
) -> Result<ProcessActionResult, CommandError> {
    require_main_window(&window)?;
    with_process_controller(Arc::clone(&state.process_controller), move |controller| {
        controller.execute_action(request)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let background_launch = std::env::args_os().any(|argument| argument == "--background");
    let builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["--background"]),
    ));
    builder
        .manage(AppState::new(background_launch))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.handle()
                    .set_activation_policy(ActivationPolicy::Accessory)?;
                if let Some(tray_window) = app.get_webview_window("tray") {
                    let panel =
                        tray_window.to_panel::<tray_panel_native::StatusOrbitTrayPanel>()?;
                    panel.set_collection_behavior(
                        NSWindowCollectionBehavior::CanJoinAllSpaces
                            | NSWindowCollectionBehavior::Transient
                            | NSWindowCollectionBehavior::FullScreenAuxiliary
                            | NSWindowCollectionBehavior::IgnoresCycle,
                    );
                    panel.set_style_mask(
                        panel.as_panel().styleMask() | NSWindowStyleMask::NonactivatingPanel,
                    );
                    panel.set_floating_panel(true);
                    panel.set_hides_on_deactivate(false);
                    panel.set_released_when_closed(false);
                }
            }
            if app.state::<AppState>().background_launch
                && let Some(splash) = app.get_webview_window("splashscreen")
            {
                let _ = splash.close();
            }
            let open = MenuItem::with_id(app, "open", "Open StatusOrbit", true, None::<&str>)?;
            let companion =
                MenuItem::with_id(app, "companion", "Orbit Companion", true, None::<&str>)?;
            let cleanup = MenuItem::with_id(app, "cleanup", "Space Cleanup", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit StatusOrbit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &companion, &cleanup, &quit])?;
            let tray_left_click_tracker = Arc::new(Mutex::new(TrayLeftClickTracker::default()));
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
                .on_tray_icon_event(move |tray, event| match event {
                    TrayIconEvent::Click {
                        rect,
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        let action = tray_left_click_tracker
                            .lock()
                            .map(|mut tracker| tracker.register_click_up(Instant::now()))
                            .unwrap_or(TrayLeftClickAction::TogglePanel);
                        match action {
                            TrayLeftClickAction::TogglePanel => {
                                toggle_tray_panel(tray.app_handle(), rect);
                            }
                            TrayLeftClickAction::OpenMain => {
                                open_main_from_tray(tray.app_handle());
                            }
                            TrayLeftClickAction::Ignore => {}
                        }
                    }
                    TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        if let Ok(mut tracker) = tray_left_click_tracker.lock() {
                            tracker.register_native_double_click(Instant::now());
                        }
                        open_main_from_tray(tray.app_handle());
                    }
                    _ => {}
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
                        finish_startup(&handle);
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
                let _ = window
                    .app_handle()
                    .emit_to("main", "status-orbit:main-visibility", false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_snapshot,
            get_system_summary,
            publish_health_state,
            get_health_state,
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
            cancel_cleanup_subtree,
            get_cleanup_scan_access,
            open_cleanup_full_disk_access_settings,
            reveal_cleanup_app_bundle,
            create_cleanup_delete_lease,
            release_cleanup_delete_lease,
            execute_cleanup_delete,
            cancel_cleanup_delete,
            complete_startup,
            show_main_window,
            set_dock_icon_visible,
            get_launch_at_login,
            set_launch_at_login,
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

#[cfg(test)]
mod tray_panel_position_tests {
    use std::time::{Duration, Instant};

    use super::{
        TRAY_DOUBLE_CLICK_INTERVAL, TrayLeftClickAction, TrayLeftClickTracker,
        calculate_tray_panel_origin_on_screen, calculate_tray_panel_position,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn centers_the_panel_below_the_tray_icon() {
        let position = calculate_tray_panel_position(
            PhysicalPosition::new(760, 0),
            PhysicalSize::new(44, 48),
            PhysicalSize::new(720, 880),
            PhysicalPosition::new(0, 48),
            PhysicalSize::new(3000, 1952),
            8,
            12,
        );

        assert_eq!(position, PhysicalPosition::new(422, 56));
    }

    #[test]
    fn keeps_the_panel_inside_the_monitor_work_area() {
        let position = calculate_tray_panel_position(
            PhysicalPosition::new(12, 0),
            PhysicalSize::new(40, 48),
            PhysicalSize::new(720, 880),
            PhysicalPosition::new(0, 48),
            PhysicalSize::new(3000, 1952),
            8,
            12,
        );

        assert_eq!(position, PhysicalPosition::new(12, 56));
    }

    #[test]
    fn positions_the_panel_in_the_secondary_screen_coordinate_space() {
        let origin = calculate_tray_panel_origin_on_screen(
            2_500.0, 360.0, 440.0, 1_920.0, 0.0, 1_600.0, 900.0, 4.0, 6.0,
        );

        assert_eq!(origin, (2_320.0, 456.0));
    }

    #[test]
    fn clamps_the_panel_to_the_clicked_screens_visible_area() {
        let origin = calculate_tray_panel_origin_on_screen(
            3_510.0, 360.0, 440.0, 1_920.0, 0.0, 1_600.0, 900.0, 4.0, 6.0,
        );

        assert_eq!(origin, (3_154.0, 456.0));
    }

    #[test]
    fn opens_main_when_two_left_clicks_arrive_within_the_double_click_interval() {
        let started_at = Instant::now();
        let mut tracker = TrayLeftClickTracker::default();

        assert_eq!(
            tracker.register_click_up(started_at),
            TrayLeftClickAction::TogglePanel
        );
        assert_eq!(
            tracker.register_click_up(started_at + TRAY_DOUBLE_CLICK_INTERVAL),
            TrayLeftClickAction::OpenMain
        );
    }

    #[test]
    fn treats_slow_left_clicks_as_independent_panel_toggles() {
        let started_at = Instant::now();
        let mut tracker = TrayLeftClickTracker::default();

        assert_eq!(
            tracker.register_click_up(started_at),
            TrayLeftClickAction::TogglePanel
        );
        assert_eq!(
            tracker.register_click_up(
                started_at + TRAY_DOUBLE_CLICK_INTERVAL + Duration::from_millis(1)
            ),
            TrayLeftClickAction::TogglePanel
        );
    }

    #[test]
    fn ignores_the_click_up_that_follows_a_native_double_click_event() {
        let started_at = Instant::now();
        let mut tracker = TrayLeftClickTracker::default();
        tracker.register_native_double_click(started_at);

        assert_eq!(
            tracker.register_click_up(started_at + Duration::from_millis(20)),
            TrayLeftClickAction::Ignore
        );
    }
}

#[cfg(test)]
mod security_boundary_tests {
    use std::collections::BTreeSet;

    use serde_json::Value;

    use super::{command_names::ALL_COMMANDS, require_main_window_label};

    const PROTECTED_COMMANDS: &[&str] = &[
        "create_startup_management_lease",
        "release_startup_management_lease",
        "execute_startup_management",
        "open_cleanup_full_disk_access_settings",
        "reveal_cleanup_app_bundle",
        "create_cleanup_delete_lease",
        "release_cleanup_delete_lease",
        "execute_cleanup_delete",
        "cancel_cleanup_delete",
        "publish_health_state",
        "set_dock_icon_visible",
        "get_launch_at_login",
        "set_launch_at_login",
        "create_process_control_lease",
        "release_process_control_lease",
        "execute_process_action",
    ];

    fn capability(source: &str) -> Value {
        serde_json::from_str(source).expect("capability JSON must be valid")
    }

    fn string_set(value: &Value, field: &str) -> BTreeSet<String> {
        value[field]
            .as_array()
            .expect("capability field must be an array")
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .expect("capability array entries must be strings")
                    .to_owned()
            })
            .collect()
    }

    fn allow_permission(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    #[test]
    fn build_manifest_command_list_matches_the_invoke_handler() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("tauri::generate_handler![")
            .expect("invoke handler must exist")
            .1
            .split_once("])")
            .expect("invoke handler must be terminated")
            .0;
        let registered = handler
            .split(',')
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .collect::<BTreeSet<_>>();
        let declared = ALL_COMMANDS.iter().copied().collect::<BTreeSet<_>>();

        assert_eq!(registered, declared);
    }

    #[test]
    fn generated_application_acl_is_not_empty() {
        let manifests: Value =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json"))
                .expect("generated ACL manifest JSON must be valid");
        let application = manifests
            .get("__app-acl__")
            .expect("the application ACL manifest must be generated");
        assert!(
            application["permissions"]
                .as_object()
                .is_some_and(|permissions| !permissions.is_empty()),
            "the application ACL manifest must declare command permissions"
        );
    }

    #[test]
    fn capabilities_keep_protected_commands_on_the_main_window() {
        let main = capability(include_str!("../capabilities/default.json"));
        let tray = capability(include_str!("../capabilities/auxiliary-windows.json"));
        let companion = capability(include_str!("../capabilities/companion-position.json"));
        let main_permissions = string_set(&main, "permissions");
        let tray_permissions = string_set(&tray, "permissions");
        let companion_permissions = string_set(&companion, "permissions");

        assert_eq!(
            string_set(&main, "windows"),
            BTreeSet::from(["main".to_owned()])
        );
        assert_eq!(
            string_set(&tray, "windows"),
            BTreeSet::from(["tray".to_owned()])
        );
        assert_eq!(
            string_set(&companion, "windows"),
            BTreeSet::from(["companion".to_owned()])
        );
        assert!(!string_set(&main, "windows").contains("splashscreen"));

        for command in ALL_COMMANDS {
            assert!(
                main_permissions.contains(&allow_permission(command)),
                "main is missing permission for {command}"
            );
        }
        for command in PROTECTED_COMMANDS {
            let permission = allow_permission(command);
            assert!(!tray_permissions.contains(&permission));
            assert!(!companion_permissions.contains(&permission));
        }
        assert!(!tray_permissions.contains("core:default"));
        assert!(!companion_permissions.contains("core:default"));
    }

    #[test]
    fn protected_handler_guard_rejects_every_auxiliary_window() {
        assert!(require_main_window_label("main").is_ok());
        for label in ["tray", "companion", "splashscreen", "unexpected"] {
            let error = require_main_window_label(label).expect_err("window must be rejected");
            assert_eq!(error.code, "window_not_authorized");
        }
    }
}
