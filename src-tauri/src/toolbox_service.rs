use std::collections::{BTreeMap, HashMap};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::toolbox_contracts::{
    JobStatus, OutputValidation, TOOLBOX_CONTRACT_VERSION, TerminalReason, ToolboxCapability,
    ToolboxError, ToolboxJob, ToolboxJobRequest, ToolboxOutputToken, ToolboxResource,
    ToolboxSession, ToolboxSnapshot,
};
use crate::toolbox_inputs::{FileJobKey, ToolboxInputs, opaque_id};

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelToolboxJobRequest {
    pub request_id: String,
    pub job_id: String,
    pub expected_revision: Option<u64>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishToolboxJobRequest {
    pub request_id: String,
    pub job_id: String,
    pub expected_revision: Option<u64>,
    pub succeeded: bool,
    pub error: Option<crate::toolbox_contracts::ToolboxError>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterToolboxOutputRequest {
    pub request_id: String,
    pub job_id: String,
    pub generation: u64,
    pub reset_epoch: u64,
    pub bytes: Vec<u8>,
    pub validation: OutputValidation,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportToolboxOutputRequest {
    pub request_id: String,
    pub job_id: String,
    pub output_token: String,
    pub generation: u64,
    pub reset_epoch: u64,
    pub path: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelToolboxOutputRequest {
    pub request_id: String,
    pub job_id: String,
    pub output_token: String,
    pub generation: u64,
    pub reset_epoch: u64,
}

pub(crate) struct ToolboxOutputExport {
    pub(crate) bytes: Vec<u8>,
    pub(crate) cancel: Arc<AtomicBool>,
}

const TOOL_IDS: &[&str] = &[
    "json",
    "url",
    "base64",
    "time",
    "uuid",
    "qr-code",
    "text-sha256",
    "file-sha256",
    "regex",
    "color",
    "keep-awake",
    "process-watch",
    "file-occupancy",
    "volume-occupancy",
    "keyboard-cleaning",
    "schedules",
    "network-addresses",
    "ifconfig-parser",
    "image-watermark",
    "image-batch-watermark",
    "confidential-watermark",
    "image-recipe",
    "image-editor",
    "invisible-watermark-write",
    "invisible-watermark-check",
    "recipient-tracking",
    "robustness-lab",
    "c2pa-inspector",
    "binary-patch-create",
    "binary-patch-apply",
    "binary-patch-inspector",
    "integrity-manifest",
    "transfer-savings",
    "patch-errors",
    "patch-planner",
];

const WEB_MANAGED_TOOL_IDS: &[&str] = &[
    "file-sha256",
    "image-watermark",
    "image-batch-watermark",
    "confidential-watermark",
    "image-recipe",
    "image-editor",
    "invisible-watermark-write",
    "invisible-watermark-check",
    "recipient-tracking",
    "robustness-lab",
    "c2pa-inspector",
    "binary-patch-create",
    "binary-patch-apply",
    "binary-patch-inspector",
    "integrity-manifest",
    "transfer-savings",
    "patch-errors",
    "patch-planner",
];
const LOCAL_TOOL_IDS: &[&str] = &[
    "json",
    "url",
    "base64",
    "time",
    "uuid",
    "qr-code",
    "text-sha256",
    "regex",
    "color",
    "ifconfig-parser",
];
const NATIVE_TOOL_IDS: &[&str] = &[
    "file-sha256",
    "keep-awake",
    "process-watch",
    "file-occupancy",
    "volume-occupancy",
    "schedules",
    "network-addresses",
];
const OUTPUT_TTL_MS: u64 = 10 * 60 * 1_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

fn is_heavy_tool(tool_id: &str) -> bool {
    matches!(
        tool_id,
        "image-watermark"
            | "image-batch-watermark"
            | "confidential-watermark"
            | "image-recipe"
            | "image-editor"
            | "invisible-watermark-write"
            | "invisible-watermark-check"
            | "recipient-tracking"
            | "robustness-lab"
            | "c2pa-inspector"
            | "binary-patch-create"
            | "binary-patch-apply"
            | "binary-patch-inspector"
            | "integrity-manifest"
            | "transfer-savings"
            | "patch-errors"
            | "patch-planner"
    )
}

#[derive(Default)]
pub struct ToolboxService {
    service_instance_id: String,
    revision: u64,
    reset_epoch: u64,
    sessions: HashMap<String, ToolboxSession>,
    jobs: HashMap<String, ToolboxJob>,
    request_results: HashMap<String, ToolboxJob>,
    outputs: HashMap<String, Vec<u8>>,
    output_cancellations: HashMap<String, Arc<AtomicBool>>,
    inputs: Arc<ToolboxInputs>,
    clearing: bool,
}

impl ToolboxService {
    pub fn new() -> Self {
        Self {
            service_instance_id: format!("toolbox-{}", now_millis()),
            revision: 0,
            reset_epoch: 0,
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> ToolboxSnapshot {
        let capabilities = TOOL_IDS
            .iter()
            .map(|id| {
                let (state, reason) = if LOCAL_TOOL_IDS.contains(id) || NATIVE_TOOL_IDS.contains(id) {
                    ("available", None)
                } else if WEB_MANAGED_TOOL_IDS.contains(id) {
                    (
                        "degraded",
                        Some("Web Worker provider is bounded, but some native input/output integration remains limited."),
                    )
                } else {
                    (
                        "unavailable",
                        Some("This tool requires a restricted native helper that is not registered."),
                    )
                };
                (
                    (*id).to_owned(),
                    ToolboxCapability {
                        state: state.to_owned(),
                        reason: reason.map(str::to_owned),
                        platform: None,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        ToolboxSnapshot {
            contract_version: TOOLBOX_CONTRACT_VERSION.to_owned(),
            service_instance_id: self.service_instance_id.clone(),
            revision: self.revision,
            reset_epoch: self.reset_epoch,
            sessions: self.sessions.values().cloned().collect(),
            resources: self
                .jobs
                .values()
                .filter_map(|job| {
                    self.inputs
                        .resource_state(&job.job_id)
                        .map(|(bytes, stopping)| ToolboxResource {
                            resource_id: format!("inputs:{}", job.job_id),
                            session_id: job.session_id.clone(),
                            status: if stopping {
                                crate::toolbox_contracts::ResourceStatus::ReleaseUnconfirmed
                            } else {
                                crate::toolbox_contracts::ResourceStatus::Active
                            },
                            bytes_reserved: bytes,
                            release_confirmed: false,
                        })
                })
                .collect(),
            jobs: self.jobs.values().cloned().collect(),
            capabilities,
        }
    }

    /// Restore only the durable reset epoch during native startup. Runtime
    /// sessions and jobs are intentionally never restored from disk.
    pub fn adopt_reset_epoch(&mut self, reset_epoch: u64) {
        self.reset_epoch = reset_epoch;
    }

    pub fn start(&mut self, request: ToolboxJobRequest) -> Result<ToolboxJob, CommandError> {
        self.reconcile();
        if self.clearing {
            return Err(CommandError::new(
                "toolbox_clearing",
                "Toolbox resources are still stopping before reset.",
            ));
        }
        if request
            .common
            .reset_epoch
            .is_some_and(|epoch| epoch != self.reset_epoch)
        {
            return Err(CommandError::new(
                "stale_job",
                "Toolbox data was reset; refresh before starting a job.",
            ));
        }
        if request.common.request_id.trim().is_empty()
            || request.common.request_id.len() > 128
            || request
                .session_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        if let Some(previous) = self.request_results.get(&request.common.request_id) {
            let session = self.sessions.get(&previous.session_id);
            if session.is_none_or(|session| session.tool_id != request.tool_id)
                || previous.generation != request.common.generation.unwrap_or_default()
            {
                return Err(CommandError::new(
                    "request_conflict",
                    "The request ID was already used for a different operation.",
                ));
            }
            return Ok(previous.clone());
        }
        if !TOOL_IDS.contains(&request.tool_id.as_str()) {
            return Err(CommandError::new(
                "unknown_tool",
                "The requested toolbox tool is unknown.",
            ));
        }
        if request
            .common
            .expected_revision
            .is_some_and(|expected| expected != self.revision)
        {
            return Err(CommandError::new(
                "revision_conflict",
                "The toolbox state changed; reload before retrying.",
            ));
        }
        if !WEB_MANAGED_TOOL_IDS.contains(&request.tool_id.as_str()) {
            return Err(CommandError::new(
                "tool_unavailable",
                "This toolbox provider is not available in the native service yet.",
            ));
        }
        if is_heavy_tool(&request.tool_id)
            && self.jobs.values().any(|job| {
                !matches!(
                    job.status,
                    JobStatus::Completed
                        | JobStatus::Cancelled
                        | JobStatus::Expired
                        | JobStatus::Failed
                ) && self
                    .sessions
                    .get(&job.session_id)
                    .is_some_and(|session| is_heavy_tool(&session.tool_id))
            })
        {
            return Err(CommandError::new(
                "heavy_job_busy",
                "Only one image or patch operation can run at a time.",
            ));
        }
        if self.jobs.len() >= 64 || self.request_results.len() >= 256 {
            return Err(CommandError::new(
                "resource_busy",
                "Clear finished tool sessions before starting more work.",
            ));
        }
        if request
            .session_id
            .as_ref()
            .is_some_and(|id| self.sessions.contains_key(id))
        {
            return Err(CommandError::new(
                "session_busy",
                "Start a fresh session for a new file job.",
            ));
        }
        let session_id = request
            .session_id
            .unwrap_or_else(|| format!("toolbox-session-{}", request.common.request_id));
        let generation = request.common.generation.unwrap_or_default();
        let now = now_millis().min(u64::MAX as u128) as u64;
        let job_id = format!("toolbox-job-{}", opaque_id()?);
        self.inputs.register(
            FileJobKey {
                job_id: job_id.clone(),
                generation,
                reset_epoch: self.reset_epoch,
            },
            session_id.clone(),
            request.tool_id.clone(),
        )?;
        self.sessions.insert(
            session_id.clone(),
            ToolboxSession {
                session_id: session_id.clone(),
                tool_id: request.tool_id.clone(),
                status: crate::toolbox_contracts::SessionStatus::Running,
                generation,
                created_at_ms: now,
                terminal_reason: None,
            },
        );
        let job = ToolboxJob {
            job_id,
            session_id,
            status: JobStatus::Running,
            generation,
            reset_epoch: self.reset_epoch,
            output_expires_at_ms: None,
            output_token: None,
            terminal_reason: None,
            error: None,
        };
        self.revision = self.revision.saturating_add(1);
        self.jobs.insert(job.job_id.clone(), job.clone());
        self.request_results
            .insert(request.common.request_id, job.clone());
        Ok(job)
    }

    pub fn finish(&mut self, request: FinishToolboxJobRequest) -> Result<ToolboxJob, CommandError> {
        if request.request_id.trim().is_empty() {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        if let Some(expected) = request.expected_revision
            && expected != self.revision
        {
            return Err(CommandError::new(
                "revision_conflict",
                "The toolbox state changed; reload before retrying.",
            ));
        }
        let Some(job) = self.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        if matches!(job.status, JobStatus::OutputReady | JobStatus::Exporting) {
            return Err(CommandError::new(
                "output_pending",
                "The job has a prepared output; export it or cancel it before finishing.",
            ));
        }
        if !matches!(
            job.status,
            JobStatus::Completed | JobStatus::Cancelled | JobStatus::Expired | JobStatus::Failed
        ) {
            if !self.inputs.cancel(&job.job_id) {
                job.status = JobStatus::Stopping;
                job.terminal_reason = Some(TerminalReason::ReleaseUnconfirmed);
                self.revision = self.revision.saturating_add(1);
                return Ok(job.clone());
            }
            if request.succeeded {
                job.status = JobStatus::Completed;
                job.terminal_reason = Some(TerminalReason::Completed);
                job.error = None;
                job.output_expires_at_ms = None;
            } else {
                job.status = JobStatus::Failed;
                job.terminal_reason = Some(TerminalReason::Failed);
                job.error = request.error;
            }
            self.revision = self.revision.saturating_add(1);
            if let Some(session) = self.sessions.get_mut(&job.session_id) {
                session.status = crate::toolbox_contracts::SessionStatus::Ended;
                session.terminal_reason = job.terminal_reason.clone();
            }
        }
        self.request_results.insert(request.request_id, job.clone());
        Ok(job.clone())
    }

    pub fn register_output(
        &mut self,
        request: RegisterToolboxOutputRequest,
    ) -> Result<ToolboxJob, CommandError> {
        self.register_output_with_budget(request, MAX_OUTPUT_BYTES)
    }

    fn register_output_with_budget(
        &mut self,
        request: RegisterToolboxOutputRequest,
        max_output_bytes: usize,
    ) -> Result<ToolboxJob, CommandError> {
        self.reconcile();
        validate_output_request(
            &request.request_id,
            &request.job_id,
            request.generation,
            request.reset_epoch,
        )?;
        if request.bytes.is_empty() {
            return Err(CommandError::new(
                "empty_output",
                "A formal output must contain at least one byte.",
            ));
        }
        if request.bytes.len() > max_output_bytes {
            return Err(CommandError::new(
                "output_too_large",
                "The prepared output exceeds the 512 MiB temporary budget.",
            ));
        }
        let retained_output_bytes = self
            .outputs
            .values()
            .map(Vec::len)
            .try_fold(0_usize, usize::checked_add)
            .ok_or_else(|| {
                CommandError::new(
                    "output_too_large",
                    "The global temporary output budget could not be calculated safely.",
                )
            })?;
        if retained_output_bytes
            .checked_add(request.bytes.len())
            .is_none_or(|bytes| bytes > max_output_bytes)
        {
            return Err(CommandError::new(
                "output_budget_exhausted",
                "The global 512 MiB temporary output budget is in use; export or cancel an existing output first.",
            ));
        }
        if request.validation == OutputValidation::Failed {
            return Err(CommandError::new(
                "output_unverified",
                "A failed validation cannot become a formal output.",
            ));
        }
        let Some(job) = self.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        validate_job_identity(job, request.generation, request.reset_epoch)?;
        if job.status != JobStatus::Running {
            return Err(CommandError::new(
                "job_not_running",
                "Only a running job can publish a prepared output.",
            ));
        }
        let token = opaque_id()?;
        let expires_at_ms =
            (now_millis().min(u64::MAX as u128) as u64).saturating_add(OUTPUT_TTL_MS);
        let output_token = ToolboxOutputToken {
            token: token.clone(),
            job_id: request.job_id.clone(),
            generation: request.generation,
            reset_epoch: request.reset_epoch,
            byte_length: request.bytes.len() as u64,
            expires_at_ms,
            validation: request.validation,
        };
        job.status = JobStatus::OutputReady;
        job.output_expires_at_ms = Some(expires_at_ms);
        job.output_token = Some(output_token);
        job.terminal_reason = None;
        job.error = None;
        self.outputs.insert(token, request.bytes);
        self.revision = self.revision.saturating_add(1);
        let snapshot = job.clone();
        self.request_results
            .insert(request.request_id, snapshot.clone());
        Ok(snapshot)
    }

    pub(crate) fn begin_output_export(
        &mut self,
        request: &ExportToolboxOutputRequest,
    ) -> Result<ToolboxOutputExport, CommandError> {
        self.reconcile();
        if self.clearing {
            return Err(CommandError::new(
                "toolbox_clearing",
                "Toolbox resources are still stopping before reset.",
            ));
        }
        validate_output_request(
            &request.request_id,
            &request.job_id,
            request.generation,
            request.reset_epoch,
        )?;
        let Some(job) = self.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        validate_job_identity(job, request.generation, request.reset_epoch)?;
        if job.status != JobStatus::OutputReady {
            return Err(CommandError::new(
                "output_not_ready",
                "The toolbox output is not ready for export.",
            ));
        }
        if job
            .output_token
            .as_ref()
            .is_none_or(|output| output.token != request.output_token)
        {
            return Err(CommandError::new(
                "invalid_output_token",
                "The output token does not belong to this job.",
            ));
        }
        let bytes = self
            .outputs
            .get(&request.output_token)
            .cloned()
            .ok_or_else(|| {
                CommandError::new(
                    "output_expired",
                    "The prepared output is no longer available.",
                )
            })?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.output_cancellations
            .insert(request.job_id.clone(), Arc::clone(&cancel));
        job.status = JobStatus::Exporting;
        self.revision = self.revision.saturating_add(1);
        Ok(ToolboxOutputExport { bytes, cancel })
    }

    pub(crate) fn complete_output_export(
        &mut self,
        request: &ExportToolboxOutputRequest,
        succeeded: bool,
        error: Option<ToolboxError>,
    ) -> Result<ToolboxJob, CommandError> {
        let Some(job) = self.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        validate_job_identity(job, request.generation, request.reset_epoch)?;
        if job.status != JobStatus::Exporting
            || job
                .output_token
                .as_ref()
                .is_none_or(|output| output.token != request.output_token)
        {
            return Err(CommandError::new(
                "output_not_exporting",
                "The toolbox output is no longer being exported.",
            ));
        }
        self.output_cancellations.remove(&request.job_id);
        if succeeded {
            self.outputs.remove(&request.output_token);
            job.status = JobStatus::Completed;
            job.output_token = None;
            job.output_expires_at_ms = None;
            job.terminal_reason = Some(TerminalReason::Completed);
            job.error = None;
            if let Some(session) = self.sessions.get_mut(&job.session_id) {
                session.status = crate::toolbox_contracts::SessionStatus::Ended;
                session.terminal_reason = job.terminal_reason.clone();
            }
        } else {
            job.status = JobStatus::OutputReady;
            job.error = error;
        }
        self.revision = self.revision.saturating_add(1);
        let snapshot = job.clone();
        self.request_results
            .insert(request.request_id.clone(), snapshot.clone());
        Ok(snapshot)
    }

    pub fn cancel_output(
        &mut self,
        request: CancelToolboxOutputRequest,
    ) -> Result<bool, CommandError> {
        validate_output_request(
            &request.request_id,
            &request.job_id,
            request.generation,
            request.reset_epoch,
        )?;
        let Some(job) = self.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        validate_job_identity(job, request.generation, request.reset_epoch)?;
        if job
            .output_token
            .as_ref()
            .is_none_or(|output| output.token != request.output_token)
        {
            return Err(CommandError::new(
                "invalid_output_token",
                "The output token does not belong to this job.",
            ));
        }
        if job.status == JobStatus::Exporting {
            if let Some(cancel) = self.output_cancellations.get(&request.job_id) {
                cancel.store(true, Ordering::Release);
                return Ok(true);
            }
            return Ok(false);
        }
        if job.status != JobStatus::OutputReady {
            return Ok(false);
        }
        self.outputs.remove(&request.output_token);
        job.output_token = None;
        job.output_expires_at_ms = None;
        job.status = JobStatus::Cancelled;
        job.terminal_reason = Some(TerminalReason::Cancelled);
        if let Some(session) = self.sessions.get_mut(&job.session_id) {
            session.status = crate::toolbox_contracts::SessionStatus::Ended;
            session.terminal_reason = job.terminal_reason.clone();
        }
        self.revision = self.revision.saturating_add(1);
        Ok(true)
    }

    pub fn cancel(
        &mut self,
        request_id: &str,
        job_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<ToolboxJob, CommandError> {
        if request_id.trim().is_empty() {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        if let Some(expected) = expected_revision
            && expected != self.revision
        {
            return Err(CommandError::new(
                "revision_conflict",
                "The toolbox state changed; reload before retrying.",
            ));
        }
        let Some(job) = self.jobs.get_mut(job_id) else {
            return Err(CommandError::new(
                "job_not_found",
                "The toolbox job no longer exists.",
            ));
        };
        if !matches!(
            job.status,
            JobStatus::Completed | JobStatus::Cancelled | JobStatus::Expired | JobStatus::Failed
        ) {
            let released = self.inputs.cancel(job_id);
            job.status = if released {
                JobStatus::Cancelled
            } else {
                JobStatus::Stopping
            };
            job.terminal_reason = Some(if released {
                TerminalReason::Cancelled
            } else {
                TerminalReason::ReleaseUnconfirmed
            });
            if let Some(session) = self.sessions.get_mut(&job.session_id) {
                session.status = if released {
                    crate::toolbox_contracts::SessionStatus::Ended
                } else {
                    crate::toolbox_contracts::SessionStatus::Stopping
                };
                session.terminal_reason = job.terminal_reason.clone();
            }
            self.revision = self.revision.saturating_add(1);
        }
        self.request_results
            .insert(request_id.to_owned(), job.clone());
        Ok(job.clone())
    }

    pub fn clear(
        &mut self,
        request_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<ToolboxSnapshot, CommandError> {
        if request_id.trim().is_empty() {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        if let Some(expected) = expected_revision
            && expected != self.revision
        {
            return Err(CommandError::new(
                "revision_conflict",
                "The toolbox state changed; reload before retrying.",
            ));
        }
        self.clearing = true;
        self.cancel_output_exports();
        let mut released = true;
        for job in self.jobs.values_mut() {
            if !self.inputs.cancel(&job.job_id) {
                job.status = JobStatus::Stopping;
                job.terminal_reason = Some(TerminalReason::ReleaseUnconfirmed);
                released = false;
            }
        }
        if !released {
            self.clearing = false;
            self.revision = self.revision.saturating_add(1);
            return Err(CommandError::new(
                "release_unconfirmed",
                "File operations are still stopping; retry clear after release is confirmed.",
            ));
        }
        if self.has_active_output_exports() {
            self.clearing = false;
            self.revision = self.revision.saturating_add(1);
            return Err(CommandError::new(
                "release_unconfirmed",
                "Output exports are still stopping; retry clear after release is confirmed.",
            ));
        }
        self.reset_epoch = self.reset_epoch.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        self.sessions.clear();
        self.jobs.clear();
        self.request_results.clear();
        self.outputs.clear();
        self.output_cancellations.clear();
        self.clearing = false;
        Ok(self.snapshot())
    }

    pub fn cancel_output_exports(&self) {
        for cancel in self.output_cancellations.values() {
            cancel.store(true, Ordering::Release);
        }
    }

    pub fn has_active_output_exports(&self) -> bool {
        !self.output_cancellations.is_empty()
    }

    pub fn inputs_for_job(&self, key: &FileJobKey) -> Result<Arc<ToolboxInputs>, CommandError> {
        let job = self
            .jobs
            .get(&key.job_id)
            .ok_or_else(|| CommandError::new("job_not_found", "The tool job no longer exists."))?;
        if job.generation != key.generation
            || job.reset_epoch != key.reset_epoch
            || key.reset_epoch != self.reset_epoch
        {
            return Err(CommandError::new(
                "stale_job",
                "The tool job belongs to an earlier page or reset.",
            ));
        }
        if !matches!(job.status, JobStatus::Queued | JobStatus::Running) {
            return Err(CommandError::new(
                "job_not_running",
                "This job no longer accepts file input.",
            ));
        }
        Ok(Arc::clone(&self.inputs))
    }

    pub fn inputs_for_tool_job(
        &self,
        key: &FileJobKey,
        tool_id: &str,
    ) -> Result<Arc<ToolboxInputs>, CommandError> {
        let inputs = self.inputs_for_job(key)?;
        let job = self.jobs.get(&key.job_id).expect("validated job");
        if self
            .sessions
            .get(&job.session_id)
            .is_none_or(|session| session.tool_id != tool_id)
        {
            return Err(CommandError::new(
                "invalid_tool_operation",
                "This operation is not allowed for the selected tool.",
            ));
        }
        Ok(inputs)
    }

    pub fn reconcile(&mut self) {
        self.reconcile_at(now_millis().min(u64::MAX as u128) as u64);
    }

    fn reconcile_at(&mut self, now_ms: u64) {
        let mut expired_outputs = Vec::new();
        for job in self.jobs.values_mut() {
            if job.status == JobStatus::Stopping {
                if self.inputs.cancel(&job.job_id) {
                    job.status = JobStatus::Cancelled;
                    job.terminal_reason = Some(TerminalReason::Cancelled);
                    if let Some(session) = self.sessions.get_mut(&job.session_id) {
                        session.status = crate::toolbox_contracts::SessionStatus::Ended;
                        session.terminal_reason = Some(TerminalReason::Cancelled);
                    }
                    self.revision = self.revision.saturating_add(1);
                }
            } else if matches!(
                job.status,
                JobStatus::Completed | JobStatus::OutputReady | JobStatus::Exporting
            ) && job
                .output_expires_at_ms
                .is_some_and(|expires_at| expires_at <= now_ms)
            {
                job.status = JobStatus::Expired;
                job.terminal_reason = Some(TerminalReason::Expired);
                if let Some(output) = job.output_token.take() {
                    expired_outputs.push((job.job_id.clone(), output.token));
                }
                job.output_expires_at_ms = None;
                if let Some(session) = self.sessions.get_mut(&job.session_id) {
                    session.status = crate::toolbox_contracts::SessionStatus::Ended;
                    session.terminal_reason = job.terminal_reason.clone();
                }
                self.revision = self.revision.saturating_add(1);
            }
        }
        for (job_id, token) in expired_outputs {
            self.outputs.remove(&token);
            if let Some(cancel) = self.output_cancellations.remove(&job_id) {
                cancel.store(true, Ordering::Release);
            }
        }
    }

    #[cfg(test)]
    fn seed_job(&mut self, job: ToolboxJob) {
        self.jobs.insert(job.job_id.clone(), job);
    }
}

fn validate_output_request(
    request_id: &str,
    job_id: &str,
    generation: u64,
    reset_epoch: u64,
) -> Result<(), CommandError> {
    if request_id.trim().is_empty()
        || request_id.len() > 128
        || job_id.trim().is_empty()
        || job_id.len() > 128
    {
        return Err(CommandError::new(
            "invalid_request",
            "requestId and jobId are required.",
        ));
    }
    if generation > u64::MAX / 2 || reset_epoch > u64::MAX / 2 {
        return Err(CommandError::new(
            "invalid_request",
            "The job generation or reset epoch is invalid.",
        ));
    }
    Ok(())
}

fn validate_job_identity(
    job: &ToolboxJob,
    generation: u64,
    reset_epoch: u64,
) -> Result<(), CommandError> {
    if job.generation != generation || job.reset_epoch != reset_epoch {
        return Err(CommandError::new(
            "stale_job",
            "The toolbox job belongs to an earlier page or reset.",
        ));
    }
    Ok(())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolbox_contracts::ToolboxRequest;

    #[test]
    fn unavailable_tools_never_return_a_success_job() {
        let mut service = ToolboxService::new();
        let error = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "request-1".to_owned(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "json".to_owned(),
                session_id: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "tool_unavailable");
    }

    #[test]
    fn snapshot_distinguishes_local_native_degraded_and_unavailable_tools() {
        let service = ToolboxService::new();
        let capabilities = service.snapshot().capabilities;

        assert_eq!(capabilities["json"].state, "available");
        assert_eq!(capabilities["file-sha256"].state, "available");
        assert_eq!(capabilities["image-watermark"].state, "degraded");
        assert_eq!(capabilities["keyboard-cleaning"].state, "unavailable");
        assert!(capabilities["keyboard-cleaning"].reason.is_some());
    }

    #[test]
    fn clear_advances_epoch_and_removes_state() {
        let mut service = ToolboxService::new();
        service.seed_job(ToolboxJob {
            job_id: "job-1".to_owned(),
            session_id: "session-1".to_owned(),
            status: JobStatus::Running,
            generation: 1,
            reset_epoch: 0,
            output_expires_at_ms: None,
            output_token: None,
            terminal_reason: None,
            error: None,
        });
        let snapshot = service.clear("clear-1", Some(0)).unwrap();
        assert_eq!(snapshot.reset_epoch, 1);
        assert!(snapshot.jobs.is_empty());
    }

    #[test]
    fn failed_clear_remains_retryable_after_input_release() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "clear-retry-start".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        service.inputs.hold_operation_for_test(&job.job_id);

        let error = service.clear("clear-retry-1", None).unwrap_err();
        assert_eq!(error.code, "release_unconfirmed");
        assert!(!service.clearing);

        service.inputs.release_operation_for_test(&job.job_id);
        let snapshot = service.clear("clear-retry-2", None).unwrap();
        assert!(snapshot.jobs.is_empty());
    }

    #[test]
    fn web_managed_job_has_a_real_lifecycle() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "request-image".to_owned(),
                    expected_revision: None,
                    generation: Some(2),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".to_owned(),
                session_id: None,
            })
            .unwrap();
        assert_eq!(job.status, JobStatus::Running);
        let completed = service
            .finish(FinishToolboxJobRequest {
                request_id: "finish-image".to_owned(),
                job_id: job.job_id,
                expected_revision: None,
                succeeded: true,
                error: None,
            })
            .unwrap();
        assert_eq!(completed.status, JobStatus::Completed);
        assert!(completed.output_expires_at_ms.is_none());
        assert!(service.snapshot().resources.is_empty());
        assert_eq!(
            service.snapshot().sessions[0].status,
            crate::toolbox_contracts::SessionStatus::Ended
        );
    }

    #[test]
    fn output_moves_through_ready_exporting_and_retryable_failure() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "output-start".into(),
                    expected_revision: None,
                    generation: Some(4),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        let ready = service
            .register_output(RegisterToolboxOutputRequest {
                request_id: "output-register".into(),
                job_id: job.job_id.clone(),
                generation: 4,
                reset_epoch: 0,
                bytes: vec![1, 2, 3],
                validation: OutputValidation::Verified,
            })
            .unwrap();
        assert_eq!(ready.status, JobStatus::OutputReady);
        let output_token = ready.output_token.as_ref().unwrap().token.clone();
        let export = ExportToolboxOutputRequest {
            request_id: "output-export".into(),
            job_id: job.job_id.clone(),
            output_token: output_token.clone(),
            generation: 4,
            reset_epoch: 0,
            path: "/tmp/output.bin".into(),
        };
        assert_eq!(
            service.begin_output_export(&export).unwrap().bytes,
            vec![1, 2, 3]
        );
        let failed = service
            .complete_output_export(
                &export,
                false,
                Some(ToolboxError {
                    code: "target_exists".into(),
                    message: "destination exists".into(),
                    retryable: true,
                }),
            )
            .unwrap();
        assert_eq!(failed.status, JobStatus::OutputReady);
        assert!(service.begin_output_export(&export).is_ok());
        let completed = service.complete_output_export(&export, true, None).unwrap();
        assert_eq!(completed.status, JobStatus::Completed);
        assert!(completed.output_token.is_none());
    }

    #[test]
    fn clear_waits_for_active_output_export_to_release() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "clear-export-start".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        let ready = service
            .register_output(RegisterToolboxOutputRequest {
                request_id: "clear-export-output".into(),
                job_id: job.job_id.clone(),
                generation: 1,
                reset_epoch: 0,
                bytes: vec![1, 2, 3],
                validation: OutputValidation::Verified,
            })
            .unwrap();
        let export = ExportToolboxOutputRequest {
            request_id: "clear-export-run".into(),
            job_id: job.job_id.clone(),
            output_token: ready.output_token.unwrap().token,
            generation: 1,
            reset_epoch: 0,
            path: "/tmp/clear-export.bin".into(),
        };
        service.begin_output_export(&export).unwrap();

        let error = service.clear("clear-export", None).unwrap_err();
        assert_eq!(error.code, "release_unconfirmed");
        assert!(!service.clearing);
        assert!(service.has_active_output_exports());

        service
            .complete_output_export(
                &export,
                false,
                Some(ToolboxError {
                    code: "cancelled".into(),
                    message: "The export was cancelled.".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        assert!(!service.has_active_output_exports());
        assert!(service.clear("clear-export-retry", None).is_ok());
    }

    #[test]
    fn output_registration_enforces_the_global_temporary_budget() {
        let mut service = ToolboxService::new();
        let first = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "output-budget-start-1".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        let output_budget = 3;
        service
            .register_output_with_budget(
                RegisterToolboxOutputRequest {
                    request_id: "output-budget-register-1".into(),
                    job_id: first.job_id,
                    generation: 1,
                    reset_epoch: 0,
                    bytes: vec![7_u8; output_budget],
                    validation: OutputValidation::Verified,
                },
                output_budget,
            )
            .unwrap();
        service.seed_job(ToolboxJob {
            job_id: "output-budget-job-2".into(),
            session_id: "output-budget-session-2".into(),
            status: JobStatus::Running,
            generation: 1,
            reset_epoch: 0,
            output_expires_at_ms: None,
            output_token: None,
            terminal_reason: None,
            error: None,
        });
        let error = service
            .register_output_with_budget(
                RegisterToolboxOutputRequest {
                    request_id: "output-budget-register-2".into(),
                    job_id: "output-budget-job-2".into(),
                    generation: 1,
                    reset_epoch: 0,
                    bytes: vec![8],
                    validation: OutputValidation::Verified,
                },
                output_budget,
            )
            .unwrap_err();
        assert_eq!(error.code, "output_budget_exhausted");
    }

    #[test]
    fn only_one_heavy_job_can_run_and_non_output_jobs_remain_completed() {
        let mut service = ToolboxService::new();
        let first = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "heavy-1".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        let second_error = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "heavy-2".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "binary-patch-create".into(),
                session_id: None,
            })
            .unwrap_err();
        assert_eq!(second_error.code, "heavy_job_busy");
        let finished = service
            .finish(FinishToolboxJobRequest {
                request_id: "finish-heavy-1".into(),
                job_id: first.job_id.clone(),
                expected_revision: None,
                succeeded: true,
                error: None,
            })
            .unwrap();
        assert!(finished.output_expires_at_ms.is_none());
        service.reconcile_at(u64::MAX);
        assert_eq!(service.jobs[&first.job_id].status, JobStatus::Completed);
    }

    #[test]
    fn registered_output_expires_and_releases_bytes() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "ttl-start".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap();
        let ready = service
            .register_output(RegisterToolboxOutputRequest {
                request_id: "ttl-output".into(),
                job_id: job.job_id.clone(),
                generation: 1,
                reset_epoch: 0,
                bytes: vec![1],
                validation: OutputValidation::Verified,
            })
            .unwrap();
        let expires_at = ready.output_expires_at_ms.unwrap();
        service.reconcile_at(expires_at);
        assert_eq!(service.jobs[&job.job_id].status, JobStatus::Expired);
        assert!(service.outputs.is_empty());
    }

    #[test]
    fn file_hash_completion_does_not_receive_output_ttl() {
        let mut service = ToolboxService::new();
        let job = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "hash-ttl-start".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "file-sha256".into(),
                session_id: None,
            })
            .unwrap();
        let completed = service
            .finish(FinishToolboxJobRequest {
                request_id: "hash-ttl-finish".into(),
                job_id: job.job_id.clone(),
                expected_revision: None,
                succeeded: true,
                error: None,
            })
            .unwrap();
        assert!(completed.output_expires_at_ms.is_none());
        service.reconcile_at(u64::MAX);
        assert_eq!(service.jobs[&job.job_id].status, JobStatus::Completed);
    }

    #[test]
    fn stale_creation_cannot_restore_state_after_clear() {
        let mut service = ToolboxService::new();
        service.clear("clear", None).unwrap();
        let error = service
            .start(ToolboxJobRequest {
                common: ToolboxRequest {
                    request_id: "late".into(),
                    expected_revision: None,
                    generation: Some(1),
                    reset_epoch: Some(0),
                },
                tool_id: "image-watermark".into(),
                session_id: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "stale_job");
        assert!(service.snapshot().jobs.is_empty());
    }

    #[test]
    fn input_resources_are_owned_by_job_and_release_on_cancel() {
        let mut service = ToolboxService::new();
        let request = ToolboxJobRequest {
            common: ToolboxRequest {
                request_id: "start".into(),
                expected_revision: None,
                generation: Some(2),
                reset_epoch: Some(0),
            },
            tool_id: "image-watermark".into(),
            session_id: None,
        };
        let job = service.start(request.clone()).unwrap();
        assert_eq!(service.start(request.clone()).unwrap().job_id, job.job_id);
        assert_eq!(service.snapshot().resources.len(), 1);
        let mut conflict = request;
        conflict.tool_id = "binary-patch-create".into();
        assert_eq!(
            service.start(conflict).unwrap_err().code,
            "request_conflict"
        );
        let key = FileJobKey {
            job_id: job.job_id.clone(),
            generation: 2,
            reset_epoch: 0,
        };
        let inputs = service.inputs_for_job(&key).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source");
        std::fs::write(&path, b"fixture").unwrap();
        let token = inputs
            .prepare(&key, crate::toolbox_inputs::InputRole::Input, &[path])
            .unwrap()
            .remove(0);
        assert_eq!(
            service.cancel("cancel", &job.job_id, None).unwrap().status,
            JobStatus::Cancelled
        );
        assert!(service.snapshot().resources.is_empty());
        assert!(inputs.read(&key, &token.token, 0, 1).is_err());
    }
}
