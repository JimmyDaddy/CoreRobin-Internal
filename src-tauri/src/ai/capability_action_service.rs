use super::*;
use crate::ai::capability_actions::{
    self as cards, CapabilityAction, CapabilityActionInput, SavedTargets,
};
use serde_json::json;

pub(super) fn decorate_card_actions(inner: &Inner, value: &mut AiSession) {
    for message in &mut value.messages {
        let saved = message
            .request_id
            .as_ref()
            .and_then(|id| inner.tool_targets.get(id))
            .filter(|saved| {
                saved.session_id == value.summary.id
                    && saved.epoch == inner.request_epoch
                    && saved.expires_at > now()
            });
        for step in &mut message.tool_steps {
            step.actions_expires_at = saved
                .filter(|_| step.state == "complete")
                .map(|saved| saved.expires_at);
        }
    }
}

impl AiService {
    pub(super) fn remember_tool_targets(
        &self,
        request_id: &str,
        targets: Arc<Mutex<HashMap<String, tools::NativeTarget>>>,
    ) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        let active = inner
            .active
            .as_ref()
            .filter(|active| active.run.request_id == request_id)
            .ok_or_else(stale)?;
        let session_id = active.session.summary.id.clone();
        let epoch = inner.request_epoch;
        inner
            .tool_targets
            .retain(|_, saved| saved.expires_at > now() && saved.epoch == epoch);
        if inner.tool_targets.len() >= cards::MAX_TARGET_SETS
            && let Some(oldest) = inner
                .tool_targets
                .iter()
                .min_by_key(|(_, saved)| saved.expires_at)
                .map(|(id, _)| id.clone())
        {
            inner.tool_targets.remove(&oldest);
        }
        inner.tool_targets.insert(
            request_id.into(),
            SavedTargets {
                session_id,
                epoch,
                expires_at: now() + cards::TARGET_LIFETIME_MS,
                targets,
            },
        );
        Ok(())
    }

    pub(super) fn begin_tool_step(
        &self,
        request_id: &str,
        step_id: &str,
        name: &str,
    ) -> Result<(), AiError> {
        self.update_task(request_id, |active| {
            let message = active.session.messages.last_mut().ok_or_else(stale)?;
            message.tool_steps.push(ToolStep {
                actions_expires_at: None,
                id: step_id.into(),
                name: name.into(),
                state: "running".into(),
                started_at: now(),
                finished_at: None,
                result: None,
                error: None,
                confirmation: None,
            });
            message.status = "streaming".into();
            active.run.state = "streaming".into();
            for category in tools::categories(name) {
                if !message
                    .source_categories
                    .iter()
                    .any(|source| source == category)
                {
                    message.source_categories.push((*category).into());
                }
                if !active
                    .session
                    .summary
                    .source_categories
                    .iter()
                    .any(|source| source == category)
                {
                    active
                        .session
                        .summary
                        .source_categories
                        .push((*category).into());
                }
            }
            Ok(())
        })
    }
    pub(super) fn complete_tool_step(
        &self,
        request_id: &str,
        step_id: &str,
        outcome: &Result<String, AiError>,
    ) -> Result<(), AiError> {
        self.update_task(request_id, |active| {
            let step = active
                .session
                .messages
                .last_mut()
                .and_then(|message| {
                    message
                        .tool_steps
                        .iter_mut()
                        .find(|step| step.id == step_id)
                })
                .ok_or_else(stale)?;
            step.finished_at = Some(now());
            step.state = if outcome.is_ok() {
                "complete"
            } else {
                "failed"
            }
            .into();
            match outcome {
                Ok(output) => step.result = Some(output.clone()),
                Err(error) => step.error = Some(error.clone()),
            }
            Ok(())
        })
    }
    // Both model calls and direct clicks use this exact dispatcher.
    pub(super) async fn invoke_tool(
        self: &Arc<Self>,
        executor: &tools::ToolExecutor,
        call: ToolCall,
        context: tools::ToolContext,
    ) -> Result<String, AiError> {
        self.check_tool_active(&context.request_id)?;
        tools::parse(&call)?;
        let value = executor(call, context).await?;
        let output = serde_json::to_string(&value).map_err(AiError::storage)?;
        if output.len() > tools::MAX_TOOL_RESULT_BYTES {
            return Err(AiError::new(
                "tool_result_too_large",
                "The tool result exceeded its size limit.",
            ));
        }
        Ok(output)
    }
    pub(crate) async fn execute_single_tool(
        self: &Arc<Self>,
        request_id: &str,
        call: ToolCall,
        scope: tools::ToolScope,
        targets: Arc<Mutex<HashMap<String, tools::NativeTarget>>>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AiError> {
        let executor = self
            .tool_executor
            .lock()
            .map_err(AiError::storage)?
            .clone()
            .ok_or_else(cards::expired)?;
        self.remember_tool_targets(request_id, targets.clone())?;
        let step_id = new_id()?;
        self.begin_tool_step(request_id, &step_id, &call.name)?;
        let outcome = self
            .invoke_tool(
                &executor,
                call,
                tools::ToolContext {
                    service: self.clone(),
                    request_id: request_id.into(),
                    step_id: step_id.clone(),
                    scope,
                    targets,
                    cancelled,
                },
            )
            .await;
        self.check_tool_active(request_id)?;
        self.complete_tool_step(request_id, &step_id, &outcome)?;
        outcome.map(|_| ())
    }
    pub(crate) fn finish_capability_action(&self, request_id: &str, outcome: Result<(), AiError>) {
        self.finish(
            request_id,
            outcome.map(|_| ProviderCompletion {
                text: String::new(),
                usage: None,
                reported_model: None,
                tool_calls: Vec::new(),
                continuation: Vec::new(),
            }),
        );
    }

    pub fn start_capability_action(
        self: &Arc<Self>,
        input: CapabilityActionInput,
    ) -> Result<AnalysisRun, AiError> {
        input.validate()?;
        let fingerprint = input.fingerprint()?;
        let (run, call, scope, targets, cancelled) = {
            let mut inner = self.lock()?;
            if let Some(previous) = inner
                .volatile_submissions
                .get(&input.submission_id)
                .cloned()
                .or(inner.store.submission(&input.submission_id)?)
            {
                if previous.preparation_id != fingerprint {
                    return Err(stale());
                }
                return Ok(previous);
            }
            if inner.clearing_all || inner.active.is_some() || inner.test_cancel.is_some() {
                return Err(busy());
            }
            if !inner.config.settings.enabled {
                return Err(AiError::new(
                    "ai_disabled",
                    "Enable the assistant before using its cards.",
                ));
            }
            if !inner.unsaved.is_empty() {
                return Err(AiError::storage(
                    "Save the unsaved result before another action.",
                ));
            }
            let mut current = session(&inner, &input.session_id)?;
            if current.summary.revision != input.expected_session_revision {
                return Err(stale());
            }
            if current.summary.storage_status == "error" {
                return Err(AiError::storage(
                    "The conversation cannot save another action.",
                ));
            }
            if current.messages.len() >= 1000
                || serde_json::to_vec(&current)
                    .map_err(AiError::storage)?
                    .len()
                    + MAX_TASK_METADATA_BYTES
                    > 16 * 1024 * 1024
            {
                return Err(AiError::new(
                    "conversation_limit",
                    "Start a new conversation before another action.",
                ));
            }
            if current.summary.temporary {
                let used = inner
                    .temporary
                    .values()
                    .map(|session| serde_json::to_vec(session).map(|bytes| bytes.len()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(AiError::storage)?
                    .into_iter()
                    .sum::<usize>();
                if used + MAX_TASK_METADATA_BYTES > 16 * 1024 * 1024 {
                    return Err(AiError::new(
                        "temporary_storage_full",
                        "Delete a temporary conversation before another action.",
                    ));
                }
            }
            let source_message = current
                .messages
                .iter()
                .find(|message| message.id == input.message_id)
                .ok_or_else(cards::expired)?;
            let source = source_message
                .tool_steps
                .iter()
                .find(|step| step.id == input.step_id)
                .ok_or_else(cards::expired)?;
            let consume_request = if matches!(input.action, CapabilityAction::Refresh) {
                None
            } else {
                source_message.request_id.clone()
            };
            let scope = tools::ToolScope {
                include_context: true,
                scenario: current.summary.scenario.clone(),
                incident_id: current.summary.incident_id.clone(),
                from_ms: current.summary.from_ms,
                to_ms: current.summary.to_ms,
            };
            let targets = Arc::new(Mutex::new(HashMap::new()));
            let call = match input.action {
                CapabilityAction::Refresh => {
                    if !input.target_refs.is_empty()
                        || !matches!(
                            source.name.as_str(),
                            "get_device_status"
                                | "get_process_usage"
                                | "get_recorded_history"
                                | "run_network_check"
                                | "scan_disk_usage"
                        )
                    {
                        return Err(cards::expired());
                    }
                    ToolCall {
                        id: new_id()?,
                        name: source.name.clone(),
                        arguments: json!({}),
                    }
                }
                _ => {
                    let saved = source_message
                        .request_id
                        .as_ref()
                        .and_then(|id| inner.tool_targets.get(id))
                        .filter(|saved| {
                            saved.session_id == input.session_id
                                && saved.epoch == inner.request_epoch
                                && saved.expires_at > now()
                        })
                        .ok_or_else(cards::expired)?;
                    if source.state != "complete"
                        || input.target_refs.is_empty()
                        || input
                            .target_refs
                            .iter()
                            .any(|reference| !cards::source_has_target(source, reference))
                    {
                        return Err(cards::expired());
                    }
                    let original = saved.targets.lock().map_err(AiError::storage)?;
                    let selected = input
                        .target_refs
                        .iter()
                        .map(|reference| {
                            original.get(reference).cloned().ok_or_else(cards::expired)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let reference = new_id()?;
                    let (name, target, arguments) = match input.action {
                        CapabilityAction::RequestClose | CapabilityAction::ForceKill
                            if source.name == "get_process_usage" && selected.len() == 1 =>
                        {
                            let target = selected.into_iter().next().ok_or_else(cards::expired)?;
                            if !matches!(target, tools::NativeTarget::Process { .. }) {
                                return Err(cards::expired());
                            }
                            (
                                "request_process_action",
                                target,
                                json!({"target_ref":reference,"action":if matches!(input.action, CapabilityAction::ForceKill) { "force_kill" } else { "request_close" }}),
                            )
                        }
                        CapabilityAction::Trash if source.name == "scan_disk_usage" => {
                            let mut requests = selected
                                .into_iter()
                                .map(|target| match target {
                                    tools::NativeTarget::Cleanup(request) => Ok(*request),
                                    _ => Err(cards::expired()),
                                })
                                .collect::<Result<Vec<_>, _>>()?
                                .into_iter();
                            let mut request = requests.next().ok_or_else(cards::expired)?;
                            for next in requests {
                                if next.scan_id != request.scan_id
                                    || next.scan_sampled_at_ms != request.scan_sampled_at_ms
                                    || next.scan_root != request.scan_root
                                {
                                    return Err(cards::expired());
                                }
                                request.directory_ids.extend(next.directory_ids);
                                request.paths.extend(next.paths);
                                request.expected_targets.extend(next.expected_targets);
                            }
                            (
                                "request_cleanup",
                                tools::NativeTarget::Cleanup(Box::new(request)),
                                json!({"target_ref":reference}),
                            )
                        }
                        _ => return Err(cards::expired()),
                    };
                    targets
                        .lock()
                        .map_err(AiError::storage)?
                        .insert(reference, target);
                    ToolCall {
                        id: new_id()?,
                        name: name.into(),
                        arguments,
                    }
                }
            };
            let run = AnalysisRun {
                request_id: new_id()?,
                session_id: current.summary.id.clone(),
                submission_id: input.submission_id,
                preparation_id: fingerprint,
                state: "pending".into(),
                started_at: now(),
                finished_at: None,
                error: None,
            };
            current.messages.push(AiMessage {
                tool_steps: Vec::new(),
                validated_result: None,
                id: new_id()?,
                role: "assistant".into(),
                content: String::new(),
                created_at: now(),
                status: "pending".into(),
                request_id: Some(run.request_id.clone()),
                model_label: None,
                source_categories: tools::categories(&call.name)
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
                reusable_in_context: false,
                usage: None,
                context_text: None,
            });
            current.summary.revision += 1;
            current.summary.updated_at = now();
            for category in tools::categories(&call.name) {
                if !current
                    .summary
                    .source_categories
                    .iter()
                    .any(|source| source == category)
                {
                    current.summary.source_categories.push((*category).into());
                }
            }
            // The button is not a send operation. Preserve the user's draft.
            let budget = inner.config.settings.storage_budget_bytes;
            inner.store.begin_run(&current, &run, budget)?;
            if let Some(source_request) = consume_request {
                inner.tool_targets.remove(&source_request);
            }
            if current.summary.temporary {
                inner
                    .temporary
                    .insert(current.summary.id.clone(), current.clone());
                inner
                    .volatile_submissions
                    .insert(run.submission_id.clone(), run.clone());
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            inner.active = Some(Active {
                application_action: true,
                pending_approval: None,
                run: run.clone(),
                session: current,
                cancelled: cancelled.clone(),
                persisted_bytes: 0,
                persisted_at: Instant::now(),
                notified_at: Instant::now(),
                request_epoch: inner.request_epoch,
                result_evidence: Vec::new(),
                result_capability: None,
            });
            inner
                .prepared
                .retain(|_, frozen| frozen.public.session_id != input.session_id);
            (run, call, scope, targets, cancelled)
        };
        self.notify();
        tauri::async_runtime::spawn(cards::finish_direct_action(
            self.clone(),
            run.request_id.clone(),
            call,
            scope,
            targets,
            cancelled,
        ));
        Ok(run)
    }
}
