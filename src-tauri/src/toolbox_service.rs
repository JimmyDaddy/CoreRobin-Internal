use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::toolbox_contracts::{
    JobStatus, TOOLBOX_CONTRACT_VERSION, TerminalReason, ToolboxCapability, ToolboxJob,
    ToolboxJobRequest, ToolboxResource, ToolboxSession, ToolboxSnapshot,
};

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

#[derive(Default)]
pub struct ToolboxService {
    service_instance_id: String,
    revision: u64,
    reset_epoch: u64,
    sessions: HashMap<String, ToolboxSession>,
    jobs: HashMap<String, ToolboxJob>,
    request_results: HashMap<String, ToolboxJob>,
    accepted_requests: HashSet<String>,
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
                (
                    (*id).to_owned(),
                    ToolboxCapability {
                        state: if WEB_MANAGED_TOOL_IDS.contains(id) {
                            "degraded"
                        } else {
                            "unavailable"
                        }
                        .to_owned(),
                        reason: if WEB_MANAGED_TOOL_IDS.contains(id) {
                            Some("Web Worker provider is bounded but native file/job export integration is still limited.".to_owned())
                        } else {
                            Some("Tool implementation is not registered yet.".to_owned())
                        },
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
            resources: Vec::<ToolboxResource>::new(),
            jobs: self.jobs.values().cloned().collect(),
            capabilities,
        }
    }

    pub fn start(&mut self, request: ToolboxJobRequest) -> Result<ToolboxJob, CommandError> {
        if request.common.request_id.trim().is_empty() {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        if let Some(previous) = self.request_results.get(&request.common.request_id) {
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
        let session_id = request
            .session_id
            .unwrap_or_else(|| format!("toolbox-session-{}", request.common.request_id));
        let generation = request.common.generation.unwrap_or_default();
        let now = now_millis().min(u64::MAX as u128) as u64;
        self.sessions
            .entry(session_id.clone())
            .or_insert_with(|| ToolboxSession {
                session_id: session_id.clone(),
                tool_id: request.tool_id.clone(),
                status: crate::toolbox_contracts::SessionStatus::Running,
                generation,
                created_at_ms: now,
                terminal_reason: None,
            });
        let job = ToolboxJob {
            job_id: format!("toolbox-job-{}", request.common.request_id),
            session_id,
            status: JobStatus::Running,
            generation,
            reset_epoch: self.reset_epoch,
            output_expires_at_ms: None,
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
        if !matches!(
            job.status,
            JobStatus::Completed | JobStatus::Cancelled | JobStatus::Expired | JobStatus::Failed
        ) {
            if request.succeeded {
                job.status = JobStatus::Completed;
                job.terminal_reason = Some(TerminalReason::Completed);
                job.error = None;
            } else {
                job.status = JobStatus::Failed;
                job.terminal_reason = Some(TerminalReason::Failed);
                job.error = request.error;
            }
            self.revision = self.revision.saturating_add(1);
        }
        self.request_results.insert(request.request_id, job.clone());
        Ok(job.clone())
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
            job.status = JobStatus::Cancelled;
            job.terminal_reason = Some(TerminalReason::Cancelled);
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
        self.reset_epoch = self.reset_epoch.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        self.sessions.clear();
        self.jobs.clear();
        self.request_results.clear();
        self.accepted_requests.clear();
        Ok(self.snapshot())
    }

    #[cfg(test)]
    fn seed_job(&mut self, job: ToolboxJob) {
        self.jobs.insert(job.job_id.clone(), job);
    }
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
    fn clear_advances_epoch_and_removes_state() {
        let mut service = ToolboxService::new();
        service.seed_job(ToolboxJob {
            job_id: "job-1".to_owned(),
            session_id: "session-1".to_owned(),
            status: JobStatus::Running,
            generation: 1,
            reset_epoch: 0,
            output_expires_at_ms: None,
            terminal_reason: None,
            error: None,
        });
        let snapshot = service.clear("clear-1", Some(0)).unwrap();
        assert_eq!(snapshot.reset_epoch, 1);
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
    }
}
