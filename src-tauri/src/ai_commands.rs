use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::*;
use crate::{AppState, ai_context_bridge};

fn help_url(topic: &str) -> Result<&'static str, AiError> {
    match topic {
        "ollama" => Ok("https://docs.ollama.com/quickstart"),
        "openai" => Ok("https://developers.openai.com/api/docs/quickstart"),
        "anthropic" => Ok("https://platform.claude.com/docs/en/api/overview"),
        "deepseek" => Ok("https://api-docs.deepseek.com/"),
        "bailian" => Ok("https://help.aliyun.com/en/model-studio/base-url"),
        "openai-data" => Ok("https://developers.openai.com/api/docs/guides/your-data"),
        _ => Err(AiError::new(
            "invalid_help_topic",
            "Choose a built-in AI help topic.",
        )),
    }
}

#[tauri::command]
pub async fn ai_open_help(topic: String) -> Result<(), AiError> {
    let url = help_url(&topic)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::user_actions::open_external_url(url).map_err(|_| {
            AiError::new(
                "help_unavailable",
                "The official help page could not be opened.",
            )
        })
    })
    .await
    .map_err(|_| {
        AiError::new(
            "help_unavailable",
            "The official help page could not be opened.",
        )
    })?
}

#[derive(Clone)]
struct SourceClear {
    categories: Vec<String>,
    finishing: bool,
}

pub struct AiRuntime {
    pub service: Result<Arc<AiService>, AiError>,
    pub context_gate: tokio::sync::RwLock<()>,
    pub application_results: Arc<crate::application_capabilities::ApplicationResults>,
    pub cleared_at: AtomicU64,
    invalidation_path: Option<std::path::PathBuf>,
    invalidation_lock: Mutex<()>,
    source_clears: Mutex<HashMap<u64, SourceClear>>,
    clear_sequence: AtomicU64,
}

impl AiRuntime {
    pub fn open(app: &AppHandle) -> Self {
        let invalidation_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join("ai-source-invalidations-v1.json"));
        let service = app
            .path()
            .app_data_dir()
            .map_err(|_| AiError::storage("Application storage unavailable"))
            .and_then(|directory| AiService::open(directory.join("ai-conversations-v1.sqlite")))
            .and_then(|service| {
                if let Some(path) = &invalidation_path {
                    let categories = read_invalidations(path)?;
                    for category in categories {
                        service.invalidate_source(&category, false)?;
                    }
                    crate::private_storage::remove(path).map_err(AiError::storage)?;
                }
                Ok(Arc::new(service))
            });
        if let Ok(service) = &service {
            let task_app = app.clone();
            service.set_tool_executor(Arc::new(move |call, context| {
                Box::pin(crate::ai_task_bridge::execute(
                    task_app.clone(),
                    call,
                    context,
                ))
            }));
            let app = app.clone();
            service.set_notifier(Arc::new(move || {
                // Only wake authorized views. Conversation content never goes on the global event bus.
                let _ = app.emit_to("main", "ai-state-changed", ());
                let _ = app.emit_to("robin-chat", "ai-state-changed", ());
            }));
        }
        Self {
            service,
            context_gate: tokio::sync::RwLock::new(()),
            application_results: app.state::<AppState>().application_results.clone(),
            cleared_at: AtomicU64::new(0),
            invalidation_path,
            invalidation_lock: Mutex::new(()),
            source_clears: Mutex::new(HashMap::new()),
            clear_sequence: AtomicU64::new(1),
        }
    }

    pub fn get(&self) -> Result<&Arc<AiService>, AiError> {
        self.service.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn require_source_ready(&self) -> Result<(), AiError> {
        if !self
            .source_clears
            .lock()
            .map_err(AiError::storage)?
            .is_empty()
        {
            return Err(AiError::new(
                "privacy_clear_in_progress",
                "Source data is being cleared. Wait for the privacy operation to finish before preparing or sending a message. If the window reloaded during removal, restart CoreRobin and retry the clear operation.",
            ));
        }
        Ok(())
    }

    pub fn require_source_write_ready(&self, category: &str) -> Result<(), AiError> {
        let categories = ai_context_bridge::categories_for_history(category);
        if self
            .source_clears
            .lock()
            .map_err(AiError::storage)?
            .values()
            .any(|operation| {
                operation
                    .categories
                    .iter()
                    .any(|source| categories.contains(&source.as_str()))
            })
        {
            return Err(AiError::new(
                "source_clear_in_progress",
                "This history category is being cleared. Old snapshots cannot be saved.",
            ));
        }
        Ok(())
    }

    fn begin_source_clear(
        &self,
        categories: &[&str],
        delete_related: bool,
    ) -> Result<u64, AiError> {
        // Only retry operations whose source deletions have already settled. An
        // unrelated operation still deleting files must keep its preparation block.
        let retries: Vec<_> = self
            .source_clears
            .lock()
            .map_err(AiError::storage)?
            .iter()
            .filter_map(|(token, operation)| operation.finishing.then_some(*token))
            .collect();
        for token in retries {
            self.finish_source_clear(token)?;
        }
        self.invalidate(categories, delete_related)?;
        let token = self.clear_sequence.fetch_add(1, Ordering::Relaxed);
        self.source_clears.lock().map_err(AiError::storage)?.insert(
            token,
            SourceClear {
                categories: categories.iter().map(|value| (*value).to_owned()).collect(),
                finishing: false,
            },
        );
        Ok(token)
    }

    fn finish_source_clear(&self, token: u64) -> Result<(), AiError> {
        let categories = {
            let mut pending = self.source_clears.lock().map_err(AiError::storage)?;
            pending.get_mut(&token).map(|operation| {
                operation.finishing = true;
                operation.categories.clone()
            })
        };
        if let Some(categories) = categories {
            self.invalidate(
                &categories.iter().map(String::as_str).collect::<Vec<_>>(),
                false,
            )?;
            self.source_clears
                .lock()
                .map_err(AiError::storage)?
                .remove(&token);
        }
        Ok(())
    }

    pub fn invalidate(&self, categories: &[&str], delete_related: bool) -> Result<(), AiError> {
        self.cleared_at
            .fetch_max(crate::now_millis(), Ordering::AcqRel);
        if let Ok(service) = &self.service {
            for category in categories {
                service.invalidate_source(category, delete_related)?;
            }
        } else {
            if delete_related {
                return Err(self.service.as_ref().err().unwrap().clone());
            }
            // Keep existing privacy controls usable when the AI database cannot open.
            // Before clearing source files, durably record the required invalidation.
            // AI cannot become usable again until startup has applied this marker.
            let _lock = self.invalidation_lock.lock().map_err(AiError::storage)?;
            let path = self
                .invalidation_path
                .as_ref()
                .ok_or_else(|| AiError::storage("No private storage directory"))?;
            let mut pending = read_invalidations(path)?;
            pending.extend(categories.iter().map(|category| (*category).to_owned()));
            pending.sort();
            pending.dedup();
            crate::private_storage::write_atomic(
                path,
                &serde_json::to_vec(&pending).map_err(AiError::storage)?,
            )
            .map_err(AiError::storage)?;
        }
        if categories.contains(&"network_quality") {
            self.application_results
                .clear_network()
                .map_err(AiError::storage)?;
        }
        Ok(())
    }
}

fn read_invalidations(path: &std::path::Path) -> Result<Vec<String>, AiError> {
    let Some(bytes) = crate::private_storage::read_limited(path, 4096).map_err(AiError::storage)?
    else {
        return Ok(Vec::new());
    };
    let categories: Vec<String> = serde_json::from_slice(&bytes).map_err(AiError::storage)?;
    if categories.iter().any(|category| {
        ![
            "resources",
            "network_quality",
            "connections",
            "applications",
            "incidents",
        ]
        .contains(&category.as_str())
    }) {
        return Err(AiError::storage("Invalid source invalidation marker"));
    }
    Ok(categories)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unavailable_runtime(path: std::path::PathBuf) -> AiRuntime {
        AiRuntime {
            service: Err(AiError::storage("Test database unavailable")),
            context_gate: tokio::sync::RwLock::new(()),
            application_results: Arc::new(
                crate::application_capabilities::ApplicationResults::default(),
            ),
            cleared_at: AtomicU64::new(0),
            invalidation_path: Some(path),
            invalidation_lock: Mutex::new(()),
            source_clears: Mutex::new(HashMap::new()),
            clear_sequence: AtomicU64::new(1),
        }
    }

    #[test]
    fn fallback_marker_merges_categories_and_rejects_unsafe_contents() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("invalidations.json");
        let runtime = unavailable_runtime(path.clone());
        runtime
            .invalidate(&["resources", "incidents"], false)
            .unwrap();
        runtime
            .invalidate(&["resources", "network_quality"], false)
            .unwrap();
        assert_eq!(
            read_invalidations(&path).unwrap(),
            ["incidents", "network_quality", "resources"]
        );
        assert!(runtime.invalidate(&["resources"], true).is_err());
        std::fs::write(&path, b"[\"unknown_category\"]").unwrap();
        assert!(read_invalidations(&path).is_err());
        assert!(runtime.begin_source_clear(&["resources"], false).is_err());
        assert!(runtime.source_clears.lock().unwrap().is_empty());
    }

    #[test]
    fn overlapping_clears_block_preparation_until_every_operation_finishes() {
        let root = tempfile::tempdir().unwrap();
        let runtime = unavailable_runtime(root.path().join("invalidations.json"));
        let first = runtime.begin_source_clear(&["resources"], false).unwrap();
        let second = runtime
            .begin_source_clear(&["network_quality"], false)
            .unwrap();
        runtime.finish_source_clear(second).unwrap();
        assert!(runtime.require_source_ready().is_err());
        assert!(runtime.require_source_write_ready("resource").is_err());
        runtime.finish_source_clear(first).unwrap();
        assert!(runtime.require_source_ready().is_ok());
        runtime.finish_source_clear(first).unwrap();
    }

    #[test]
    fn failed_finish_remains_blocked_and_is_retried_before_a_new_clear() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("invalidations.json");
        let runtime = unavailable_runtime(path.clone());
        let token = runtime.begin_source_clear(&["resources"], false).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(runtime.finish_source_clear(token).is_err());
        assert!(runtime.require_source_ready().is_err());
        std::fs::remove_dir(&path).unwrap();
        let next = runtime.begin_source_clear(&["incidents"], false).unwrap();
        assert!(!runtime.source_clears.lock().unwrap().contains_key(&token));
        assert_eq!(
            read_invalidations(&path).unwrap(),
            ["incidents", "resources"]
        );
        runtime.finish_source_clear(next).unwrap();
        assert!(runtime.require_source_ready().is_ok());
    }
}

#[tauri::command]
pub async fn ai_get_state(state: State<'_, AiRuntime>) -> Result<AiState, AiError> {
    state.get()?.get_state()
}
#[tauri::command]
pub async fn ai_update_settings(
    state: State<'_, AiRuntime>,
    input: AiSettings,
) -> Result<AiState, AiError> {
    state.get()?.update_settings(input)
}
#[tauri::command]
pub async fn ai_save_connection(
    state: State<'_, AiRuntime>,
    input: SaveConnectionInput,
) -> Result<ConnectionProfile, AiError> {
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.save_connection(input))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The connection credential update did not complete.",
            )
        })?
}
#[tauri::command]
pub async fn ai_delete_connection(
    state: State<'_, AiRuntime>,
    connection_id: String,
) -> Result<(), AiError> {
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.delete_connection(&connection_id))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The connection credential removal did not complete.",
            )
        })?
}
#[tauri::command]
pub async fn ai_set_credential(
    state: State<'_, AiRuntime>,
    input: SetCredentialInput,
) -> Result<(), AiError> {
    // Credential backends may wait for a system unlock prompt; keep that off the async executor.
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.set_credential(input))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The system credential service could not complete this operation.",
            )
        })?
}
#[tauri::command]
pub async fn ai_delete_credential(
    state: State<'_, AiRuntime>,
    connection_id: String,
) -> Result<(), AiError> {
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.delete_credential(&connection_id))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The system credential service could not complete this operation.",
            )
        })?
}
#[tauri::command]
pub async fn ai_set_proxy_credential(
    state: State<'_, AiRuntime>,
    input: SetProxyCredentialInput,
) -> Result<(), AiError> {
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.set_proxy_credential(input))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The system credential service could not complete this operation.",
            )
        })?
}
#[tauri::command]
pub async fn ai_delete_proxy_credential(
    state: State<'_, AiRuntime>,
    connection_id: String,
) -> Result<(), AiError> {
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.delete_proxy_credential(&connection_id))
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "The system credential service could not complete this operation.",
            )
        })?
}
#[tauri::command]
pub async fn ai_list_models(
    state: State<'_, AiRuntime>,
    connection_id: String,
) -> Result<Vec<ModelInfo>, AiError> {
    state.get()?.list_models(&connection_id).await
}
#[tauri::command]
pub async fn ai_test_model(
    state: State<'_, AiRuntime>,
    selection: ModelSelection,
) -> Result<ProviderCompletion, AiError> {
    state.get()?.test_model(selection).await
}
#[tauri::command]
pub async fn ai_create_session(
    state: State<'_, AiRuntime>,
    input: CreateSessionInput,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .create_session(input)
        .map(|session| SessionView::page(session, None))
}
#[tauri::command]
pub async fn ai_list_sessions(
    state: State<'_, AiRuntime>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<SessionPage, AiError> {
    state.get()?.list_sessions(offset, limit)
}
#[tauri::command]
pub async fn ai_get_session(
    state: State<'_, AiRuntime>,
    session_id: String,
    before: Option<u32>,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .get_session(&session_id)
        .map(|session| SessionView::page(session, before))
}
#[tauri::command]
pub async fn ai_rename_session(
    state: State<'_, AiRuntime>,
    session_id: String,
    title: String,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .rename_session(&session_id, &title)
        .map(|session| SessionView::page(session, None))
}
#[tauri::command]
pub async fn ai_delete_session(
    state: State<'_, AiRuntime>,
    session_id: String,
) -> Result<(), AiError> {
    state.get()?.delete_session(&session_id)
}
#[tauri::command]
pub async fn ai_clear_conversations(state: State<'_, AiRuntime>) -> Result<(), AiError> {
    state.get()?.clear_conversations()
}
#[tauri::command]
pub async fn ai_save_draft(
    state: State<'_, AiRuntime>,
    input: SaveDraftInput,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .save_draft(input)
        .map(|session| SessionView::page(session, None))
}
#[tauri::command]
pub async fn ai_set_session_context(
    state: State<'_, AiRuntime>,
    input: SetSessionContextInput,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .set_session_context(input)
        .map(|session| SessionView::page(session, None))
}
#[tauri::command]
pub async fn ai_select_session_model(
    state: State<'_, AiRuntime>,
    input: SelectSessionModelInput,
) -> Result<SessionView, AiError> {
    state
        .get()?
        .select_session_model(input)
        .map(|session| SessionView::page(session, None))
}
#[tauri::command]
pub async fn ai_prepare(
    app: AppHandle,
    state: State<'_, AiRuntime>,
    input: PrepareInput,
) -> Result<PreparedAnalysis, AiError> {
    let _gate = state.context_gate.read().await;
    state.require_source_ready()?;
    let now = crate::now_millis();
    let mut facts = if input.include_context && input.scenario == "network" {
        match state
            .application_results
            .snapshot()
            .map_err(AiError::storage)?
            .network
            .as_ref()
            .map(ai_context_bridge::network_result)
        {
            Some(mut facts) => {
                facts.coverage.push(format!("The latest completed network check is {} seconds old; no new check was started.", now.saturating_sub(facts.captured_at) / 1000));
                facts
            }
            None => AiContextFacts {
                captured_at: now,
                coverage: vec![
                    "There is no completed network check in this application session.".into(),
                ],
                ..Default::default()
            },
        }
    } else if input.include_context && input.scenario != "history" {
        let summary = app.state::<AppState>().sampler.cached_summary();
        ai_context_bridge::current_summary(summary.as_ref(), now)
    } else {
        AiContextFacts {
            captured_at: now,
            ..Default::default()
        }
    };
    if input.include_context {
        let directory = app.path().app_data_dir().map_err(AiError::storage)?;
        ai_context_bridge::append_history(&mut facts, &directory, &input, now)?;
        if let Ok(Some(health)) = app.state::<AppState>().health_state.current()
            && input.scenario == "current_status"
        {
            ai_context_bridge::append_health(
                &mut facts,
                &health.update,
                input.incident_id.as_deref(),
                now,
                state.cleared_at.load(Ordering::Acquire),
            );
        }
    }
    state.get()?.prepare_with_context(input, facts)
}
#[tauri::command]
pub async fn ai_start(
    state: State<'_, AiRuntime>,
    input: StartInput,
) -> Result<AnalysisRun, AiError> {
    let _gate = state.context_gate.read().await;
    state.require_source_ready()?;
    state.get()?.start(input)
}
#[tauri::command]
pub async fn ai_cancel(state: State<'_, AiRuntime>, request_id: String) -> Result<(), AiError> {
    state.get()?.cancel(&request_id)
}
#[tauri::command]
pub async fn ai_run_capability_action(
    window: tauri::WebviewWindow,
    state: State<'_, AiRuntime>,
    input: crate::ai::capability_actions::CapabilityActionInput,
) -> Result<AnalysisRun, AiError> {
    if !matches!(window.label(), "main" | "robin-chat") {
        return Err(AiError::new(
            "capability_window_forbidden",
            "This window cannot operate application cards.",
        ));
    }
    let _gate = state.context_gate.read().await;
    state.require_source_ready()?;
    if matches!(
        input.action,
        crate::ai::capability_actions::CapabilityAction::Trash
    ) {
        let session = state.get()?.get_session(&input.session_id)?;
        let source = session
            .messages
            .iter()
            .find(|message| message.id == input.message_id)
            .and_then(|message| {
                message
                    .tool_steps
                    .iter()
                    .find(|step| step.id == input.step_id)
            })
            .and_then(|step| step.result.as_deref())
            .and_then(|result| serde_json::from_str::<serde_json::Value>(result).ok());
        let revision = source
            .as_ref()
            .and_then(|result| result.get("sourceRevision"))
            .and_then(|value| value.as_u64());
        if revision
            != Some(
                state
                    .application_results
                    .snapshot()
                    .map_err(AiError::storage)?
                    .disk_revision,
            )
        {
            return Err(crate::ai::capability_actions::expired());
        }
    }
    state.get()?.start_capability_action(input)
}

#[tauri::command]
pub async fn ai_resolve_tool_confirmation(
    state: State<'_, AiRuntime>,
    request_id: String,
    step_id: String,
    approved: bool,
) -> Result<(), AiError> {
    let _gate = state.context_gate.read().await;
    state.require_source_ready()?;
    state
        .get()?
        .resolve_tool_confirmation(&request_id, &step_id, approved)
}
#[tauri::command]
pub async fn ai_clear_all_data(state: State<'_, AiRuntime>) -> Result<(), AiError> {
    let _gate = state.context_gate.write().await;
    state
        .application_results
        .clear_network()
        .map_err(AiError::storage)?;
    let service = Arc::clone(state.get()?);
    tauri::async_runtime::spawn_blocking(move || service.clear_all())
        .await
        .map_err(|_| {
            AiError::new(
                "credential_unavailable",
                "Clearing AI credentials did not complete.",
            )
        })?
}

/// Explicit privacy-center operation; source removals below also invalidate independently.
#[tauri::command]
pub async fn ai_invalidate_source(
    state: State<'_, AiRuntime>,
    category: String,
    delete_related: bool,
) -> Result<u64, AiError> {
    let categories: &[&str] = match category.as_str() {
        "resourceHistory" => &["resources", "incidents", "applications"],
        "connectionHistory" => &["connections", "network_quality"],
        "connections" => &["connections"],
        "networkQuality" => &["network_quality"],
        "userActions" => &["incidents"],
        "applicationInventory" => &["applications"],
        "scanCaches" => &["incidents"],
        _ => return Err(AiError::new("invalid_category", "Unknown data category.")),
    };
    let _gate = state.context_gate.write().await;
    state.begin_source_clear(categories, delete_related)
}

/// Ends the complete category operation, including its frontend caches. Until this
/// acknowledgment, no window can prepare or start a new request between source clears.
#[tauri::command]
pub async fn ai_finish_source_clear(
    state: State<'_, AiRuntime>,
    token: u64,
) -> Result<(), AiError> {
    let _gate = state.context_gate.write().await;
    state.finish_source_clear(token)
}
