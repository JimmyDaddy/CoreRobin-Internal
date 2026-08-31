use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::toolbox_contracts::{
    JobStatus, TOOLBOX_CONTRACT_VERSION, TerminalReason, ToolboxCapability, ToolboxJob,
    ToolboxJobRequest, ToolboxResource, ToolboxSession, ToolboxSnapshot,
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
        let mut released = true;
        for job in self.jobs.values_mut() {
            if !self.inputs.cancel(&job.job_id) {
                job.status = JobStatus::Stopping;
                job.terminal_reason = Some(TerminalReason::ReleaseUnconfirmed);
                released = false;
            }
        }
        if !released {
            self.revision = self.revision.saturating_add(1);
            return Err(CommandError::new(
                "release_unconfirmed",
                "File operations are still stopping; retry clear after release is confirmed.",
            ));
        }
        self.reset_epoch = self.reset_epoch.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        self.sessions.clear();
        self.jobs.clear();
        self.request_results.clear();
        self.clearing = false;
        Ok(self.snapshot())
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

    pub fn reconcile(&mut self) {
        for job in self.jobs.values_mut() {
            if job.status == JobStatus::Stopping && self.inputs.cancel(&job.job_id) {
                job.status = JobStatus::Cancelled;
                job.terminal_reason = Some(TerminalReason::Cancelled);
                if let Some(session) = self.sessions.get_mut(&job.session_id) {
                    session.status = crate::toolbox_contracts::SessionStatus::Ended;
                    session.terminal_reason = Some(TerminalReason::Cancelled);
                }
                self.revision = self.revision.saturating_add(1);
            }
        }
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
        assert!(service.snapshot().resources.is_empty());
        assert_eq!(
            service.snapshot().sessions[0].status,
            crate::toolbox_contracts::SessionStatus::Ended
        );
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
