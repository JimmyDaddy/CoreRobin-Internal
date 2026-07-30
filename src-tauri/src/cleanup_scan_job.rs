use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
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
const AUTO_RECOVER_AFTER: Duration = Duration::from_secs(120);
const MAX_AUTO_RECOVERIES: usize = 12;
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
    cache_path: PathBuf,
    checkpoint_path: PathBuf,
    exclusions_path: PathBuf,
    worker_attempt: u64,
    skipped_paths: Vec<String>,
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
    Activity {
        at_ms: u64,
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

enum CleanupScanWatchdogAction {
    Cancel(Arc<Mutex<Child>>),
    Recover {
        child: Arc<Mutex<Child>>,
        next_attempt: u64,
    },
    Exhausted(Arc<Mutex<Child>>),
}

fn spawn_worker_process(
    request_path: &Path,
    result_path: &Path,
    cache_path: &Path,
    checkpoint_path: &Path,
    exclusions_path: &Path,
) -> Result<(Arc<Mutex<Child>>, ChildStdout, ChildStderr), CommandError> {
    let mut command = Command::new(std::env::current_exe().map_err(|error| {
        CommandError::internal(format!(
            "Could not locate the cleanup scan worker executable: {error}"
        ))
    })?);
    command
        .arg(WORKER_ARGUMENT)
        .arg(request_path)
        .arg(result_path)
        .arg(cache_path)
        .arg(checkpoint_path)
        .arg(exclusions_path)
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
    Ok((Arc::new(Mutex::new(child)), stdout, stderr))
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
        let exclusions_path = job_directory.join(format!("{job_id}.exclusions.json"));
        save_worker_exclusions(&exclusions_path, &[])?;

        let (child, stdout, stderr) = spawn_worker_process(
            &request_path,
            &result_path,
            cache_path,
            &checkpoint_path,
            &exclusions_path,
        )?;
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
                cache_path: cache_path.to_path_buf(),
                checkpoint_path,
                exclusions_path,
                worker_attempt: 1,
                skipped_paths: Vec::new(),
                cancel_requested_at_ms: None,
            });
        }

        self.start_event_reader(
            job_id.clone(),
            generation,
            1,
            stdout,
            stderr,
            Arc::clone(&child),
        );
        self.start_watchdog(job_id, generation, 1);
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
        if job.child.is_none() {
            job.status.phase = CleanupScanJobPhase::Cancelled;
            let _ = private_storage::remove(&job.request_path);
            let _ = private_storage::remove(&job.exclusions_path);
            return Ok(true);
        }
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
        let _ = private_storage::remove(&previous.exclusions_path);
    }

    fn start_event_reader(
        self: &Arc<Self>,
        job_id: String,
        generation: u64,
        worker_attempt: u64,
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
                manager.apply_worker_event(&job_id, generation, worker_attempt, event);
            }
            let exit_status = child.lock().ok().and_then(|mut child| child.wait().ok());
            manager.finish_worker(
                &job_id,
                generation,
                worker_attempt,
                exit_status.and_then(|status| status.code()),
                error_output
                    .lock()
                    .ok()
                    .map(|output| output.clone())
                    .unwrap_or_default(),
            );
        });
    }

    fn start_watchdog(self: &Arc<Self>, job_id: String, generation: u64, worker_attempt: u64) {
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
                    if job.status.job_id != job_id
                        || job.status.generation != generation
                        || job.worker_attempt != worker_attempt
                    {
                        return;
                    }
                    if job.status.phase.is_terminal() {
                        return;
                    }
                    let now = now_millis();
                    if let Some(cancelled_at) = job.cancel_requested_at_ms
                        && now.saturating_sub(cancelled_at) >= FORCE_CANCEL_AFTER.as_millis() as u64
                    {
                        job.child.take().map(CleanupScanWatchdogAction::Cancel)
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
                            None
                        } else if now.saturating_sub(progress_at)
                            >= AUTO_RECOVER_AFTER.as_millis() as u64
                        {
                            job.status.phase = CleanupScanJobPhase::Stalled;
                            job.status.updated_at_ms = now;
                            let recovery_path = next_recovery_path(
                                &job.status.progress.current_path,
                                &job.skipped_paths,
                            )
                            .filter(|_| job.skipped_paths.len() < MAX_AUTO_RECOVERIES);
                            if let Some(recovery_path) = recovery_path {
                                job.skipped_paths.push(recovery_path);
                                job.worker_attempt = job.worker_attempt.saturating_add(1);
                                let next_attempt = job.worker_attempt;
                                job.status.last_heartbeat_at_ms = None;
                                job.status.last_progress_at_ms = Some(now);
                                job.child
                                    .take()
                                    .map(|child| CleanupScanWatchdogAction::Recover {
                                        child,
                                        next_attempt,
                                    })
                            } else {
                                job.status.phase = CleanupScanJobPhase::Failed;
                                job.status.error_code =
                                    Some("cleanup_scan_auto_recovery_exhausted".to_owned());
                                job.status.error_message = Some(
                                    "CoreRobin could not continue the cleanup scan after repeated filesystem stalls."
                                        .to_owned(),
                                );
                                job.child.take().map(CleanupScanWatchdogAction::Exhausted)
                            }
                        } else {
                            None
                        }
                    }
                };
                match action {
                    Some(CleanupScanWatchdogAction::Cancel(child)) => {
                        kill_worker(&child);
                        manager.mark_cancelled(&job_id, generation);
                        return;
                    }
                    Some(CleanupScanWatchdogAction::Recover {
                        child,
                        next_attempt,
                    }) => {
                        kill_worker(&child);
                        manager.restart_worker(&job_id, generation, next_attempt);
                        return;
                    }
                    Some(CleanupScanWatchdogAction::Exhausted(child)) => {
                        kill_worker(&child);
                        return;
                    }
                    None => {}
                }
            }
        });
    }

    fn restart_worker(self: &Arc<Self>, job_id: &str, generation: u64, worker_attempt: u64) {
        let worker_input = {
            let Ok(active) = self.active.lock() else {
                return;
            };
            let Some(job) = active.as_ref() else {
                return;
            };
            if job.status.job_id != job_id
                || job.status.generation != generation
                || job.worker_attempt != worker_attempt
                || job.status.phase.is_terminal()
                || job.status.phase == CleanupScanJobPhase::Cancelling
            {
                return;
            }
            (
                job.request_path.clone(),
                job.result_path.clone(),
                job.cache_path.clone(),
                job.checkpoint_path.clone(),
                job.exclusions_path.clone(),
                job.skipped_paths.clone(),
            )
        };
        if let Err(error) = save_worker_exclusions(&worker_input.4, &worker_input.5) {
            let Ok(mut active) = self.active.lock() else {
                return;
            };
            let Some(job) = active.as_mut() else {
                return;
            };
            if job.status.job_id == job_id
                && job.status.generation == generation
                && job.worker_attempt == worker_attempt
            {
                job.status.phase = CleanupScanJobPhase::Failed;
                job.status.updated_at_ms = now_millis();
                job.status.error_code = Some("cleanup_scan_worker_restart_failed".to_owned());
                job.status.error_message = Some(error.message);
            }
            return;
        }
        let (child, stdout, stderr) = match spawn_worker_process(
            &worker_input.0,
            &worker_input.1,
            &worker_input.2,
            &worker_input.3,
            &worker_input.4,
        ) {
            Ok(worker) => worker,
            Err(error) => {
                let Ok(mut active) = self.active.lock() else {
                    return;
                };
                let Some(job) = active.as_mut() else {
                    return;
                };
                if job.status.job_id == job_id
                    && job.status.generation == generation
                    && job.worker_attempt == worker_attempt
                {
                    job.status.phase = CleanupScanJobPhase::Failed;
                    job.status.updated_at_ms = now_millis();
                    job.status.error_code = Some("cleanup_scan_worker_restart_failed".to_owned());
                    job.status.error_message = Some(error.message);
                }
                return;
            }
        };

        let installed = {
            let Ok(mut active) = self.active.lock() else {
                kill_worker(&child);
                return;
            };
            let Some(job) = active.as_mut() else {
                kill_worker(&child);
                return;
            };
            if job.status.job_id != job_id
                || job.status.generation != generation
                || job.worker_attempt != worker_attempt
                || job.status.phase.is_terminal()
                || job.status.phase == CleanupScanJobPhase::Cancelling
            {
                false
            } else {
                let now = now_millis();
                job.child = Some(Arc::clone(&child));
                job.status.updated_at_ms = now;
                job.status.last_progress_at_ms = Some(now);
                true
            }
        };
        if !installed {
            kill_worker(&child);
            let _ = private_storage::remove(&worker_input.4);
            return;
        }

        self.start_event_reader(
            job_id.to_owned(),
            generation,
            worker_attempt,
            stdout,
            stderr,
            Arc::clone(&child),
        );
        self.start_watchdog(job_id.to_owned(), generation, worker_attempt);
    }

    fn apply_worker_event(
        &self,
        job_id: &str,
        generation: u64,
        worker_attempt: u64,
        event: CleanupScanWorkerEvent,
    ) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(job) = active.as_mut() else {
            return;
        };
        if job.status.job_id != job_id
            || job.status.generation != generation
            || job.worker_attempt != worker_attempt
            || job.status.phase.is_terminal()
        {
            return;
        }
        match event {
            CleanupScanWorkerEvent::Heartbeat { at_ms } => {
                let resumed_without_progress = matches!(
                    job.status.phase,
                    CleanupScanJobPhase::Paused | CleanupScanJobPhase::Stalled
                );
                if job.status.phase == CleanupScanJobPhase::Preparing || resumed_without_progress {
                    job.status.phase = CleanupScanJobPhase::Scanning;
                }
                if resumed_without_progress {
                    job.status.last_progress_at_ms = Some(at_ms);
                }
                job.status.updated_at_ms = at_ms;
                job.status.last_heartbeat_at_ms = Some(at_ms);
            }
            CleanupScanWorkerEvent::Activity { at_ms } => {
                if job.status.phase != CleanupScanJobPhase::Cancelling {
                    job.status.phase = CleanupScanJobPhase::Scanning;
                }
                job.status.updated_at_ms = at_ms;
                job.status.last_heartbeat_at_ms = Some(at_ms);
                job.status.last_progress_at_ms = Some(at_ms);
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

    fn finish_worker(
        &self,
        job_id: &str,
        generation: u64,
        worker_attempt: u64,
        exit_code: Option<i32>,
        stderr: String,
    ) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(job) = active.as_mut() else {
            return;
        };
        if job.status.job_id != job_id
            || job.status.generation != generation
            || job.worker_attempt != worker_attempt
        {
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
        let _ = private_storage::remove(&job.exclusions_path);
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

fn next_recovery_path(current_path: &str, skipped_paths: &[String]) -> Option<String> {
    let mut candidate = PathBuf::from(current_path.trim());
    loop {
        let text = candidate.to_string_lossy().into_owned();
        if text.is_empty() || text == "/" || (candidate.has_root() && candidate.parent().is_none())
        {
            return None;
        }
        if !skipped_paths.contains(&text) {
            return Some(text);
        }
        candidate = candidate.parent()?.to_path_buf();
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
    let Some(exclusions_path) = arguments.get(index + 5).map(PathBuf::from) else {
        return true;
    };
    run_worker(
        &request_path,
        &result_path,
        &cache_path,
        &checkpoint_path,
        &exclusions_path,
    );
    true
}

fn run_worker(
    request_path: &Path,
    result_path: &Path,
    cache_path: &Path,
    checkpoint_path: &Path,
    exclusions_path: &Path,
) {
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
        emit_worker_activity();
        let plan = cleanup_scan_segment_plan(request.clone(), &cancelled)?;
        let excluded_paths = load_worker_exclusions(exclusions_path)
            .into_iter()
            .filter_map(|path| resolve_worker_display_path(&path, &plan))
            .collect::<Vec<_>>();
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
            let scan = scan_cleanup_segment(
                &plan,
                segment_path,
                &excluded_paths,
                &cancelled,
                &mut |mut progress| {
                    progress.scanned_entry_count =
                        base_entries.saturating_add(progress.scanned_entry_count);
                    progress.discovered_bytes =
                        base_bytes.saturating_add(progress.discovered_bytes);
                    emit_worker_event(&CleanupScanWorkerEvent::Progress {
                        at_ms: now_millis(),
                        progress,
                    });
                },
            )?;
            base_entries = base_entries.saturating_add(scan.scanned_entry_count);
            base_bytes = base_bytes.saturating_add(scan.root.allocated_size_bytes);
            completed_paths.insert(path.clone());
            completed_segments.push(CleanupScanCompletedSegment {
                path,
                modified_at_ms: path_modified_at_ms(segment_path),
                scan,
            });
            emit_worker_activity();
            save_checkpoint(checkpoint_path, &request, &completed_segments)?;
            emit_worker_activity();
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
        emit_worker_activity();
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
        emit_worker_activity();
        let bytes = serde_json::to_vec(&scan).map_err(|error| {
            CommandError::internal(format!("Could not encode the cleanup scan result: {error}"))
        })?;
        emit_worker_activity();
        private_storage::write_atomic(result_path, &bytes).map_err(|error| {
            CommandError::internal(format!("Could not save the cleanup scan result: {error}"))
        })?;
        emit_worker_activity();
        save_cleanup_scan_snapshot_cache(cache_path, &scan)?;
        emit_worker_activity();
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

fn resolve_worker_display_path(display: &Path, plan: &CleanupScanSegmentPlan) -> Option<PathBuf> {
    let text = display.to_string_lossy();
    let candidate = if text == "~" {
        plan.home.clone()
    } else if let Some(relative) = text.strip_prefix("~/") {
        plan.home.join(relative)
    } else if display.is_absolute() {
        display.to_path_buf()
    } else {
        return None;
    };
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    resolved.starts_with(&plan.scan_root).then_some(resolved)
}

fn emit_worker_activity() {
    emit_worker_event(&CleanupScanWorkerEvent::Activity {
        at_ms: now_millis(),
    });
}

fn save_worker_exclusions(path: &Path, skipped_paths: &[String]) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(skipped_paths).map_err(|error| {
        CommandError::internal(format!(
            "Could not encode the cleanup scan recovery state: {error}"
        ))
    })?;
    private_storage::write_atomic(path, &bytes).map_err(|error| {
        CommandError::internal(format!(
            "Could not save the cleanup scan recovery state: {error}"
        ))
    })
}

fn load_worker_exclusions(path: &Path) -> Vec<PathBuf> {
    private_storage::read_limited(path, 64 * 1_024)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
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
            cache_path: PathBuf::from("/fixture/cache"),
            checkpoint_path: PathBuf::from("/fixture/checkpoint"),
            exclusions_path: PathBuf::from("/fixture/exclusions"),
            worker_attempt: 1,
            skipped_paths: Vec::new(),
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
            cache_path: PathBuf::from("/fixture/cache"),
            checkpoint_path: PathBuf::from("/fixture/checkpoint"),
            exclusions_path: PathBuf::from("/fixture/exclusions"),
            worker_attempt: 1,
            skipped_paths: Vec::new(),
            cancel_requested_at_ms: None,
        });
        manager.start_watchdog("fixture".to_owned(), 1, 1);
        assert!(manager.cancel().unwrap());
        thread::sleep(FORCE_CANCEL_AFTER + Duration::from_millis(750));

        assert_eq!(
            manager.status().unwrap().unwrap().phase,
            CleanupScanJobPhase::Cancelled
        );
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn worker_activity_keeps_long_finalization_alive() {
        let manager = manager_with_phase(CleanupScanJobPhase::Stalled);
        let activity_at = now_millis();

        manager.apply_worker_event(
            "fixture",
            1,
            1,
            CleanupScanWorkerEvent::Activity { at_ms: activity_at },
        );

        let status = manager.status().unwrap().unwrap();
        assert_eq!(status.phase, CleanupScanJobPhase::Scanning);
        assert_eq!(status.last_heartbeat_at_ms, Some(activity_at));
        assert_eq!(status.last_progress_at_ms, Some(activity_at));
    }

    #[test]
    fn late_worker_events_cannot_revive_a_terminal_job() {
        let manager = manager_with_phase(CleanupScanJobPhase::Failed);
        let failed_status = manager.status().unwrap().unwrap();

        manager.apply_worker_event(
            "fixture",
            1,
            1,
            CleanupScanWorkerEvent::Activity {
                at_ms: now_millis(),
            },
        );

        let status = manager.status().unwrap().unwrap();
        assert_eq!(status.phase, CleanupScanJobPhase::Failed);
        assert_eq!(status.updated_at_ms, failed_status.updated_at_ms);
    }

    #[test]
    fn worker_display_paths_resolve_inside_the_scan_root() {
        let plan = CleanupScanSegmentPlan {
            request: CleanupScanRequest::default(),
            home: PathBuf::from("/Users/fixture"),
            scan_root: PathBuf::from("/"),
            target_kind: crate::models::CleanupScanTargetKind::SystemDisk,
            segment_paths: Vec::new(),
        };

        assert_eq!(
            resolve_worker_display_path(Path::new("~/Library/Caches"), &plan),
            Some(PathBuf::from("/Users/fixture/Library/Caches"))
        );
        assert_eq!(
            resolve_worker_display_path(Path::new("relative/cache"), &plan),
            None
        );
    }

    #[test]
    fn repeated_recovery_broadens_to_the_nearest_unskipped_parent() {
        let skipped = vec!["~/Library/Caches/unresponsive".to_owned()];

        assert_eq!(
            next_recovery_path("~/Library/Caches/unresponsive", &skipped),
            Some("~/Library/Caches".to_owned())
        );
        assert_eq!(next_recovery_path("/", &[]), None);
    }

    #[test]
    fn recovery_paths_round_trip_through_private_worker_state() {
        let root =
            std::env::temp_dir().join(format!("core-robin-cleanup-recovery-{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("exclusions.json");
        let skipped = vec![
            "~/Library/Caches/unresponsive".to_owned(),
            "/Volumes/Archive/stalled".to_owned(),
        ];

        save_worker_exclusions(&path, &skipped).unwrap();

        assert_eq!(
            load_worker_exclusions(&path),
            skipped.into_iter().map(PathBuf::from).collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
