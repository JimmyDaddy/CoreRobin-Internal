//! Robin invokes existing native operations through this finite dispatch table.
//! Models supply native target references, never executable paths or process IDs.
use crate::{AppState, ai::tools::*, ai::*, ai_commands::AiRuntime, ai_context_bridge, models::*};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

fn error(error: crate::error::CommandError) -> AiError {
    // Native errors may embed full paths. The model receives the stable code,
    // while exact filesystem targets belong only in the local confirmation.
    AiError::new(
        error.code,
        "The native operation failed. No successful result was assumed. Check the corresponding CoreRobin view for details.",
    )
}
fn unavailable() -> AiError {
    AiError::new(
        "tool_unavailable",
        "The native check could not complete. No result was assumed.",
    )
}
fn target_missing() -> AiError {
    AiError::new(
        "target_unavailable",
        "No current native target reference was supplied. Call get_process_usage for a process or scan_disk_usage for cleanup in this task, then use the exact returned targetRef. This error does not prove that the process or file is absent. Names, paths and process IDs are not valid references.",
    )
}
fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}
fn facts_value(facts: AiContextFacts) -> Value {
    json!({"sampledAt":facts.captured_at,"observations":facts.facts.into_iter().take(32).map(|fact|json!({"label":fact.label,"value":fact.value,"unit":fact.unit})).collect::<Vec<_>>(),"coverage":facts.coverage})
}
fn remember(context: &ToolContext, target: NativeTarget) -> Result<String, AiError> {
    let reference = crate::ai::service::new_id()?;
    let mut targets = context.targets.lock().map_err(AiError::storage)?;
    if targets.len() >= 64 {
        return Err(AiError::new(
            "task_limit",
            "This task reached its target limit.",
        ));
    }
    targets.insert(reference.clone(), target);
    Ok(reference)
}
fn target(context: &ToolContext, reference: &str) -> Result<NativeTarget, AiError> {
    context
        .targets
        .lock()
        .map_err(AiError::storage)?
        .get(reference)
        .cloned()
        .ok_or_else(target_missing)
}

pub async fn execute(
    app: AppHandle,
    call: ToolCall,
    context: ToolContext,
) -> Result<Value, AiError> {
    if !context.scope.include_context {
        return Err(AiError::new(
            "device_context_disabled",
            "Enable device context to run checks.",
        ));
    }
    let runtime = app.state::<AiRuntime>();
    {
        let _gate = runtime.context_gate.read().await;
        runtime.require_source_ready()?;
        context.check_active()?;
    }
    let result = match parse(&call)? {
        ToolOperation::LocalUtility(arguments) => {
            crate::local_utility_bridge::execute(&app, arguments, &context).await
        }
        ToolOperation::Device => device(&app, &context).await,
        ToolOperation::Processes(args) => processes(&app, &context, args).await,
        ToolOperation::History => history(&app, &context).await,
        ToolOperation::Network => network(&app, &context).await,
        ToolOperation::Disk => disk(&app, &context).await,
        ToolOperation::ProcessAction(args) => process_action(&app, &context, args).await,
        ToolOperation::Cleanup(args) => cleanup(&app, &context, args).await,
        ToolOperation::OpenCapability(args) => {
            crate::application_capability_catalog::open_form(&args.capability_id)
        }
        ToolOperation::QuickCleanupAnalysis => {
            crate::application_capability_catalog::analyze_quick_cleanup(app.clone(), &context)
                .await
        }
    };
    let _gate = runtime.context_gate.read().await;
    runtime.require_source_ready()?;
    context.check_active()?;
    result
}

async fn snapshot(app: &AppHandle) -> Result<SystemSnapshot, AiError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .sampler
            .inspect_snapshot()
            .map_err(|_| unavailable())
    })
    .await
    .map_err(|_| unavailable())?
}
async fn device(app: &AppHandle, context: &ToolContext) -> Result<Value, AiError> {
    let snapshot = snapshot(app).await?;
    context.check_active()?;
    let state = app.state::<AppState>();
    let health = state
        .health_state
        .current()
        .map_err(error)?
        .filter(|health| crate::now_millis().saturating_sub(health.update.sampled_at_ms) <= 15_000);
    Ok(
        json!({"sampledAt":snapshot.sampled_at_ms,"warmingUp":snapshot.warming_up,
        "cpu":snapshot.cpu,"memory":snapshot.memory,
        "disk":{"readBytesPerSecond":snapshot.disk.read_bytes_per_second,"writeBytesPerSecond":snapshot.disk.write_bytes_per_second,
            "volumes":snapshot.disk.volumes.iter().take(8).map(|volume|json!({"name":clean(&volume.name,80),"totalBytes":volume.total_bytes,"availableBytes":volume.available_bytes})).collect::<Vec<_>>()},
        "temperatureCelsius":snapshot.sensors.temperature.celsius,"criticalTemperatureCelsius":snapshot.sensors.temperature.critical_celsius,
        "battery":snapshot.sensors.battery,
        "network":{"receivedBytesPerSecond":snapshot.network.received_bytes_per_second,"transmittedBytesPerSecond":snapshot.network.transmitted_bytes_per_second},
        "existingDiagnosis":health,
        "limitations":["Low CPU use is not a fault. There is no universal normal disk or network throughput.","Memory available and swap are observations, not proof of memory pressure.","This AI request may itself consume CPU and memory."]}),
    )
}
async fn processes(
    app: &AppHandle,
    context: &ToolContext,
    args: ProcessArgs,
) -> Result<Value, AiError> {
    let mut snapshot = snapshot(app).await?;
    context.check_active()?;
    snapshot.processes.sort_by(|a, b| match args.sort_by {
        ProcessSort::Cpu => b
            .cpu_percent
            .unwrap_or(0.0)
            .total_cmp(&a.cpu_percent.unwrap_or(0.0)),
        ProcessSort::Memory => b.memory_bytes.cmp(&a.memory_bytes),
    });
    let mut rows = Vec::new();
    for process in snapshot.processes.into_iter().take(10) {
        let reference = if !process.protected {
            process
                .birth_token
                .clone()
                .map(|birth_token| {
                    remember(
                        context,
                        NativeTarget::Process {
                            key: ProcessKey {
                                pid: process.pid,
                                birth_token,
                            },
                            name: clean(&process.name, 120),
                        },
                    )
                })
                .transpose()?
        } else {
            None
        };
        rows.push(json!({"targetRef":reference,"name":clean(&process.name,120),"pid":process.pid,"cpuPercent":process.cpu_percent,"memoryBytes":process.memory_bytes,
            "diskReadBytesPerSecond":process.disk_read_bytes_per_second,"diskWriteBytesPerSecond":process.disk_write_bytes_per_second,"protected":process.protected}));
    }
    Ok(
        json!({"sampledAt":snapshot.sampled_at_ms,"processes":rows,"coverage":"Top 10 processes from native sampling; no file contents, command lines or user identities are included."}),
    )
}
async fn history(app: &AppHandle, context: &ToolContext) -> Result<Value, AiError> {
    let directory = app.path().app_data_dir().map_err(AiError::storage)?;
    let scope = context.scope.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let now = crate::now_millis();
        let input = PrepareInput {
            expected_connection_revision: None,
            language: None,
            session_id: String::new(),
            expected_revision: 0,
            text: String::new(),
            scenario: scope.scenario,
            include_context: true,
            incident_id: scope.incident_id,
            from_ms: scope.from_ms,
            to_ms: scope.to_ms,
        };
        let mut facts = AiContextFacts {
            captured_at: now,
            ..Default::default()
        };
        ai_context_bridge::append_history(&mut facts, &directory, &input, now)?;
        Ok(facts_value(facts))
    })
    .await
    .map_err(|_| unavailable())?
}

struct CancelFlag(Arc<AtomicBool>);
impl Drop for CancelFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct DeleteOperation {
    coordinator: Arc<crate::cleanup::CleanupDeleteCoordinator>,
    cancelled: Arc<AtomicBool>,
}
impl Drop for DeleteOperation {
    fn drop(&mut self) {
        self.coordinator.finish(&self.cancelled);
    }
}
async fn network(app: &AppHandle, context: &ToolContext) -> Result<Value, AiError> {
    let operation_cancel = Arc::new(AtomicBool::new(false));
    let _stop = CancelFlag(operation_cancel.clone());
    let task = tauri::async_runtime::spawn_blocking(move || {
        crate::network_quality::run_network_quality_check_cancellable(&operation_cancel)
            .map_err(error)
    });
    let result = crate::ai::transport::cancellable(context.cancelled.clone(), 30, async {
        task.await.map_err(|_| unavailable())?
    })
    .await?;
    context.check_active()?;
    let runtime = app.state::<AiRuntime>();
    let _gate = runtime.context_gate.read().await;
    runtime.require_source_ready()?;
    context.check_active()?;
    runtime
        .application_results
        .publish_network(result.clone())
        .map_err(error)?;
    // The full typed result is published above; this safe projection omits route identifiers.
    Ok(
        json!({"sampledAt":result.sampled_at_ms,"status":result.status,"diagnostics":result.diagnostics,"averageLatencyMs":result.average_latency_ms,"tcpProbeFailurePercent":result.tcp_probe_failure_percent,"probeCount":result.probe_count,"successfulProbeCount":result.successful_probe_count}),
    )
}

struct OwnedScan {
    manager: Arc<crate::cleanup_scan_job::CleanupScanJobManager>,
    id: String,
}
impl Drop for OwnedScan {
    fn drop(&mut self) {
        let _ = self.manager.cancel_job(&self.id);
    }
}
async fn disk(app: &AppHandle, context: &ToolContext) -> Result<Value, AiError> {
    let directory = app.path().app_data_dir().map_err(AiError::storage)?;
    let index = crate::cleanup_scan_index_path(app).map_err(error)?;
    let manager = app.state::<AppState>().cleanup_scan_jobs.clone();
    let worker_manager = manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        worker_manager
            .start_if_idle(
                CleanupScanRequest {
                    profile: CleanupScanProfile::CommonLocations,
                    target_kind: CleanupScanTargetKind::SystemDisk,
                    target_path: None,
                },
                &directory.join("cleanup-scan-jobs"),
                &index,
            )
            .map_err(error)
    })
    .await
    .map_err(|_| unavailable())??;
    let _owned = OwnedScan {
        manager: manager.clone(),
        id: status.job_id.clone(),
    };
    let started = Instant::now();
    loop {
        context.check_active()?;
        let current = manager.status().map_err(error)?.ok_or_else(unavailable)?;
        if current.job_id != status.job_id {
            return Err(AiError::new(
                "scan_replaced",
                "The scan was replaced by another user action. Robin did not cancel the replacement.",
            ));
        }
        match current.phase {
            CleanupScanJobPhase::Completed => break,
            CleanupScanJobPhase::Cancelled => return Err(cancelled()),
            CleanupScanJobPhase::Failed => {
                return Err(AiError::new(
                    "scan_failed",
                    "The disk scan failed. No completed result is available.",
                ));
            }
            _ => {}
        }
        if started.elapsed() > Duration::from_secs(120) {
            return Err(AiError::new(
                "scan_timeout",
                "The disk check exceeded two minutes and was stopped. No complete scan was assumed.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let scan = manager.result(&status.job_id).map_err(error)?;
    let mut candidates = Vec::new();
    collect_candidates(&scan.root, &mut candidates);
    candidates.sort_by_key(|node| std::cmp::Reverse(node.allocated_size_bytes));
    let mut items = Vec::new();
    for node in candidates.into_iter().take(12) {
        let path = node.path.clone().ok_or_else(target_missing)?;
        let request = CleanupDeleteLeaseRequest {
            scan_id: scan.indexed.then(|| scan.scan_id.clone()),
            directory_ids: if scan.indexed {
                vec![node.id.clone()]
            } else {
                Vec::new()
            },
            paths: if scan.indexed {
                Vec::new()
            } else {
                vec![path.clone()]
            },
            scan_sampled_at_ms: scan.sampled_at_ms,
            scan_root: scan.root.path.clone(),
            scan_target_kind: scan.target_kind,
            expected_targets: vec![CleanupDeleteTargetEvidence {
                path: path.clone(),
                logical_size_bytes: node.logical_size_bytes,
                allocated_size_bytes: node.allocated_size_bytes,
                item_count: node.item_count,
            }],
            mode: CleanupDeleteMode::Trash,
            application_uninstall: None,
        };
        let reference = remember(context, NativeTarget::Cleanup(Box::new(request)))?;
        items.push(json!({"targetRef":reference,"name":clean(&node.name,80),"logicalBytes":node.logical_size_bytes,"allocatedBytes":node.allocated_size_bytes,"itemCount":node.item_count,"safety":node.safety}));
    }
    Ok(
        json!({"scanId":scan.scan_id,"sourceRevision":app.state::<AppState>().application_results.snapshot().map_err(error)?.disk_revision,"sampledAt":scan.sampled_at_ms,"scope":"common_user_locations","scannedEntries":scan.scanned_entry_count,"unreadableEntries":scan.unreadable_entry_count,
        "locations":scan.locations.iter().take(8).map(|location|json!({"kind":location.kind,"bytes":location.size_bytes,"itemCount":location.item_count,"safety":location.safety})).collect::<Vec<_>>(),
        "items":items,"coverage":"Metadata-only scan of common locations, not the entire disk. Missing access is not evidence of empty folders. Items are inspection candidates, not automatically safe to delete. Trash may not immediately reclaim space."}),
    )
}
fn collect_candidates<'a>(node: &'a CleanupNode, out: &mut Vec<&'a CleanupNode>) {
    if !node.deletion_protected
        && node.path.is_some()
        && matches!(node.kind, CleanupNodeKind::File | CleanupNodeKind::Folder)
        && node.children.is_empty()
    {
        out.push(node);
    }
    for child in &node.children {
        collect_candidates(child, out);
    }
}

async fn process_action(
    app: &AppHandle,
    context: &ToolContext,
    args: ProcessActionArgs,
) -> Result<Value, AiError> {
    let NativeTarget::Process { key, name } = target(context, &args.target_ref)? else {
        return Err(target_missing());
    };
    let controller = app.state::<AppState>().process_controller.clone();
    let request = ProcessControlLeaseRequest {
        key: key.clone(),
        action: args.action,
        acknowledge_best_effort: true,
    };
    let lease = crate::with_process_controller(controller.clone(), move |controller| {
        controller.create_lease(request)
    })
    .await
    .map_err(error)?;
    let confirmation=ToolConfirmation{action:if args.action==ProcessAction::ForceKill{"force_kill"}else{"request_close"}.into(),targets:vec![format!("{name} · PID {}",key.pid)],
        detail:"Unsaved work may be lost. The native controller will re-check this process identity. A close request does not guarantee exit.".into(),expires_at:lease.expires_at_ms};
    let approved = context.confirm(confirmation).await;
    if let Err(error) = approved {
        let id = lease.id;
        let _ = crate::with_process_controller(controller, move |controller| {
            controller.release_lease(ProcessControlLeaseReleaseRequest { lease_id: id });
            Ok(())
        })
        .await;
        return Err(error);
    }
    let lease_id = lease.id.clone();
    let request = ProcessActionRequest {
        key,
        action: args.action,
        lease_id: lease.id,
    };
    let worker_context = context.clone();
    let result = crate::with_process_controller(controller.clone(), move |controller| {
        worker_context
            .check_active()
            .map_err(|error| crate::error::CommandError::new(error.code, error.message))?;
        controller.execute_action(request)
    })
    .await
    .map_err(error);
    let _ = crate::with_process_controller(controller, move |controller| {
        controller.release_lease(ProcessControlLeaseReleaseRequest { lease_id });
        Ok(())
    })
    .await;
    let result = result?;
    if result.signal_sent {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            app.state::<AppState>()
                .sampler
                .refresh_after_process_action(&app);
        })
        .await;
    }
    serde_json::to_value(result).map_err(AiError::storage)
}

async fn cleanup(
    app: &AppHandle,
    context: &ToolContext,
    args: CleanupArgs,
) -> Result<Value, AiError> {
    let NativeTarget::Cleanup(request) = target(context, &args.target_ref)? else {
        return Err(target_missing());
    };
    let mut request = *request;
    if request.scan_id.is_some() {
        let index = crate::cleanup_scan_index_path(app).map_err(error)?;
        request = tauri::async_runtime::spawn_blocking(move || {
            let latest = crate::cleanup::load_latest_indexed_scan(&index)
                .map_err(error)?
                .ok_or_else(target_missing)?;
            if request.scan_id.as_deref() != Some(latest.scan_id.as_str())
                || request.scan_sampled_at_ms != latest.sampled_at_ms
            {
                return Err(crate::ai::capability_actions::expired());
            }
            crate::cleanup::resolve_indexed_delete_request(&index, request).map_err(error)
        })
        .await
        .map_err(|_| unavailable())??;
    }
    let indexed_targets = request.scan_id.clone().map(|scan_id| {
        (
            scan_id,
            request.directory_ids.clone(),
            request.paths.clone(),
        )
    });
    let controller = app.state::<AppState>().cleanup_delete_controller.clone();
    let lease = crate::with_cleanup_delete_controller(controller.clone(), move |controller| {
        controller.create_lease(request)
    })
    .await
    .map_err(error)?;
    let lease_id = lease.id.clone();
    let outcome=async {
        if !lease.executable{return Err(AiError::new("target_changed","The selected item changed, is protected, or is unavailable. Inspect it again before cleanup."));}
        context.confirm(ToolConfirmation{action:"trash".into(),targets:lease.paths.clone(),detail:"Move these exact items to the system trash. This can affect applications and may not immediately free disk space. Permanent deletion is not available.".into(),expires_at:crate::now_millis()+60_000}).await?;
        context.check_active()?;
        let coordinator=app.state::<AppState>().cleanup_delete.clone();
        let operation_cancel=coordinator.begin().map_err(error)?;
        let cancel_guard=CancelFlag(operation_cancel.clone());
        let worker_cancel=operation_cancel.clone();
        let worker_controller=controller.clone();
        let worker_id=lease_id.clone();
        let worker_context=context.clone();
        let worker_app=app.clone();
        let operation = DeleteOperation { coordinator: coordinator.clone(), cancelled: operation_cancel.clone() };
        let task=tauri::async_runtime::spawn_blocking(move||{
            let _operation = operation;
            let mut controller=worker_controller.lock().map_err(|_|unavailable())?;
            worker_context.check_active()?;
            let result = controller.execute_cancellable(CleanupDeleteExecutionRequest{lease_id:worker_id},&worker_cancel,&mut |_|{}).map_err(error)?;
            drop(controller);
            // Reconcile actual changes inside the worker, even if its caller
            // was cancelled. Failed and skipped entries stay in the index.
            let mut index_updated = true;
            if !result.deleted.is_empty() {
                if let Some((scan_id, ids, paths)) = indexed_targets {
                    let deleted_ids = ids.into_iter().zip(paths).filter_map(|(id, path)|
                        result.deleted.iter().any(|deleted| deleted.path == path).then_some(id)).collect::<Vec<_>>();
                    if !deleted_ids.is_empty() {
                        index_updated = crate::cleanup_scan_index_path(&worker_app).and_then(|index|
                            crate::cleanup::apply_indexed_deletions(&index, &scan_id, &deleted_ids)).is_ok();
                    }
                }
                let results = &worker_app.state::<AppState>().application_results;
                if index_updated { results.disk_changed(); } else { results.disk_invalidated(); }
            }
            Ok((result, index_updated))
        });
        let result=crate::ai::transport::cancellable(context.cancelled.clone(),120,async{task.await.map_err(|_|unavailable())?}).await;
        drop(cancel_guard);
        let (result, index_updated)=result?;
        let _=crate::with_monitor(app.state::<AppState>().monitor.clone(),|monitor|{monitor.request_volume_catalog_refresh();Ok(())}).await;
        Ok(json!({"mode":"trash","indexUpdated":index_updated,
            "deleted":result.deleted.iter().map(|item|json!({"name":file_name(&item.path),"deletedBytes":item.deleted_bytes})).collect::<Vec<_>>(),
            "failed":result.failed.iter().map(|item|json!({"name":file_name(&item.path)})).collect::<Vec<_>>(),"cancelled":result.cancelled,
            "note":"This is the actual native result. Moving files to trash does not guarantee reclaimed disk space."}))
    }.await;
    let _ = crate::with_cleanup_delete_controller(controller, move |controller| {
        controller.release_lease(&lease_id);
        Ok(())
    })
    .await;
    outcome
}

fn file_name(path: &str) -> String {
    clean(
        std::path::Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("item"),
        120,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};
    #[test]
    fn targets_are_native_generated_and_cannot_cross_task_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let context = ToolContext {
            service: Arc::new(AiService::open(directory.path().join("ai.sqlite")).unwrap()),
            request_id: "run-1".into(),
            step_id: "step-1".into(),
            scope: ToolScope {
                include_context: true,
                scenario: "current_status".into(),
                incident_id: None,
                from_ms: None,
                to_ms: None,
            },
            cancelled: Arc::new(AtomicBool::new(false)),
            targets: Arc::new(Mutex::new(HashMap::new())),
        };
        let reference = remember(
            &context,
            NativeTarget::Process {
                key: ProcessKey {
                    pid: 999999,
                    birth_token: "synthetic-birth".into(),
                },
                name: "Synthetic app".into(),
            },
        )
        .unwrap();
        assert!(
            matches!(target(&context, &reference), Ok(NativeTarget::Process { key, .. }) if key.pid == 999999 && key.birth_token == "synthetic-birth")
        );
        assert!(target(&context, "999999").is_err());
        assert!(target(&context, "/synthetic/item").is_err());
        let next = ToolContext {
            request_id: "run-2".into(),
            targets: Arc::new(Mutex::new(HashMap::new())),
            ..context
        };
        assert!(target(&next, &reference).is_err());
    }
}
