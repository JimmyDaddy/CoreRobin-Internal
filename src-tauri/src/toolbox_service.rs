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
                        state: "unavailable".to_owned(),
                        reason: Some("Tool implementation is not registered yet.".to_owned()),
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
        // C00 deliberately exposes the lifecycle, but it must not report an
        // unavailable module as a successful job. Real modules register their
        // provider with W02 before this command is allowed to create a job.
        Err(CommandError::new(
            "tool_unavailable",
            "This toolbox provider is not available in the native service yet.",
        ))
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
}
