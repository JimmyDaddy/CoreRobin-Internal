mod application_history;
mod application_icon;
mod application_metadata;
mod bounded_command;
mod cleanup;
#[cfg(test)]
mod command_names;
mod error;
mod file_insights;
mod file_ownership;
mod gpu_energy;
mod health_state;
mod history_storage;
mod identity;
mod models;
mod monitor;
mod native_uninstall;
mod network_connections;
mod network_quality;
mod private_storage;
mod process_control;
mod safe_fs;
mod sampler_service;
mod sensors;
mod startup;
mod storage_health;
mod user_actions;

pub use cleanup::{
    CleanupBenchmarkResult, benchmark_cleanup_root, benchmark_cleanup_root_with_cancel,
};

use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use application_history::{
    APPLICATION_HISTORY_FILE_NAME, ApplicationHistoryStorage, load as load_application_history,
    remove as remove_application_history, save as save_application_history,
};
use application_icon::{load_application_bundle_icon, load_application_icon};
use cleanup::{
    CleanupDeleteController, CleanupDeleteCoordinator, CleanupWorkCoordinator,
    available_bytes_for_path, canonical_cleanup_subtree_path, cleanup_scan_access,
    inspect_cleanup_path, load_cleanup_scan_cache, load_or_scan_application_inventory,
    open_full_disk_access_settings, prepare_application_uninstall,
    prepare_trashed_application_residual_plan, remove_cleanup_scan_cache,
    reveal_cleanup_application_bundle, save_cleanup_scan_snapshot_cache,
    save_cleanup_scan_snapshot_cache_at, scan_cleanup, scan_cleanup_subtree,
    scan_trashed_applications,
};
use error::CommandError;
use file_insights::{
    FileInsightsCoordinator, load_file_insights_cache, remove_file_insights_cache,
    revalidate_file_insights_snapshot, save_file_insights_snapshot_cache,
    scan_file_insights as perform_file_insights_scan,
};
use gpu_energy::sample_gpu_energy;
use health_state::{HEALTH_STATE_EVENT, HealthStateSnapshot, HealthStateStore, HealthStateUpdate};
use history_storage::{
    HistoryCategory, HistorySegmentStorage, HistoryStorageSummary,
    clear_all as clear_all_history_segments, load as load_history_segment,
    save as save_history_segment, summary as history_storage_summary,
};
use models::{
    ApplicationIcon, ApplicationIconRequest, ApplicationInventorySnapshot,
    ApplicationUninstallPlan, CleanupDeleteExecutionRequest, CleanupDeleteLease,
    CleanupDeleteLeaseModeRequest, CleanupDeleteLeaseReleaseRequest, CleanupDeleteLeaseRequest,
    CleanupDeleteProgress, CleanupDeleteResult, CleanupPathState, CleanupScan, CleanupScanAccess,
    CleanupScanProgress, CleanupScanRequest, CleanupSubtreeRequest, FileInsightsProgress,
    FileInsightsScan, GpuEnergySnapshot, NativeApplicationUninstallExecutionRequest,
    NativeApplicationUninstallResult, NetworkConnectionsSnapshot, NetworkHostLookup,
    NetworkHostLookupRequest, NetworkQualityResult, ProcessActionRequest, ProcessActionResult,
    ProcessControlLease, ProcessControlLeaseReleaseRequest, ProcessControlLeaseRequest,
    ProcessDetail, ProcessDetailRequest, StartupContext, StartupItemsSnapshot,
    StartupManagementExecutionRequest, StartupManagementLease,
    StartupManagementLeaseReleaseRequest, StartupManagementLeaseRequest, StartupManagementResult,
    SystemSnapshot, SystemSummary, TrashedApplication,
};
use monitor::SystemMonitor;
use network_connections::sample_network_connections;
use network_quality::{
    resolve_network_hosts as resolve_hosts, run_network_quality_check as check_network_quality,
};
#[cfg(target_os = "macos")]
use objc2::runtime::NSObjectProtocol;
#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, sel};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSApplication, NSEvent, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use process_control::ProcessController;
use sampler_service::{SamplerControl, SamplerService, SamplerStatus};
use startup::{StartupController, scan_startup_items};
use storage_health::{StorageHealthSnapshot, inspect_storage_health, validate_mount_points};
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
use user_actions::{ProductLanguage, ProductPage, SystemSettingsDestination};

#[cfg(target_os = "macos")]
mod tray_panel_native {
    use tauri::Manager;

    tauri_nspanel::tauri_panel! {
        panel!(CoreRobinTrayPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false
            }
        })
        panel!(CoreRobinCompanionPanel {
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

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductDataCacheItemSummary {
    byte_size: u64,
    file_count: u64,
    updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductDataCacheSummary {
    cleanup_scan: ProductDataCacheItemSummary,
    file_insights: ProductDataCacheItemSummary,
    application_inventory: ProductDataCacheItemSummary,
    application_history: ProductDataCacheItemSummary,
    history_segments: ProductDataCacheItemSummary,
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
            "This operation is only available from the main CoreRobin window.",
        ))
    }
}

fn require_main_window(window: &WebviewWindow) -> Result<(), CommandError> {
    require_main_window_label(window.label())
}

fn require_tray_window_label(label: &str) -> Result<(), CommandError> {
    if label == "tray" {
        Ok(())
    } else {
        Err(CommandError::new(
            "window_not_authorized",
            "This operation is only available from the CoreRobin tray panel.",
        ))
    }
}

fn require_tray_window(window: &WebviewWindow) -> Result<(), CommandError> {
    require_tray_window_label(window.label())
}

#[derive(Clone)]
struct AppState {
    background_launch: bool,
    launched_at_ms: u64,
    monitor: Arc<Mutex<SystemMonitor>>,
    sampler: Arc<SamplerService>,
    health_state: Arc<HealthStateStore>,
    process_controller: Arc<Mutex<ProcessController>>,
    cleanup_scan: Arc<CleanupWorkCoordinator>,
    cleanup_delete: Arc<CleanupDeleteCoordinator>,
    cleanup_delete_controller: Arc<Mutex<CleanupDeleteController>>,
    file_insights: Arc<FileInsightsCoordinator>,
    startup_controller: Arc<Mutex<StartupController>>,
}

impl AppState {
    fn new(background_launch: bool) -> Self {
        let process_controller = ProcessController::new();
        let process_control_capabilities = process_controller.capabilities();
        let process_controller = Arc::new(Mutex::new(process_controller));
        start_lease_reaper(Arc::downgrade(&process_controller));
        let monitor = Arc::new(Mutex::new(SystemMonitor::new(process_control_capabilities)));
        let sampler = Arc::new(SamplerService::new(Arc::clone(&monitor)));
        Self {
            background_launch,
            launched_at_ms: now_millis(),
            monitor,
            sampler,
            health_state: Arc::new(HealthStateStore::default()),
            process_controller,
            cleanup_scan: Arc::new(CleanupWorkCoordinator::default()),
            cleanup_delete: Arc::new(CleanupDeleteCoordinator::default()),
            cleanup_delete_controller: Arc::new(Mutex::new(CleanupDeleteController::default())),
            file_insights: Arc::new(FileInsightsCoordinator::default()),
            startup_controller: Arc::new(Mutex::new(StartupController::default())),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn start_lease_reaper(controller: Weak<Mutex<ProcessController>>) {
    std::thread::Builder::new()
        .name("core-robin-control-lease-reaper".to_owned())
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
    state
        .sampler
        .latest_or_sample()
        .map_err(CommandError::internal)
}

#[tauri::command]
async fn get_system_summary(state: State<'_, AppState>) -> Result<SystemSummary, CommandError> {
    state
        .sampler
        .latest_summary_or_sample()
        .map_err(CommandError::internal)
}

#[tauri::command]
fn get_sampler_status(state: State<'_, AppState>) -> SamplerStatus {
    state.sampler.status()
}

#[tauri::command]
fn set_sampler_control(
    window: WebviewWindow,
    state: State<'_, AppState>,
    control: SamplerControl,
) -> Result<SamplerStatus, CommandError> {
    require_main_window(&window)?;
    Ok(state.sampler.configure(control))
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
async fn run_network_quality_check(
    window: WebviewWindow,
) -> Result<NetworkQualityResult, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(check_network_quality)
        .await
        .map_err(|error| CommandError::internal(format!("Network quality check failed: {error}")))?
}

#[tauri::command]
async fn resolve_network_hosts(
    window: WebviewWindow,
    request: NetworkHostLookupRequest,
) -> Result<Vec<NetworkHostLookup>, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || resolve_hosts(request))
        .await
        .map_err(|error| CommandError::internal(format!("Host lookup failed: {error}")))
}

#[tauri::command]
fn get_startup_context(state: State<'_, AppState>) -> StartupContext {
    StartupContext {
        background_launch: state.background_launch,
        launched_at_ms: state.launched_at_ms,
    }
}

#[tauri::command]
async fn get_gpu_energy_snapshot(window: WebviewWindow) -> Result<GpuEnergySnapshot, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(sample_gpu_energy)
        .await
        .map_err(|error| CommandError::internal(format!("GPU energy scan failed: {error}")))
}

#[tauri::command]
async fn scan_file_insights(
    window: WebviewWindow,
    state: State<'_, AppState>,
    on_progress: Channel<FileInsightsProgress>,
) -> Result<FileInsightsScan, CommandError> {
    require_main_window(&window)?;
    let coordinator = Arc::clone(&state.file_insights);
    let cancellation = coordinator.begin()?;
    let worker_cancellation = Arc::clone(&cancellation);
    let result = tauri::async_runtime::spawn_blocking(move || {
        perform_file_insights_scan(&worker_cancellation, &mut |progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await;
    coordinator.finish(&cancellation);
    result.map_err(|error| CommandError::internal(format!("File insights scan failed: {error}")))?
}

fn file_insights_cache_path(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("file-insights-v1.json"))
        .map_err(|error| {
            CommandError::internal(format!(
                "Could not resolve the application data folder: {error}"
            ))
        })
}

#[tauri::command]
async fn load_persisted_file_insights_scan(app: AppHandle) -> Result<Option<String>, CommandError> {
    let path = file_insights_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_file_insights_cache(&path))
        .await
        .map_err(|error| {
            CommandError::internal(format!("File insights cache read failed: {error}"))
        })?
}

#[tauri::command]
async fn save_persisted_file_insights_scan(
    app: AppHandle,
    snapshot: FileInsightsScan,
) -> Result<(), CommandError> {
    let path = file_insights_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_file_insights_snapshot_cache(&path, &snapshot)
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("File insights cache update failed: {error}"))
    })?
}

#[tauri::command]
async fn clear_persisted_file_insights_scan(app: AppHandle) -> Result<(), CommandError> {
    let path = file_insights_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_file_insights_cache(&path))
        .await
        .map_err(|error| {
            CommandError::internal(format!("File insights cache removal failed: {error}"))
        })?
}

#[tauri::command]
async fn revalidate_file_insights_scan(
    snapshot: FileInsightsScan,
) -> Result<FileInsightsScan, CommandError> {
    tauri::async_runtime::spawn_blocking(move || revalidate_file_insights_snapshot(snapshot))
        .await
        .map_err(|error| {
            CommandError::internal(format!("File insights revalidation task failed: {error}"))
        })?
}

#[tauri::command]
fn cancel_file_insights_scan(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    state.file_insights.cancel()
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
    request: Option<CleanupScanRequest>,
) -> Result<CleanupScan, CommandError> {
    let cache_path = cleanup_scan_cache_path(&app)?;
    let coordinator = Arc::clone(&state.cleanup_scan);
    let cancelled = coordinator.begin_full_scan()?;
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_coordinator = Arc::clone(&coordinator);
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker_coordinator.run_exclusive(&worker_cancelled, || {
            let scan = scan_cleanup(
                request.unwrap_or_default(),
                &worker_cancelled,
                &mut |progress| {
                    let _ = on_progress.send(progress);
                },
            )?;
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

fn application_history_path(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(APPLICATION_HISTORY_FILE_NAME))
        .map_err(|error| {
            CommandError::internal(format!(
                "Could not resolve the application data folder: {error}"
            ))
        })
}

#[tauri::command]
async fn load_persisted_application_history(
    app: AppHandle,
) -> Result<ApplicationHistoryStorage, CommandError> {
    let path = application_history_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_application_history(&path))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Application history read task failed: {error}"))
        })?
        .map_err(|error| {
            CommandError::new(
                "application_history_read_failed",
                format!("Application history could not be read: {error}"),
            )
        })
}

#[tauri::command]
async fn save_persisted_application_history(
    app: AppHandle,
    payload: String,
) -> Result<ApplicationHistoryStorage, CommandError> {
    let path = application_history_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_application_history(&path, &payload))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Application history write task failed: {error}"))
        })?
        .map_err(|error| {
            CommandError::new(
                "application_history_write_failed",
                format!("Application history could not be saved: {error}"),
            )
        })
}

#[tauri::command]
async fn clear_persisted_application_history(app: AppHandle) -> Result<(), CommandError> {
    let path = application_history_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_application_history(&path))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Application history removal task failed: {error}"))
        })?
        .map_err(|error| {
            CommandError::new(
                "application_history_clear_failed",
                format!("Application history could not be cleared: {error}"),
            )
        })
}

fn history_segment_path(
    app: &AppHandle,
    category: &str,
) -> Result<std::path::PathBuf, CommandError> {
    let category = HistoryCategory::parse(category)
        .map_err(|error| CommandError::new("history_category_invalid", error.to_string()))?;
    app.path()
        .app_data_dir()
        .map(|directory| category.path(&directory))
        .map_err(|error| {
            CommandError::internal(format!(
                "Could not resolve the application data folder: {error}"
            ))
        })
}

#[tauri::command]
async fn load_history_storage(
    app: AppHandle,
    category: String,
) -> Result<HistorySegmentStorage, CommandError> {
    let path = history_segment_path(&app, &category)?;
    tauri::async_runtime::spawn_blocking(move || load_history_segment(&path))
        .await
        .map_err(|error| CommandError::internal(format!("History read task failed: {error}")))?
        .map_err(|error| {
            CommandError::new(
                "history_read_failed",
                format!("History could not be read: {error}"),
            )
        })
}

#[tauri::command]
async fn save_history_storage(
    app: AppHandle,
    category: String,
    payload: String,
) -> Result<HistorySegmentStorage, CommandError> {
    let path = history_segment_path(&app, &category)?;
    tauri::async_runtime::spawn_blocking(move || save_history_segment(&path, &payload))
        .await
        .map_err(|error| CommandError::internal(format!("History write task failed: {error}")))?
        .map_err(|error| {
            CommandError::new(
                "history_write_failed",
                format!("History could not be saved: {error}"),
            )
        })
}

#[tauri::command]
async fn clear_history_storage(
    app: AppHandle,
    category: String,
) -> Result<HistorySegmentStorage, CommandError> {
    let path = history_segment_path(&app, &category)?;
    tauri::async_runtime::spawn_blocking(move || history_storage::remove(&path))
        .await
        .map_err(|error| CommandError::internal(format!("History removal task failed: {error}")))?
        .map_err(|error| {
            CommandError::new(
                "history_clear_failed",
                format!("History could not be cleared: {error}"),
            )
        })
}

#[tauri::command]
async fn get_history_storage_summary(
    app: AppHandle,
) -> Result<HistoryStorageSummary, CommandError> {
    let directory = app.path().app_data_dir().map_err(|error| {
        CommandError::internal(format!(
            "Could not resolve the application data folder: {error}"
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || history_storage_summary(&directory))
        .await
        .map_err(|error| CommandError::internal(format!("History summary task failed: {error}")))
}

fn cache_item_summary(
    paths: impl IntoIterator<Item = std::path::PathBuf>,
) -> ProductDataCacheItemSummary {
    let mut summary = ProductDataCacheItemSummary::default();
    for path in paths {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => continue,
        };
        summary.byte_size = summary.byte_size.saturating_add(metadata.len());
        summary.file_count = summary.file_count.saturating_add(1);
        let updated_at_ms = metadata.modified().ok().and_then(|updated_at| {
            updated_at
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        });
        summary.updated_at_ms = match (summary.updated_at_ms, updated_at_ms) {
            (Some(current), Some(next)) => Some(current.max(next)),
            (None, next) => next,
            (current, None) => current,
        };
    }
    summary
}

fn application_inventory_cache_paths(
    directory: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, CommandError> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(CommandError::internal(format!(
                "Product data folder could not be read: {error}"
            )));
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            CommandError::internal(format!("Product data entry could not be read: {error}"))
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("application-inventory-v1-") && name.ends_with(".json") {
            paths.push(entry.path());
        }
    }
    Ok(paths)
}

fn product_data_cache_summary_at(
    directory: &std::path::Path,
) -> Result<ProductDataCacheSummary, CommandError> {
    let history_summary = history_storage_summary(directory);
    Ok(ProductDataCacheSummary {
        cleanup_scan: cache_item_summary([
            directory.join("cleanup-scan-v3.json"),
            directory.join("cleanup-scan-v2.json"),
        ]),
        file_insights: cache_item_summary([directory.join("file-insights-v1.json")]),
        application_inventory: cache_item_summary(application_inventory_cache_paths(directory)?),
        application_history: cache_item_summary([directory.join(APPLICATION_HISTORY_FILE_NAME)]),
        history_segments: ProductDataCacheItemSummary {
            byte_size: history_summary.byte_size,
            file_count: history_summary.file_count,
            updated_at_ms: history_summary.updated_at_ms,
        },
    })
}

fn clear_application_inventory_cache_at(directory: &std::path::Path) -> Result<(), CommandError> {
    for path in application_inventory_cache_paths(directory)? {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "Application inventory cache could not be checked: {error}"
                )));
            }
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "Application inventory cache could not be removed: {error}"
                )));
            }
        }
    }
    Ok(())
}

fn clear_persisted_product_data_at(directory: &std::path::Path) -> Result<(), CommandError> {
    let cleanup_path = directory.join("cleanup-scan-v3.json");
    let legacy_cleanup_path = directory.join("cleanup-scan-v2.json");
    let file_insights_path = directory.join("file-insights-v1.json");
    let application_history_path = directory.join(APPLICATION_HISTORY_FILE_NAME);
    remove_cleanup_scan_cache(&cleanup_path)?;
    remove_cleanup_scan_cache(&legacy_cleanup_path)?;
    remove_file_insights_cache(&file_insights_path)?;
    remove_application_history(&application_history_path).map_err(|error| {
        CommandError::internal(format!("Application history could not be removed: {error}"))
    })?;
    let receipt = clear_all_history_segments(directory).map_err(|error| {
        CommandError::internal(format!("History segments could not be removed: {error}"))
    })?;
    if receipt.file_count != 0 || receipt.byte_size != 0 {
        return Err(CommandError::internal(
            "History segments still exist after reset.",
        ));
    }
    clear_application_inventory_cache_at(directory)
}

#[tauri::command]
async fn get_product_data_cache_summary(
    app: AppHandle,
) -> Result<ProductDataCacheSummary, CommandError> {
    let directory = app.path().app_data_dir().map_err(|error| {
        CommandError::internal(format!(
            "Could not resolve the application data folder: {error}"
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || product_data_cache_summary_at(&directory))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Product data inspection task failed: {error}"))
        })?
}

#[tauri::command]
async fn clear_application_inventory_cache(app: AppHandle) -> Result<(), CommandError> {
    let directory = app.path().app_data_dir().map_err(|error| {
        CommandError::internal(format!(
            "Could not resolve the application data folder: {error}"
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || clear_application_inventory_cache_at(&directory))
        .await
        .map_err(|error| {
            CommandError::internal(format!(
                "Application inventory cache removal task failed: {error}"
            ))
        })?
}

#[tauri::command]
async fn clear_persisted_product_data(app: AppHandle) -> Result<(), CommandError> {
    let directory = app.path().app_data_dir().map_err(|error| {
        CommandError::internal(format!(
            "Could not resolve the application data folder: {error}"
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || clear_persisted_product_data_at(&directory))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Product data removal task failed: {error}"))
        })?
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
fn reveal_path(window: WebviewWindow, path: String) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::reveal_path(&path)
}

#[tauri::command]
fn preview_path(window: WebviewWindow, path: String) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::preview_path(&path)
}

#[tauri::command]
fn resolve_user_path(window: WebviewWindow, path: String) -> Result<String, CommandError> {
    require_main_window(&window)?;
    user_actions::resolve_user_path(&path).map(|resolved| resolved.to_string_lossy().into_owned())
}

#[tauri::command]
async fn eject_removable_volume(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mount_point: String,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    let verified_mount_point = mount_point.clone();
    let removable = state
        .sampler
        .latest_or_sample()
        .map_err(CommandError::internal)?
        .disk
        .volumes
        .into_iter()
        .any(|volume| volume.removable && volume.mount_point == verified_mount_point);
    if !removable {
        return Err(CommandError::new(
            "volume_not_removable",
            "This volume is no longer available as a removable volume.",
        ));
    }
    tauri::async_runtime::spawn_blocking({
        let mount_point = mount_point.clone();
        move || user_actions::eject_removable_volume(&mount_point)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Volume ejection task failed: {error}")))??;
    with_monitor(Arc::clone(&state.monitor), move |monitor| {
        monitor.record_volume_ejected(&mount_point);
        monitor.request_volume_catalog_refresh();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn get_storage_health(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mount_points: Vec<String>,
    force_refresh: Option<bool>,
) -> Result<StorageHealthSnapshot, CommandError> {
    require_main_window(&window)?;
    let available = state
        .sampler
        .latest_or_sample()
        .map_err(CommandError::internal)?
        .disk
        .volumes
        .into_iter()
        .map(|volume| volume.mount_point)
        .collect::<Vec<_>>();
    let verified = validate_mount_points(&mount_points, &available)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(inspect_storage_health(
            &verified,
            now_millis(),
            force_refresh.unwrap_or(false),
        ))
    })
    .await
    .map_err(|error| CommandError::internal(format!("Storage inspection task failed: {error}")))?
}

#[tauri::command]
fn open_disk_utility(window: WebviewWindow) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::open_disk_utility()
}

#[tauri::command]
fn open_system_settings(
    window: WebviewWindow,
    destination: SystemSettingsDestination,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::open_system_settings(destination)
}

#[tauri::command]
fn open_product_page(
    window: WebviewWindow,
    page: ProductPage,
    language: ProductLanguage,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::open_product_page(page, language)
}

#[tauri::command]
fn open_product_issue(
    window: WebviewWindow,
    title: String,
    body: String,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::open_product_issue(&title, &body)
}

#[tauri::command]
fn relaunch_application(
    window: WebviewWindow,
    executable_path: String,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    user_actions::relaunch_application(&executable_path)
}

#[tauri::command]
fn can_relaunch_application(
    window: WebviewWindow,
    executable_path: String,
) -> Result<bool, CommandError> {
    require_main_window(&window)?;
    user_actions::can_relaunch_application(&executable_path)
}

#[tauri::command]
async fn get_installed_applications(
    app: AppHandle,
    window: WebviewWindow,
    language: Option<String>,
    force_refresh: bool,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    require_main_window(&window)?;
    let cache_path = application_inventory_cache_path(&app, language.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        load_or_scan_application_inventory(&cache_path, language.as_deref(), force_refresh)
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("Application inventory task failed: {error}"))
    })?
}

fn application_inventory_cache_path(
    app: &AppHandle,
    language: Option<&str>,
) -> Result<std::path::PathBuf, CommandError> {
    let language = language
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 32
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
        .unwrap_or("default")
        .to_ascii_lowercase();
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(format!("application-inventory-v1-{language}.json")))
        .map_err(|error| {
            CommandError::internal(format!(
                "Could not resolve the application data folder: {error}"
            ))
        })
}

#[tauri::command]
async fn get_application_uninstall_plan(
    window: WebviewWindow,
    application_path: String,
    language: Option<String>,
) -> Result<ApplicationUninstallPlan, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_application_uninstall(&application_path, language.as_deref())
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("Application uninstall scan failed: {error}"))
    })?
}

#[tauri::command]
async fn get_trashed_applications(
    window: WebviewWindow,
    language: Option<String>,
) -> Result<Vec<TrashedApplication>, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || scan_trashed_applications(language.as_deref()))
        .await
        .map_err(|error| {
            CommandError::internal(format!("Trash application scan failed: {error}"))
        })?
}

#[tauri::command]
async fn get_trashed_application_residual_plan(
    window: WebviewWindow,
    application_path: String,
    language: Option<String>,
) -> Result<ApplicationUninstallPlan, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_trashed_application_residual_plan(&application_path, language.as_deref())
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("Trashed application residual scan failed: {error}"))
    })?
}

#[tauri::command]
async fn execute_native_application_uninstall(
    window: WebviewWindow,
    request: NativeApplicationUninstallExecutionRequest,
) -> Result<NativeApplicationUninstallResult, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        native_uninstall::execute_native_application_uninstall(request)
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("Native application uninstall task failed: {error}"))
    })?
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
async fn set_cleanup_delete_lease_mode(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CleanupDeleteLeaseModeRequest,
) -> Result<CleanupDeleteLease, CommandError> {
    require_main_window(&window)?;
    with_cleanup_delete_controller(
        Arc::clone(&state.cleanup_delete_controller),
        move |controller| controller.set_lease_mode(request),
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
        let measurement_path = controller.lease_measurement_path(&request.lease_id);
        let available_bytes_before = measurement_path
            .as_deref()
            .and_then(available_bytes_for_path);
        let mut result =
            controller.execute_cancellable(request, &worker_cancelled, &mut |progress| {
                let _ = on_progress.send(progress);
            })?;
        result.available_bytes_before = available_bytes_before;
        result.available_bytes_after = measurement_path
            .as_deref()
            .and_then(available_bytes_for_path);
        Ok(result)
    })
    .await;
    coordinator.finish(&cancelled);
    let result = result
        .map_err(|error| CommandError::internal(format!("Cleanup task failed: {error}")))??;
    with_monitor(Arc::clone(&state.monitor), |monitor| {
        monitor.request_volume_catalog_refresh();
        Ok(())
    })
    .await?;
    Ok(result)
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
fn quit_application(window: WebviewWindow, app: AppHandle) -> Result<(), CommandError> {
    require_tray_window(&window)?;
    app.exit(0);
    Ok(())
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
        let _ = app.emit_to("main", "core-robin:main-visibility", true);
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
    let _ = app.emit_to("main", "core-robin:navigate", view);
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

#[cfg(any(target_os = "macos", test))]
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
    // screen-space anchor so showing a bubble never makes Robin jump sideways.
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
    let _ = app.emit_to("companion", "core-robin:companion-collapse", ());
}

fn publish_companion_visibility(app: &AppHandle, window: &tauri::WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let _ = app.emit_to("main", "core-robin:companion-visibility", visible);
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
        let _ = app.emit_to("companion", "core-robin:companion-enter", ());
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
    let _ = app.emit_to("companion", "core-robin:companion-exit", ());
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
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
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
    request: ApplicationIconRequest,
) -> Result<Option<ApplicationIcon>, CommandError> {
    let icon_source = match (
        request.process,
        request.application_path,
        request.executable_path,
    ) {
        (Some(process), None, None) => {
            let executable = with_monitor(Arc::clone(&state.monitor), move |monitor| {
                Ok(monitor.process_detail(process)?.executable)
            })
            .await?;
            ApplicationIconSource::Executable(executable)
        }
        (None, Some(application_path), None) if !application_path.trim().is_empty() => {
            ApplicationIconSource::Bundle(application_path)
        }
        (None, None, Some(executable_path)) if !executable_path.trim().is_empty() => {
            ApplicationIconSource::Executable(Some(executable_path))
        }
        _ => {
            return Err(CommandError::new(
                "application_icon_request_invalid",
                "Choose exactly one application icon source.",
            ));
        }
    };
    tauri::async_runtime::spawn_blocking(move || match icon_source {
        ApplicationIconSource::Executable(executable) => {
            load_application_icon(executable.as_deref())
        }
        ApplicationIconSource::Bundle(application_path) => {
            load_application_bundle_icon(&application_path)
        }
    })
    .await
    .map_err(|error| CommandError::internal(format!("Application icon task failed: {error}")))
}

enum ApplicationIconSource {
    Executable(Option<String>),
    Bundle(String),
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());
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
            app.state::<AppState>().sampler.start(app.handle().clone());
            #[cfg(target_os = "macos")]
            {
                app.handle()
                    .set_activation_policy(ActivationPolicy::Accessory)?;
                if let Some(tray_window) = app.get_webview_window("tray") {
                    let panel = tray_window.to_panel::<tray_panel_native::CoreRobinTrayPanel>()?;
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
                if let Some(companion_window) = app.get_webview_window("companion") {
                    let panel = companion_window
                        .to_panel::<tray_panel_native::CoreRobinCompanionPanel>()?;
                    panel.set_collection_behavior(
                        NSWindowCollectionBehavior::CanJoinAllSpaces
                            | NSWindowCollectionBehavior::FullScreenAuxiliary
                            | NSWindowCollectionBehavior::IgnoresCycle,
                    );
                    panel.set_style_mask(
                        panel.as_panel().styleMask() | NSWindowStyleMask::NonactivatingPanel,
                    );
                    panel.set_hides_on_deactivate(false);
                    panel.set_released_when_closed(false);
                }
            }
            if app.state::<AppState>().background_launch
                && let Some(splash) = app.get_webview_window("splashscreen")
            {
                let _ = splash.close();
            }
            let open = MenuItem::with_id(app, "open", "Open CoreRobin", true, None::<&str>)?;
            let settings =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let about = MenuItem::with_id(app, "about", "About CoreRobin", true, None::<&str>)?;
            let companion = MenuItem::with_id(app, "companion", "Robin", true, None::<&str>)?;
            let cleanup = MenuItem::with_id(app, "cleanup", "Space Cleanup", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit CoreRobin", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&open, &settings, &about, &companion, &cleanup, &quit],
            )?;
            let tray_left_click_tracker = Arc::new(Mutex::new(TrayLeftClickTracker::default()));
            let mut tray = TrayIconBuilder::with_id("core-robin-status")
                .tooltip("CoreRobin · Local Monitor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => navigate_main(app, "settings"),
                    "about" => {
                        navigate_main(app, "settings");
                        let _ = app.emit_to("main", "core-robin:open-about", ());
                    }
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
                .name("core-robin-splash-fallback".to_owned())
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
                    .emit_to("main", "core-robin:main-visibility", false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_snapshot,
            get_system_summary,
            get_sampler_status,
            set_sampler_control,
            publish_health_state,
            get_health_state,
            get_network_connections,
            run_network_quality_check,
            resolve_network_hosts,
            get_startup_context,
            get_gpu_energy_snapshot,
            scan_file_insights,
            cancel_file_insights_scan,
            load_persisted_file_insights_scan,
            save_persisted_file_insights_scan,
            clear_persisted_file_insights_scan,
            revalidate_file_insights_scan,
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
            load_persisted_application_history,
            save_persisted_application_history,
            clear_persisted_application_history,
            load_history_storage,
            save_history_storage,
            clear_history_storage,
            get_history_storage_summary,
            get_product_data_cache_summary,
            clear_application_inventory_cache,
            clear_persisted_product_data,
            cancel_cleanup_scan,
            cancel_cleanup_subtree,
            get_cleanup_scan_access,
            open_cleanup_full_disk_access_settings,
            reveal_cleanup_app_bundle,
            reveal_path,
            preview_path,
            resolve_user_path,
            eject_removable_volume,
            get_storage_health,
            open_disk_utility,
            open_system_settings,
            open_product_page,
            open_product_issue,
            relaunch_application,
            can_relaunch_application,
            get_installed_applications,
            get_application_uninstall_plan,
            get_trashed_applications,
            get_trashed_application_residual_plan,
            execute_native_application_uninstall,
            create_cleanup_delete_lease,
            release_cleanup_delete_lease,
            set_cleanup_delete_lease_mode,
            execute_cleanup_delete,
            cancel_cleanup_delete,
            complete_startup,
            show_main_window,
            quit_application,
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
        .build(tauri::generate_context!())
        .expect("error while building CoreRobin")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
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
mod product_data_tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{
        APPLICATION_HISTORY_FILE_NAME, clear_application_inventory_cache_at,
        clear_persisted_product_data_at, product_data_cache_summary_at,
    };

    #[test]
    fn clear_product_data_removes_known_caches_only() {
        let root = tempdir().unwrap();
        for name in [
            "cleanup-scan-v3.json",
            "cleanup-scan-v2.json",
            "file-insights-v1.json",
            APPLICATION_HISTORY_FILE_NAME,
            "application-inventory-v1-en.json",
            "application-inventory-v1-zh-cn.json",
        ] {
            fs::write(root.path().join(name), b"cached").unwrap();
        }
        let unrelated = root.path().join("keep-me.json");
        fs::write(&unrelated, b"private").unwrap();
        fs::create_dir(root.path().join("application-inventory-v1-directory.json")).unwrap();

        clear_persisted_product_data_at(root.path()).unwrap();

        assert!(unrelated.exists());
        assert!(
            root.path()
                .join("application-inventory-v1-directory.json")
                .is_dir()
        );
        assert!(!root.path().join("cleanup-scan-v3.json").exists());
        assert!(!root.path().join("cleanup-scan-v2.json").exists());
        assert!(!root.path().join("file-insights-v1.json").exists());
        assert!(!root.path().join(APPLICATION_HISTORY_FILE_NAME).exists());
        assert!(
            !root
                .path()
                .join("application-inventory-v1-en.json")
                .exists()
        );
        assert!(
            !root
                .path()
                .join("application-inventory-v1-zh-cn.json")
                .exists()
        );
    }

    #[test]
    fn summarizes_known_cache_categories_without_following_directories() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("cleanup-scan-v3.json"), b"cleanup").unwrap();
        fs::write(root.path().join("file-insights-v1.json"), b"insights").unwrap();
        fs::write(root.path().join(APPLICATION_HISTORY_FILE_NAME), b"history").unwrap();
        fs::write(
            root.path().join("application-inventory-v1-en.json"),
            b"apps",
        )
        .unwrap();
        fs::create_dir(root.path().join("application-inventory-v1-directory.json")).unwrap();

        let summary = product_data_cache_summary_at(root.path()).unwrap();

        assert_eq!(summary.cleanup_scan.file_count, 1);
        assert_eq!(summary.cleanup_scan.byte_size, 7);
        assert_eq!(summary.file_insights.file_count, 1);
        assert_eq!(summary.file_insights.byte_size, 8);
        assert_eq!(summary.application_inventory.file_count, 1);
        assert_eq!(summary.application_inventory.byte_size, 4);
        assert_eq!(summary.application_history.file_count, 1);
        assert_eq!(summary.application_history.byte_size, 7);
    }

    #[test]
    fn clears_only_application_inventory_cache_files() {
        let root = tempdir().unwrap();
        let inventory = root.path().join("application-inventory-v1-en.json");
        let cleanup = root.path().join("cleanup-scan-v3.json");
        fs::write(&inventory, b"apps").unwrap();
        fs::write(&cleanup, b"cleanup").unwrap();

        clear_application_inventory_cache_at(root.path()).unwrap();

        assert!(!inventory.exists());
        assert!(cleanup.exists());
    }
}

#[cfg(test)]
mod security_boundary_tests {
    use std::collections::BTreeSet;

    use serde_json::Value;

    use super::{
        command_names::ALL_COMMANDS, require_main_window_label, require_tray_window_label,
    };

    const PROTECTED_COMMANDS: &[&str] = &[
        "create_startup_management_lease",
        "release_startup_management_lease",
        "execute_startup_management",
        "open_cleanup_full_disk_access_settings",
        "reveal_cleanup_app_bundle",
        "reveal_path",
        "preview_path",
        "resolve_user_path",
        "eject_removable_volume",
        "get_storage_health",
        "open_disk_utility",
        "open_system_settings",
        "open_product_page",
        "open_product_issue",
        "relaunch_application",
        "can_relaunch_application",
        "get_installed_applications",
        "get_application_uninstall_plan",
        "get_trashed_applications",
        "get_trashed_application_residual_plan",
        "execute_native_application_uninstall",
        "create_cleanup_delete_lease",
        "release_cleanup_delete_lease",
        "set_cleanup_delete_lease_mode",
        "execute_cleanup_delete",
        "cancel_cleanup_delete",
        "publish_health_state",
        "set_dock_icon_visible",
        "get_launch_at_login",
        "set_launch_at_login",
        "create_process_control_lease",
        "release_process_control_lease",
        "execute_process_action",
        "run_network_quality_check",
        "resolve_network_hosts",
        "get_gpu_energy_snapshot",
        "scan_file_insights",
        "cancel_file_insights_scan",
        "revalidate_file_insights_scan",
        "clear_application_inventory_cache",
        "save_persisted_application_history",
        "clear_persisted_application_history",
        "clear_persisted_product_data",
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
    fn application_run_loop_handles_macos_dock_reopen_events() {
        let source = include_str!("lib.rs");
        let run_loop = source
            .split_once(".build(tauri::generate_context!())")
            .expect("the application must be built before its run loop")
            .1
            .split_once("#[cfg(test)]")
            .expect("the run loop must end before the test modules")
            .0;

        assert!(run_loop.contains("tauri::RunEvent::Reopen"));
        assert!(run_loop.contains("show_main(app)"));
    }

    #[test]
    fn macos_companion_uses_an_all_spaces_panel() {
        let source = include_str!("lib.rs");
        let setup = source
            .split_once("if let Some(companion_window)")
            .expect("the companion window must be configured during setup")
            .1
            .split_once("let open = MenuItem")
            .expect("the companion setup must finish before the application menu")
            .0;

        assert!(setup.contains("CoreRobinCompanionPanel"));
        assert!(setup.contains("NSWindowCollectionBehavior::CanJoinAllSpaces"));
        assert!(setup.contains("NSWindowCollectionBehavior::FullScreenAuxiliary"));
        assert!(setup.contains("NSWindowStyleMask::NonactivatingPanel"));
        assert!(setup.contains("set_hides_on_deactivate(false)"));
    }

    #[test]
    fn protected_handler_guard_rejects_every_auxiliary_window() {
        assert!(require_main_window_label("main").is_ok());
        for label in ["tray", "companion", "splashscreen", "unexpected"] {
            let error = require_main_window_label(label).expect_err("window must be rejected");
            assert_eq!(error.code, "window_not_authorized");
        }
    }

    #[test]
    fn tray_handler_guard_accepts_only_the_tray_panel() {
        assert!(require_tray_window_label("tray").is_ok());
        for label in ["main", "companion", "splashscreen", "unexpected"] {
            let error = require_tray_window_label(label).expect_err("window must be rejected");
            assert_eq!(error.code, "window_not_authorized");
        }
    }
}
