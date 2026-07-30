use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::cleanup::{
    CleanupScanSegmentPlan, assemble_cleanup_scan_segments, cleanup_scan_segment_plan,
    save_cleanup_scan_snapshot_cache, scan_cleanup_segment,
};
use crate::error::CommandError;
use crate::models::{
    CleanupScan, CleanupScanJobPhase, CleanupScanJobStatus, CleanupScanProgress, CleanupScanRequest,
};
use crate::private_storage;

const WORKER_ARGUMENT: &str = "--cleanup-scan-worker";
const WORKER_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
const MANAGER_WATCH_INTERVAL: Duration = Duration::from_millis(250);
const HEARTBEAT_MISSING_AFTER: Duration = Duration::from_secs(5);
const STALLED_AFTER: Duration = Duration::from_secs(30);
const FORCE_CANCEL_AFTER: Duration = Duration::from_secs(2);
const MAX_JOB_FILE_BYTES: u64 = 64 * 1_024 * 1_024;
const CHECKPOINT_VERSION: u8 = 1;
const CHECKPOINT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug)]
struct CleanupScanJobRuntime {
    status: CleanupScanJobStatus,
    child: Option<Arc<Mutex<Child>>>,
    request_path: PathBuf,
    result_path: PathBuf,
    cancel_requested_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct CleanupScanJobManager {
    generation: AtomicU64,
    active: Mutex<Option<CleanupScanJobRuntime>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CleanupScanWorkerEvent {
    Heartbeat {
        at_ms: u64,
    },
    Progress {
        at_ms: u64,
        progress: CleanupScanProgress,
    },
    Completed {
        at_ms: u64,
    },
    Failed {
        at_ms: u64,
        code: String,
        message: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupScanCheckpoint {
    version: u8,
    saved_at_ms: u64,
    request: CleanupScanRequest,
    completed_segments: Vec<CleanupScanCompletedSegment>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupScanCompletedSegment {
    path: String,
    modified_at_ms: Option<u64>,
    scan: CleanupScan,
}

impl CleanupScanJobManager {
    pub fn start(
        self: &Arc<Self>,
        request: CleanupScanRequest,
        job_directory: &Path,
        cache_path: &Path,
    ) -> Result<CleanupScanJobStatus, CommandError> {
        self.terminate_active_for_replacement();

        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let started_at_ms = now_millis();
        let job_id = format!("cleanup-{started_at_ms}-{generation}");
        let request_path = job_directory.join(format!("{job_id}.request.json"));
        let result_path = job_directory.join(format!("{job_id}.result.json"));
        let request_bytes = serde_json::to_vec(&request).map_err(|error| {
            CommandError::internal(format!(
                "Could not encode the cleanup scan request: {error}"
            ))
        })?;
        private_storage::write_atomic(&request_path, &request_bytes).map_err(|error| {
            CommandError::internal(format!(
                "Could not prepare the cleanup scan worker request: {error}"
            ))
        })?;
        let checkpoint_path = cleanup_scan_checkpoint_path(job_directory, &request_bytes);

        let mut command = Command::new(std::env::current_exe().map_err(|error| {
            CommandError::internal(format!(
                "Could not locate the cleanup scan worker executable: {error}"
            ))
        })?);
        command
            .arg(WORKER_ARGUMENT)
            .arg(&request_path)
            .arg(&result_path)
            .arg(cache_path)
            .arg(&checkpoint_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|error| {
            CommandError::internal(format!("Could not start the cleanup scan worker: {error}"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CommandError::internal("The cleanup scan worker did not expose a progress channel.")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            CommandError::internal("The cleanup scan worker did not expose an error channel.")
        })?;
        let child = Arc::new(Mutex::new(child));
        let status = CleanupScanJobStatus {
            job_id: job_id.clone(),
            generation,
            phase: CleanupScanJobPhase::Preparing,
            started_at_ms,
            updated_at_ms: started_at_ms,
            last_heartbeat_at_ms: None,
            last_progress_at_ms: None,
            progress: CleanupScanProgress {
                scanned_entry_count: 0,
                discovered_bytes: 0,
                current_path: "~".to_owned(),
                elapsed_ms: 0,
            },
            target: request,
            result_available: false,
            error_code: None,
            error_message: None,
        };
        {
            let mut active = self.active.lock().map_err(|_| {
                CommandError::internal("The cleanup scan job state lock was poisoned.")
            })?;
            *active = Some(CleanupScanJobRuntime {
                status: status.clone(),
                child: Some(Arc::clone(&child)),
                request_path,
                result_path,
                cancel_requested_at_ms: None,
            });
        }

        self.start_event_reader(
            job_id.clone(),
            generation,
            stdout,
            stderr,
            Arc::clone(&child),
        );
        self.start_watchdog(job_id, generation);
        Ok(status)
    }

    pub fn status(&self) -> Result<Option<CleanupScanJobStatus>, CommandError> {
        self.active
            .lock()
            .map(|active| active.as_ref().map(|job| job.status.clone()))
            .map_err(|_| CommandError::internal("The cleanup scan job state lock was poisoned."))
    }

    pub fn result(&self, job_id: &str) -> Result<CleanupScan, CommandError> {
        let result_path = {
            let active = self.active.lock().map_err(|_| {
                CommandError::internal("The cleanup scan job state lock was poisoned.")
            })?;
            let job = active.as_ref().ok_or_else(|| {
                CommandError::new(
                    "cleanup_scan_job_missing",
                    "The cleanup scan is no longer available.",
                )
            })?;
            if job.status.job_id != job_id {
                return Err(CommandError::new(
                    "cleanup_scan_job_replaced",
                    "A newer cleanup scan has replaced this scan.",
                ));
            }
            if job.status.phase != CleanupScanJobPhase::Completed || !job.status.result_available {
                return Err(CommandError::new(
                    "cleanup_scan_result_unavailable",
                    "The cleanup scan result is not ready yet.",
                ));
            }
            job.result_path.clone()
        };
        let bytes = private_storage::read_limited(&result_path, MAX_JOB_FILE_BYTES)
            .map_err(|error| {
                CommandError::internal(format!("Could not read the cleanup scan result: {error}"))
            })?
            .ok_or_else(|| {
                CommandError::new(
                    "cleanup_scan_result_missing",
                    "The completed cleanup scan result is no longer available.",
                )
            })?;
        serde_json::from_slice(&bytes).map_err(|error| {
            CommandError::internal(format!("Could not decode the cleanup scan result: {error}"))
        })
    }

    pub fn cancel(self: &Arc<Self>) -> Result<bool, CommandError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| CommandError::internal("The cleanup scan job state lock was poisoned."))?;
        let Some(job) = active.as_mut() else {
            return Ok(false);
        };
        if job.status.phase.is_terminal() {
            return Ok(false);
        }
        let now = now_millis();
        job.status.phase = CleanupScanJobPhase::Cancelling;
        job.status.updated_at_ms = now;
        job.cancel_requested_at_ms = Some(now);
        if let Some(child) = job.child.as_ref()
            && let Ok(mut child) = child.lock()
            && let Some(stdin) = child.stdin.as_mut()
        {
            let _ = stdin.write_all(b"cancel\n");
            let _ = stdin.flush();
        }
        Ok(true)
    }

    fn terminate_active_for_replacement(&self) {
        let previous = self.active.lock().ok().and_then(|mut active| active.take());
        let Some(mut previous) = previous else {
            return;
        };
        if let Some(child) = previous.child.take() {
            kill_worker(&child);
        }
        let _ = private_storage::remove(&previous.request_path);
        let _ = private_storage::remove(&previous.result_path);
    }

    fn start_event_reader(
        self: &Arc<Self>,
        job_id: String,
        generation: u64,
        stdout: impl io::Read + Send + 'static,
        stderr: impl io::Read + Send + 'static,
        child: Arc<Mutex<Child>>,
    ) {
        let manager = Arc::clone(self);
        let error_output = Arc::new(Mutex::new(String::new()));
        let error_writer = Arc::clone(&error_output);
        thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr)
                .take(64 * 1_024)
                .read_to_string(&mut text);
            if let Ok(mut output) = error_writer.lock() {
                *output = text;
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let Ok(event) = serde_json::from_str::<CleanupScanWorkerEvent>(&line) else {
                    continue;
                };
                manager.apply_worker_event(&job_id, generation, event);
            }
            let exit_status = child.lock().ok().and_then(|mut child| child.wait().ok());
            manager.finish_worker(
                &job_id,
                generation,
                exit_status.and_then(|status| status.code()),
                error_output
                    .lock()
                    .ok()
                    .map(|output| output.clone())
                    .unwrap_or_default(),
            );
        });
    }

    fn start_watchdog(self: &Arc<Self>, job_id: String, generation: u64) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            loop {
                thread::sleep(MANAGER_WATCH_INTERVAL);
                let action = {
                    let Ok(mut active) = manager.active.lock() else {
                        return;
                    };
                    let Some(job) = active.as_mut() else {
                        return;
                    };
                    if job.status.job_id != job_id || job.status.generation != generation {
                        return;
                    }
                    if job.status.phase.is_terminal() {
                        return;
                    }
                    let now = now_millis();
                    if let Some(cancelled_at) = job.cancel_requested_at_ms
                        && now.saturating_sub(cancelled_at) >= FORCE_CANCEL_AFTER.as_millis() as u64
                    {
                        Some((Arc::clone(job.child.as_ref().expect("active worker")), true))
                    } else {
                        let heartbeat_at = job
                            .status
                            .last_heartbeat_at_ms
                            .unwrap_or(job.status.started_at_ms);
                        let progress_at = job
                            .status
                            .last_progress_at_ms
                            .unwrap_or(job.status.started_at_ms);
                        if now.saturating_sub(heartbeat_at)
                            >= HEARTBEAT_MISSING_AFTER.as_millis() as u64
                        {
                            job.status.phase = CleanupScanJobPhase::Paused;
                            job.status.updated_at_ms = now;
                        } else if now.saturating_sub(progress_at)
                            >= STALLED_AFTER.as_millis() as u64
                        {
                            job.status.phase = CleanupScanJobPhase::Stalled;
                            job.status.updated_at_ms = now;
                        }
                        None
                    }
                };
                if let Some((child, cancelled)) = action {
                    kill_worker(&child);
                    if cancelled {
                        manager.mark_cancelled(&job_id, generation);
                    }
                    return;
                }
            }
        });
    }

    fn apply_worker_event(&self, job_id: &str, generation: u64, event: CleanupScanWorkerEvent) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(job) = active.as_mut() else {
            return;
        };
        if job.status.job_id != job_id || job.status.generation != generation {
            return;
        }
        match event {
            CleanupScanWorkerEvent::Heartbeat { at_ms } => {
                let resumed_after_pause = job.status.phase == CleanupScanJobPhase::Paused;
                if job.status.phase == CleanupScanJobPhase::Preparing || resumed_after_pause {
                    job.status.phase = CleanupScanJobPhase::Scanning;
                }
                if resumed_after_pause {
                    job.status.last_progress_at_ms = Some(at_ms);
                }
                job.status.updated_at_ms = at_ms;
                job.status.last_heartbeat_at_ms = Some(at_ms);
            }
            CleanupScanWorkerEvent::Progress { at_ms, progress } => {
                if job.status.phase != CleanupScanJobPhase::Cancelling {
                    job.status.phase = CleanupScanJobPhase::Scanning;
                }
                job.status.updated_at_ms = at_ms;
                job.status.last_heartbeat_at_ms = Some(at_ms);
                job.status.last_progress_at_ms = Some(at_ms);
                job.status.progress = progress;
            }
            CleanupScanWorkerEvent::Completed { at_ms } => {
                job.status.phase = CleanupScanJobPhase::Completed;
                job.status.updated_at_ms = at_ms;
                job.status.result_available = true;
            }
            CleanupScanWorkerEvent::Failed {
                at_ms,
                code,
                message,
            } => {
                job.status.phase = if code == "cleanup_scan_cancelled" {
                    CleanupScanJobPhase::Cancelled
                } else {
                    CleanupScanJobPhase::Failed
                };
                job.status.updated_at_ms = at_ms;
                job.status.error_code = Some(code);
                job.status.error_message = Some(message);
            }
        }
    }

    fn finish_worker(&self, job_id: &str, generation: u64, exit_code: Option<i32>, stderr: String) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(job) = active.as_mut() else {
            return;
        };
        if job.status.job_id != job_id || job.status.generation != generation {
            return;
        }
        job.child = None;
        if !job.status.phase.is_terminal() {
            let was_cancelling = job.status.phase == CleanupScanJobPhase::Cancelling;
            job.status.phase = if was_cancelling {
                CleanupScanJobPhase::Cancelled
            } else {
                CleanupScanJobPhase::Failed
            };
            job.status.updated_at_ms = now_millis();
            if !was_cancelling {
                job.status.error_code = Some("cleanup_scan_worker_exited".to_owned());
                job.status.error_message = Some(if stderr.trim().is_empty() {
                    format!(
                        "The cleanup scan worker stopped unexpectedly (exit code {}).",
                        exit_code
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "unknown".to_owned())
                    )
                } else {
                    stderr.trim().to_owned()
                });
            }
        }
        let _ = private_storage::remove(&job.request_path);
    }

    fn mark_cancelled(&self, job_id: &str, generation: u64) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(job) = active.as_mut() else {
            return;
        };
        if job.status.job_id == job_id && job.status.generation == generation {
            job.status.phase = CleanupScanJobPhase::Cancelled;
            job.status.updated_at_ms = now_millis();
            job.child = None;
        }
    }
}

fn kill_worker(child: &Arc<Mutex<Child>>) {
    let Ok(mut child) = child.lock() else {
        return;
    };
    #[cfg(unix)]
    {
        let process_group = -(child.id() as i32);
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn maybe_run_worker() -> bool {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    let Some(index) = arguments
        .iter()
        .position(|argument| argument == WORKER_ARGUMENT)
    else {
        return false;
    };
    let Some(request_path) = arguments.get(index + 1).map(PathBuf::from) else {
        return true;
    };
    let Some(result_path) = arguments.get(index + 2).map(PathBuf::from) else {
        return true;
    };
    let Some(cache_path) = arguments.get(index + 3).map(PathBuf::from) else {
        return true;
    };
    let Some(checkpoint_path) = arguments.get(index + 4).map(PathBuf::from) else {
        return true;
    };
    run_worker(&request_path, &result_path, &cache_path, &checkpoint_path);
    true
}

fn run_worker(request_path: &Path, result_path: &Path, cache_path: &Path, checkpoint_path: &Path) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicBool::new(false));
    start_worker_control(Arc::clone(&cancelled), Arc::clone(&completed));
    start_worker_heartbeat(Arc::clone(&completed));
    #[cfg(debug_assertions)]
    if let Some(delay_ms) = std::env::var("CORE_ROBIN_TEST_BLOCK_CLEANUP_WORKER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        thread::sleep(Duration::from_millis(delay_ms));
    }

    let result = (|| {
        let request = private_storage::read_limited(request_path, 64 * 1_024)
            .map_err(|error| {
                CommandError::internal(format!("Could not read the scan request: {error}"))
            })?
            .ok_or_else(|| {
                CommandError::new(
                    "cleanup_scan_request_missing",
                    "The cleanup scan request is no longer available.",
                )
            })
            .and_then(|bytes| {
                serde_json::from_slice::<CleanupScanRequest>(&bytes).map_err(|error| {
                    CommandError::internal(format!("Could not decode the scan request: {error}"))
                })
            })?;
        let plan = cleanup_scan_segment_plan(request.clone(), &cancelled)?;
        let mut completed_segments = load_checkpoint(checkpoint_path, &plan);
        let mut completed_paths = completed_segments
            .iter()
            .map(|segment| segment.path.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut base_entries = completed_segments.iter().fold(0_usize, |total, segment| {
            total.saturating_add(segment.scan.scanned_entry_count)
        });
        let mut base_bytes = completed_segments.iter().fold(0_u64, |total, segment| {
            total.saturating_add(segment.scan.root.allocated_size_bytes)
        });
        for segment_path in &plan.segment_paths {
            ensure_worker_active(&cancelled)?;
            let path = segment_path.to_string_lossy().into_owned();
            if completed_paths.contains(&path) {
                continue;
            }
            let scan =
                scan_cleanup_segment(&plan, segment_path, &cancelled, &mut |mut progress| {
                    progress.scanned_entry_count =
                        base_entries.saturating_add(progress.scanned_entry_count);
                    progress.discovered_bytes =
                        base_bytes.saturating_add(progress.discovered_bytes);
                    emit_worker_event(&CleanupScanWorkerEvent::Progress {
                        at_ms: now_millis(),
                        progress,
                    });
                })?;
            base_entries = base_entries.saturating_add(scan.scanned_entry_count);
            base_bytes = base_bytes.saturating_add(scan.root.allocated_size_bytes);
            completed_paths.insert(path.clone());
            completed_segments.push(CleanupScanCompletedSegment {
                path,
                modified_at_ms: path_modified_at_ms(segment_path),
                scan,
            });
            save_checkpoint(checkpoint_path, &request, &completed_segments)?;
            #[cfg(debug_assertions)]
            if std::env::var("CORE_ROBIN_TEST_STOP_AFTER_CLEANUP_SEGMENTS")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                == Some(completed_segments.len())
            {
                return Err(CommandError::new(
                    "cleanup_scan_test_interrupted",
                    "The cleanup scan worker was interrupted after a completed segment.",
                ));
            }
        }
        let scan = assemble_cleanup_scan_segments(
            &plan,
            completed_segments
                .iter()
                .map(|segment| segment.scan.clone())
                .collect(),
            &cancelled,
            &mut |progress| {
                emit_worker_event(&CleanupScanWorkerEvent::Progress {
                    at_ms: now_millis(),
                    progress,
                });
            },
        )?;
        let bytes = serde_json::to_vec(&scan).map_err(|error| {
            CommandError::internal(format!("Could not encode the cleanup scan result: {error}"))
        })?;
        private_storage::write_atomic(result_path, &bytes).map_err(|error| {
            CommandError::internal(format!("Could not save the cleanup scan result: {error}"))
        })?;
        save_cleanup_scan_snapshot_cache(cache_path, &scan)?;
        let _ = private_storage::remove(checkpoint_path);
        Ok::<(), CommandError>(())
    })();

    completed.store(true, Ordering::Relaxed);
    match result {
        Ok(()) => emit_worker_event(&CleanupScanWorkerEvent::Completed {
            at_ms: now_millis(),
        }),
        Err(error) => emit_worker_event(&CleanupScanWorkerEvent::Failed {
            at_ms: now_millis(),
            code: error.code,
            message: error.message,
        }),
    }
}

fn cleanup_scan_checkpoint_path(job_directory: &Path, request_bytes: &[u8]) -> PathBuf {
    let digest = Sha256::digest(request_bytes);
    let key = digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    job_directory.join(format!("checkpoint-{key}.json"))
}

fn load_checkpoint(
    checkpoint_path: &Path,
    plan: &CleanupScanSegmentPlan,
) -> Vec<CleanupScanCompletedSegment> {
    let Ok(Some(bytes)) = private_storage::read_limited(checkpoint_path, MAX_JOB_FILE_BYTES) else {
        return Vec::new();
    };
    let Ok(mut checkpoint) = serde_json::from_slice::<CleanupScanCheckpoint>(&bytes) else {
        let _ = private_storage::remove(checkpoint_path);
        return Vec::new();
    };
    if checkpoint.version != CHECKPOINT_VERSION
        || checkpoint.request != plan.request
        || now_millis().saturating_sub(checkpoint.saved_at_ms)
            > CHECKPOINT_MAX_AGE.as_millis() as u64
    {
        let _ = private_storage::remove(checkpoint_path);
        return Vec::new();
    }
    let planned = plan
        .segment_paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<std::collections::HashSet<_>>();
    checkpoint.completed_segments.retain(|segment| {
        planned.contains(&segment.path)
            && path_modified_at_ms(Path::new(&segment.path)) == segment.modified_at_ms
    });
    checkpoint.completed_segments
}

fn save_checkpoint(
    checkpoint_path: &Path,
    request: &CleanupScanRequest,
    completed_segments: &[CleanupScanCompletedSegment],
) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(&CleanupScanCheckpoint {
        version: CHECKPOINT_VERSION,
        saved_at_ms: now_millis(),
        request: request.clone(),
        completed_segments: completed_segments
            .iter()
            .map(|segment| CleanupScanCompletedSegment {
                path: segment.path.clone(),
                modified_at_ms: segment.modified_at_ms,
                scan: segment.scan.clone(),
            })
            .collect(),
    })
    .map_err(|error| {
        CommandError::internal(format!(
            "Could not encode the cleanup scan checkpoint: {error}"
        ))
    })?;
    if bytes.len() as u64 > MAX_JOB_FILE_BYTES {
        return Err(CommandError::new(
            "cleanup_scan_checkpoint_too_large",
            "The cleanup scan checkpoint became too large to save safely.",
        ));
    }
    private_storage::write_atomic(checkpoint_path, &bytes).map_err(|error| {
        CommandError::internal(format!(
            "Could not save the cleanup scan checkpoint: {error}"
        ))
    })
}

fn path_modified_at_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn ensure_worker_active(cancelled: &AtomicBool) -> Result<(), CommandError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(CommandError::new(
            "cleanup_scan_cancelled",
            "The cleanup scan was cancelled.",
        ))
    } else {
        Ok(())
    }
}

fn start_worker_control(cancelled: Arc<AtomicBool>, completed: Arc<AtomicBool>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) if line.trim() == "cancel" => {
                    cancelled.store(true, Ordering::Relaxed);
                }
                Ok(_) => {}
                Err(_) => break,
            }
            if completed.load(Ordering::Relaxed) {
                return;
            }
        }
        if !completed.load(Ordering::Relaxed) {
            std::process::exit(0);
        }
    });
}

fn start_worker_heartbeat(completed: Arc<AtomicBool>) {
    thread::spawn(move || {
        while !completed.load(Ordering::Relaxed) {
            emit_worker_event(&CleanupScanWorkerEvent::Heartbeat {
                at_ms: now_millis(),
            });
            thread::sleep(WORKER_HEARTBEAT_INTERVAL);
        }
    });
}

fn emit_worker_event(event: &CleanupScanWorkerEvent) {
    static OUTPUT_LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = OUTPUT_LOCK.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_string(event) else {
        return;
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{serialized}");
    let _ = stdout.flush();
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_with_phase(phase: CleanupScanJobPhase) -> CleanupScanJobManager {
        let now = now_millis();
        let manager = CleanupScanJobManager::default();
        *manager.active.lock().unwrap() = Some(CleanupScanJobRuntime {
            status: CleanupScanJobStatus {
                job_id: "fixture".to_owned(),
                generation: 1,
                phase,
                started_at_ms: now.saturating_sub(60_000),
                updated_at_ms: now.saturating_sub(60_000),
                last_heartbeat_at_ms: Some(now.saturating_sub(60_000)),
                last_progress_at_ms: Some(now.saturating_sub(60_000)),
                progress: CleanupScanProgress {
                    scanned_entry_count: 0,
                    discovered_bytes: 0,
                    current_path: "/fixture".to_owned(),
                    elapsed_ms: 0,
                },
                target: CleanupScanRequest::default(),
                result_available: false,
                error_code: None,
                error_message: None,
            },
            child: None,
            request_path: PathBuf::from("/fixture/request"),
            result_path: PathBuf::from("/fixture/result"),
            cancel_requested_at_ms: None,
        });
        manager
    }

    #[test]
    fn worker_events_round_trip() {
        let event = CleanupScanWorkerEvent::Progress {
            at_ms: 42,
            progress: CleanupScanProgress {
                scanned_entry_count: 7,
                discovered_bytes: 11,
                current_path: "/fixture".to_owned(),
                elapsed_ms: 13,
            },
        };
        let serialized = serde_json::to_string(&event).unwrap();
        let decoded: CleanupScanWorkerEvent = serde_json::from_str(&serialized).unwrap();
        assert!(matches!(
            decoded,
            CleanupScanWorkerEvent::Progress { at_ms: 42, .. }
        ));
    }

    #[test]
    fn terminal_job_phases_are_explicit() {
        assert!(CleanupScanJobPhase::Cancelled.is_terminal());
        assert!(CleanupScanJobPhase::Completed.is_terminal());
        assert!(CleanupScanJobPhase::Failed.is_terminal());
        assert!(!CleanupScanJobPhase::Scanning.is_terminal());
        assert!(!CleanupScanJobPhase::Stalled.is_terminal());
    }

    #[test]
    fn heartbeat_after_sleep_resets_the_stall_window() {
        let manager = manager_with_phase(CleanupScanJobPhase::Paused);
        let resumed_at = now_millis();

        manager.apply_worker_event(
            "fixture",
            1,
            CleanupScanWorkerEvent::Heartbeat { at_ms: resumed_at },
        );

        let status = manager.status().unwrap().unwrap();
        assert_eq!(status.phase, CleanupScanJobPhase::Scanning);
        assert_eq!(status.last_heartbeat_at_ms, Some(resumed_at));
        assert_eq!(status.last_progress_at_ms, Some(resumed_at));
    }

    #[test]
    fn late_progress_does_not_hide_a_pending_cancellation() {
        let manager = manager_with_phase(CleanupScanJobPhase::Cancelling);
        manager.apply_worker_event(
            "fixture",
            1,
            CleanupScanWorkerEvent::Progress {
                at_ms: now_millis(),
                progress: CleanupScanProgress {
                    scanned_entry_count: 1,
                    discovered_bytes: 2,
                    current_path: "/fixture/child".to_owned(),
                    elapsed_ms: 3,
                },
            },
        );

        assert_eq!(
            manager.status().unwrap().unwrap().phase,
            CleanupScanJobPhase::Cancelling
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_an_unresponsive_worker_forces_it_to_exit() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);
        let child = Arc::new(Mutex::new(command.spawn().unwrap()));
        let manager = Arc::new(CleanupScanJobManager::default());
        let now = now_millis();
        *manager.active.lock().unwrap() = Some(CleanupScanJobRuntime {
            status: CleanupScanJobStatus {
                job_id: "fixture".to_owned(),
                generation: 1,
                phase: CleanupScanJobPhase::Scanning,
                started_at_ms: now,
                updated_at_ms: now,
                last_heartbeat_at_ms: Some(now),
                last_progress_at_ms: Some(now),
                progress: CleanupScanProgress {
                    scanned_entry_count: 0,
                    discovered_bytes: 0,
                    current_path: "/fixture".to_owned(),
                    elapsed_ms: 0,
                },
                target: CleanupScanRequest::default(),
                result_available: false,
                error_code: None,
                error_message: None,
            },
            child: Some(Arc::clone(&child)),
            request_path: PathBuf::from("/fixture/request"),
            result_path: PathBuf::from("/fixture/result"),
            cancel_requested_at_ms: None,
        });
        manager.start_watchdog("fixture".to_owned(), 1);
        assert!(manager.cancel().unwrap());
        thread::sleep(FORCE_CANCEL_AFTER + Duration::from_millis(750));

        assert_eq!(
            manager.status().unwrap().unwrap().phase,
            CleanupScanJobPhase::Cancelled
        );
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
    }
}
