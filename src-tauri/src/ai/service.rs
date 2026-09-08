use super::{
    context::{SYSTEM_PROMPT, build_preview},
    conversations::ConversationStore,
    credentials::{CredentialLookup, Credentials},
    providers, structured, tools, transport,
    types::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type Notifier = Arc<dyn Fn() + Send + Sync>;
#[derive(Clone, Serialize, Deserialize, Default)]
struct Config {
    settings: AiSettings,
    connections: Vec<ConnectionProfile>,
}
#[derive(Clone)]
struct Frozen {
    tool_scope: tools::ToolScope,
    public: PreparedAnalysis,
    profile: ConnectionProfile,
    evidence: Vec<EvidenceReference>,
    system: String,
}
struct Active {
    application_action: bool,
    pending_approval: Option<(String, tokio::sync::oneshot::Sender<bool>)>,
    run: AnalysisRun,
    session: AiSession,
    cancelled: Arc<AtomicBool>,
    persisted_bytes: usize,
    persisted_at: Instant,
    notified_at: Instant,
    request_epoch: u64,
    result_evidence: Vec<EvidenceReference>,
    result_capability: Option<CapabilityRecord>,
}
struct Inner {
    tool_targets: HashMap<String, super::capability_actions::SavedTargets>,
    store: ConversationStore,
    config: Config,
    credentials: Credentials,
    temporary: HashMap<String, AiSession>,
    unsaved: HashMap<String, AiSession>,
    prepared: HashMap<String, Frozen>,
    volatile_submissions: HashMap<String, AnalysisRun>,
    remote_models: BTreeSet<(String, u64, String)>,
    capabilities: Vec<CapabilityRecord>,
    active: Option<Active>,
    last_run: Option<AnalysisRun>,
    test_cancel: Option<Arc<AtomicBool>>,
    discovery_cancel: Option<Arc<AtomicBool>>,
    request_epoch: u64,
    clearing_all: bool,
}
pub struct AiService {
    tool_executor: Mutex<Option<tools::ToolExecutor>>,
    inner: Mutex<Inner>,
    notifier: Mutex<Option<Notifier>>,
    keyring_io: Arc<AtomicBool>,
}
struct KeyringIoGuard(Arc<AtomicBool>);
impl Drop for KeyringIoGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct CredentialPlan {
    auth: CredentialLookup,
    proxy: CredentialLookup,
}
impl CredentialPlan {
    fn needs_system_store(&self) -> bool {
        self.auth.requires_system_store() || self.proxy.requires_system_store()
    }
    fn resolve(self) -> Result<(Option<String>, Option<ProxyCredential>), AiError> {
        let auth = self.auth.resolve()?;
        let proxy = self
            .proxy
            .resolve()?
            .map(|secret| {
                serde_json::from_str(&secret).map_err(|_| {
                    AiError::new(
                        "credential_missing",
                        "Set this proxy credential again in AI settings.",
                    )
                })
            })
            .transpose()?;
        Ok((auth, proxy))
    }
}

impl AiService {
    pub fn open(path: PathBuf) -> Result<Self, AiError> {
        let store = ConversationStore::open(path)?;
        let mut config: Config = store.read_meta("config")?.unwrap_or_default();
        for profile in &mut config.connections {
            if profile.credential_status == "temporary" {
                profile.credential_status = "missing".into();
            }
            if profile.proxy_credential_status == "temporary" {
                profile.proxy_credential_status = "missing".into();
            }
        }
        let remote_models = store.read_meta("remote_models")?.unwrap_or_default();
        let capabilities: Vec<CapabilityRecord> = store
            .read_meta::<Vec<CapabilityRecord>>("capabilities")?
            .unwrap_or_default()
            .into_iter()
            .filter(|record| matches!(record.kind.as_str(), "address" | "discovery" | "text"))
            .collect();
        Ok(Self {
            tool_executor: Mutex::new(None),
            inner: Mutex::new(Inner {
                tool_targets: HashMap::new(),
                store,
                config,
                credentials: Credentials::default(),
                temporary: HashMap::new(),
                unsaved: HashMap::new(),
                prepared: HashMap::new(),
                volatile_submissions: HashMap::new(),
                remote_models,
                capabilities,
                active: None,
                last_run: None,
                test_cancel: None,
                discovery_cancel: None,
                request_epoch: 1,
                clearing_all: false,
            }),
            notifier: Mutex::new(None),
            keyring_io: Arc::new(AtomicBool::new(false)),
        })
    }
    pub fn set_notifier(&self, notifier: Notifier) {
        if let Ok(mut slot) = self.notifier.lock() {
            *slot = Some(notifier);
        }
    }
    pub fn set_tool_executor(&self, executor: tools::ToolExecutor) {
        if let Ok(mut slot) = self.tool_executor.lock() {
            *slot = Some(executor);
        }
    }
    fn notify(&self) {
        let notifier = self.notifier.lock().ok().and_then(|slot| slot.clone());
        if let Some(notifier) = notifier {
            notifier();
        }
    }
    fn lock(&self) -> Result<MutexGuard<'_, Inner>, AiError> {
        self.inner.lock().map_err(|_| {
            AiError::new(
                "runtime_unavailable",
                "AI is temporarily unavailable. Restart the application.",
            )
        })
    }
    fn keyring_guard(&self) -> Result<KeyringIoGuard, AiError> {
        self.keyring_io.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).map_err(|_|AiError::new("credential_busy","The system credential store is handling another request. You can cancel the AI request or retry after the system prompt closes."))?;
        Ok(KeyringIoGuard(self.keyring_io.clone()))
    }
    async fn resolve_credentials(
        self: &Arc<Self>,
        plan: CredentialPlan,
        cancel: Arc<AtomicBool>,
        seconds: u64,
    ) -> Result<(Option<String>, Option<ProxyCredential>), AiError> {
        if !plan.needs_system_store() {
            return plan.resolve();
        }
        let guard = self.keyring_guard()?;
        let task = tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            plan.resolve()
        });
        transport::cancellable(cancel, seconds, async move {
            task.await.map_err(|_| {
                AiError::new(
                    "credential_store_unavailable",
                    "The system credential lookup could not complete.",
                )
            })?
        })
        .await
    }
    fn ready_for_send(&self, request_id: &str, profile: &ConnectionProfile) -> Result<(), AiError> {
        let inner = self.lock()?;
        let current = inner
            .active
            .as_ref()
            .filter(|active| {
                active.run.request_id == request_id && !active.cancelled.load(Ordering::Acquire)
            })
            .ok_or_else(|| AiError::new("cancelled", "The request was cancelled."))?;
        if !inner.config.settings.enabled
            || inner.request_epoch != current.request_epoch
            || !inner.config.connections.iter().any(|connection| {
                connection.id == profile.id && connection.revision == profile.revision
            })
        {
            return Err(stale());
        }
        Ok(())
    }
    pub fn get_state(&self) -> Result<AiState, AiError> {
        let inner = self.lock()?;
        Ok(state(&inner))
    }
    pub fn update_settings(&self, input: AiSettings) -> Result<AiState, AiError> {
        if !(8 * 1024 * 1024..=2 * 1024 * 1024 * 1024).contains(&input.storage_budget_bytes) {
            return Err(invalid("Settings exceed their supported range."));
        }
        let mut inner = self.lock()?;
        if inner.clearing_all {
            return Err(busy());
        }
        if let Some(selection) = &input.default_model {
            validate_selection(&inner, selection)?;
        }
        let policy_changed =
            input.local_connections_only != inner.config.settings.local_connections_only;
        let mut config = inner.config.clone();
        config.settings = input;
        inner.store.write_meta("config", &config)?;
        inner.config = config;
        if !inner.config.settings.enabled || policy_changed {
            invalidate(&mut inner, "cancelled");
        }
        let result = state(&inner);
        drop(inner);
        self.notify();
        Ok(result)
    }
    pub fn save_connection(
        &self,
        input: SaveConnectionInput,
    ) -> Result<ConnectionProfile, AiError> {
        let _io = self.keyring_guard()?;
        if input.name.trim().is_empty() || input.name.chars().count() > 80 {
            return Err(invalid("Enter a connection name up to 80 characters."));
        }
        if !(10..=300).contains(&input.timeout_seconds)
            || !(32..=8192).contains(&input.max_output_tokens)
        {
            return Err(invalid(
                "Use a timeout between 10 and 300 seconds and an output limit between 32 and 8192 tokens.",
            ));
        }
        let mut inner = self.lock()?;
        if input.id.is_none() && inner.config.connections.len() >= 32 {
            return Err(invalid("At most 32 AI connections can be saved."));
        }
        let old = input
            .id
            .as_ref()
            .map(|id| profile(&inner, id).cloned())
            .transpose()?;
        if let Some(old) = &old
            && input.expected_revision != Some(old.revision)
        {
            return Err(stale());
        }
        let changed_target = old.as_ref().is_some_and(|old| {
            old.api_base_url != input.api_base_url
                || old.protocol != input.protocol
                || old.auth_kind != input.auth_kind
                || old.auth_header_name != input.auth_header_name
                || old.network_policy != input.network_policy
                || old.proxy_url != input.proxy_url
                || old.proxy_network_policy != input.proxy_network_policy
                || old.anthropic_workspace_id != input.anthropic_workspace_id
        });
        let mut profile = ConnectionProfile {
            id: old.as_ref().map(|old| old.id.clone()).unwrap_or(new_id()?),
            revision: old.as_ref().map(|old| old.revision + 1).unwrap_or(1),
            name: input.name.trim().to_owned(),
            protocol: input.protocol,
            api_base_url: input.api_base_url.trim_end_matches('/').into(),
            auth_kind: input.auth_kind,
            auth_header_name: input.auth_header_name,
            network_policy: input.network_policy,
            proxy_url: input.proxy_url.filter(|value| !value.is_empty()),
            proxy_network_policy: input.proxy_network_policy,
            proxy_credential_status: old
                .as_ref()
                .map(|old| old.proxy_credential_status.clone())
                .unwrap_or_else(|| "missing".into()),
            anthropic_workspace_id: input.anthropic_workspace_id,
            chat_token_limit_parameter: input.chat_token_limit_parameter,
            timeout_seconds: input.timeout_seconds,
            max_output_tokens: input.max_output_tokens,
            stream: input.stream,
            credential_status: old
                .as_ref()
                .map(|old| old.credential_status.clone())
                .unwrap_or_else(|| "missing".into()),
        };
        transport::validate_profile(&profile)?;
        if changed_target {
            let old = old.as_ref().expect("changed existing target");
            invalidate(&mut inner, "cancelled");
            drop(inner);
            self.notify();
            if old.credential_status == "saved" {
                Credentials::delete_persistent(&old.id)?;
            }
            if old.proxy_credential_status == "saved" {
                Credentials::delete_persistent(&proxy_slot(&old.id))?;
            }
            inner = self.lock()?;
            inner.credentials.forget_temporary(&old.id);
            inner.credentials.forget_temporary(&proxy_slot(&old.id));
            profile.credential_status = "missing".into();
            profile.proxy_credential_status = "missing".into();
        }
        if profile.auth_kind == AuthKind::None {
            profile.credential_status = "not_required".into();
        }
        if profile.proxy_url.is_none() || profile.network_policy == NetworkPolicy::Loopback {
            profile.proxy_credential_status = "not_required".into();
        }
        let mut config = inner.config.clone();
        config
            .connections
            .retain(|candidate| candidate.id != profile.id);
        config.connections.push(profile.clone());
        inner.store.write_meta("config", &config)?;
        inner.config = config;
        record_capability(
            &mut inner,
            capability_record(&profile, "", "address", "verified"),
        )?;
        invalidate(&mut inner, "cancelled");
        drop(inner);
        self.notify();
        Ok(profile)
    }
    pub fn delete_connection(&self, id: &str) -> Result<(), AiError> {
        let _io = self.keyring_guard()?;
        let mut inner = self.lock()?;
        let old = profile(&inner, id)?.clone();
        invalidate(&mut inner, "cancelled");
        drop(inner);
        self.notify();
        if old.credential_status == "saved" {
            Credentials::delete_persistent(id)?;
        }
        if old.proxy_credential_status == "saved" {
            Credentials::delete_persistent(&proxy_slot(id))?;
        }
        inner = self.lock()?;
        inner.credentials.forget_temporary(id);
        inner.credentials.forget_temporary(&proxy_slot(id));
        let mut config = inner.config.clone();
        config.connections.retain(|profile| profile.id != id);
        let remaining_capabilities: Vec<_> = inner
            .capabilities
            .iter()
            .filter(|record| record.connection_id != id)
            .cloned()
            .collect();
        inner
            .store
            .write_meta("capabilities", &remaining_capabilities)?;
        inner.capabilities = remaining_capabilities;
        let remaining_remote_models: BTreeSet<_> = inner
            .remote_models
            .iter()
            .filter(|(connection, _, _)| connection != id)
            .cloned()
            .collect();
        inner
            .store
            .write_meta("remote_models", &remaining_remote_models)?;
        inner.remote_models = remaining_remote_models;
        if config
            .settings
            .default_model
            .as_ref()
            .is_some_and(|selection| selection.connection_id == id)
        {
            config.settings.default_model = None;
        }
        inner.store.write_meta("config", &config)?;
        inner.config = config;
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn set_credential(&self, input: SetCredentialInput) -> Result<(), AiError> {
        Credentials::validate(&input.secret)?;
        self.set_secret(
            &input.connection_id,
            input.secret,
            input.temporary,
            false,
            None,
        )
    }
    pub fn delete_credential(&self, id: &str) -> Result<(), AiError> {
        self.delete_secret(id, false)
    }
    pub fn set_proxy_credential(&self, input: SetProxyCredentialInput) -> Result<(), AiError> {
        let proxy = ProxyCredential {
            username: input.username,
            password: input.password,
        };
        transport::validate_proxy_credential(&proxy)?;
        let secret = serde_json::to_string(&proxy).map_err(AiError::storage)?;
        Credentials::validate(&secret)?;
        self.set_secret(
            &input.connection_id,
            secret,
            input.temporary,
            true,
            Some(proxy),
        )
    }
    pub fn delete_proxy_credential(&self, id: &str) -> Result<(), AiError> {
        self.delete_secret(id, true)
    }
    fn set_secret(
        &self,
        id: &str,
        secret: String,
        temporary: bool,
        is_proxy: bool,
        proxy: Option<ProxyCredential>,
    ) -> Result<(), AiError> {
        let _io = self.keyring_guard()?;
        let mut inner = self.lock()?;
        let old = profile(&inner, id)?.clone();
        if is_proxy {
            if old.proxy_url.is_none() || old.network_policy == NetworkPolicy::Loopback {
                return Err(invalid(
                    "Configure an explicit proxy for a non-loopback connection first.",
                ));
            }
            transport::validate_proxy_auth(
                &old,
                proxy.as_ref().expect("validated proxy credential"),
            )?;
        } else if old.auth_kind == AuthKind::None {
            return Err(invalid("Select an authentication method first."));
        }
        invalidate(&mut inner, "cancelled");
        let slot = if is_proxy {
            proxy_slot(id)
        } else {
            id.to_owned()
        };
        let previous = if is_proxy {
            old.proxy_credential_status.clone()
        } else {
            old.credential_status.clone()
        };
        if !temporary {
            // Reserve the keyring reference durably before creating an entry.
            // A failed OS operation remains removable after a restart.
            let mut config = inner.config.clone();
            let changed = config
                .connections
                .iter_mut()
                .find(|value| value.id == id)
                .expect("profile exists");
            changed.revision += 1;
            if is_proxy {
                changed.proxy_credential_status = "saved".into();
            } else {
                changed.credential_status = "saved".into();
            }
            inner.store.write_meta("config", &config)?;
            inner.config = config;
            inner.credentials.forget_temporary(&slot);
        }
        drop(inner);
        self.notify();
        if temporary {
            if previous == "saved" {
                Credentials::delete_persistent(&slot)?;
            }
        } else {
            Credentials::write_persistent(&slot, &secret)?;
        }
        let mut inner = self.lock()?;
        if temporary {
            inner.credentials.remember_temporary(&slot, secret);
            let mut config = inner.config.clone();
            let changed = config
                .connections
                .iter_mut()
                .find(|value| value.id == id)
                .ok_or_else(stale)?;
            changed.revision += 1;
            if is_proxy {
                changed.proxy_credential_status = "temporary".into();
            } else {
                changed.credential_status = "temporary".into();
            }
            inner.store.write_meta("config", &config)?;
            inner.config = config;
        }
        drop(inner);
        self.notify();
        Ok(())
    }
    fn delete_secret(&self, id: &str, is_proxy: bool) -> Result<(), AiError> {
        let _io = self.keyring_guard()?;
        let mut inner = self.lock()?;
        let old = profile(&inner, id)?.clone();
        invalidate(&mut inner, "cancelled");
        let slot = if is_proxy {
            proxy_slot(id)
        } else {
            id.to_owned()
        };
        let previous = if is_proxy {
            old.proxy_credential_status.clone()
        } else {
            old.credential_status.clone()
        };
        drop(inner);
        self.notify();
        if previous == "saved" {
            Credentials::delete_persistent(&slot)?;
        }
        let mut inner = self.lock()?;
        inner.credentials.forget_temporary(&slot);
        let mut config = inner.config.clone();
        let changed = config
            .connections
            .iter_mut()
            .find(|value| value.id == id)
            .ok_or_else(stale)?;
        changed.revision += 1;
        if is_proxy {
            changed.proxy_credential_status = if changed.proxy_url.is_none()
                || changed.network_policy == NetworkPolicy::Loopback
            {
                "not_required"
            } else {
                "missing"
            }
            .into();
        } else {
            changed.credential_status = if changed.auth_kind == AuthKind::None {
                "not_required"
            } else {
                "missing"
            }
            .into();
        }
        inner.store.write_meta("config", &config)?;
        inner.config = config;
        drop(inner);
        self.notify();
        Ok(())
    }
    pub async fn list_models(self: &Arc<Self>, id: &str) -> Result<Vec<ModelInfo>, AiError> {
        let (selected, plan, cancel, epoch) = {
            let mut inner = self.lock()?;
            if inner.discovery_cancel.is_some() {
                return Err(busy());
            }
            let selected = profile(&inner, id)?.clone();
            validate_destination(&inner, &selected)?;
            let plan = credential_plan(&inner, &selected)?;
            let cancel = Arc::new(AtomicBool::new(false));
            inner.discovery_cancel = Some(cancel.clone());
            (selected, plan, cancel, inner.request_epoch)
        };
        let result = async {
            let (key, proxy_credentials) = self
                .resolve_credentials(plan, cancel.clone(), selected.timeout_seconds)
                .await?;
            {
                let inner = self.lock()?;
                if inner.request_epoch != epoch
                    || !profile(&inner, id)
                        .is_ok_and(|profile| profile.revision == selected.revision)
                    || cancel.load(Ordering::Acquire)
                {
                    return Err(stale());
                }
            }
            providers::list_models_cancellable(
                selected.clone(),
                key,
                proxy_credentials,
                cancel.clone(),
            )
            .await
        }
        .await;
        let mut inner = self.lock()?;
        if inner
            .discovery_cancel
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
        {
            inner.discovery_cancel = None;
        }
        if cancel.load(Ordering::Acquire) {
            return Err(AiError::new("cancelled", "Model discovery was cancelled."));
        }
        if !profile(&inner, id).is_ok_and(|current| current.revision == selected.revision) {
            return Err(stale());
        }
        if let Ok(models) = &result {
            let previous_remote_models = inner.remote_models.clone();
            inner.remote_models.retain(|(connection_id, revision, _)| {
                connection_id != id || *revision == selected.revision
            });
            for model in models
                .iter()
                .filter(|model| model.processing_location == "remote")
            {
                inner
                    .remote_models
                    .insert((id.into(), selected.revision, model.id.clone()));
            }
            inner
                .store
                .write_meta("remote_models", &inner.remote_models)?;
            if inner.remote_models != previous_remote_models {
                invalidate(&mut inner, "cancelled");
            }
        }
        record_capability(
            &mut inner,
            capability_record(
                &selected,
                "",
                "discovery",
                if result.is_ok() { "verified" } else { "failed" },
            ),
        )?;
        result
    }
    pub async fn test_model(
        self: &Arc<Self>,
        selection: ModelSelection,
    ) -> Result<ProviderCompletion, AiError> {
        let (mut request, plan, cancel, epoch) = {
            let mut inner = self.lock()?;
            if inner.active.is_some() || inner.test_cancel.is_some() {
                return Err(busy());
            }
            if inner.clearing_all {
                return Err(busy());
            }
            validate_selection(&inner, &selection)?;
            let selected = profile(&inner, &selection.connection_id)?.clone();
            validate_destination(&inner, &selected)?;
            validate_model_destination(&inner, &selected, &selection.model_id)?;
            let plan = credential_plan(&inner, &selected)?;
            let cancel = Arc::new(AtomicBool::new(false));
            inner.test_cancel = Some(cancel.clone());
            let request = ProviderRequest {
                tools: Vec::new(),
                tool_turns: Vec::new(),
                max_output_tokens: selected.max_output_tokens,
                stream: selected.stream,
                profile: selected,
                api_key: None,
                proxy_credentials: None,
                model_id: selection.model_id.clone(),
                system: "This is a connection test. Reply only with OK.".into(),
                messages: vec![ProviderMessage {
                    role: "user".into(),
                    content: "Reply with OK.".into(),
                }],
            };
            (request, plan, cancel, inner.request_epoch)
        };
        let tested_profile = request.profile.clone();
        let result = async {
            let (key, proxy) = self
                .resolve_credentials(plan, cancel.clone(), request.profile.timeout_seconds)
                .await?;
            {
                let inner = self.lock()?;
                if inner.request_epoch != epoch
                    || !profile(&inner, &request.profile.id)
                        .is_ok_and(|profile| profile.revision == request.profile.revision)
                    || cancel.load(Ordering::Acquire)
                {
                    return Err(stale());
                }
            }
            request.api_key = key;
            request.proxy_credentials = proxy;
            providers::generate(request, cancel.clone(), Arc::new(|_| {})).await
        }
        .await;
        let mut inner = self.lock()?;
        if inner
            .test_cancel
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
        {
            inner.test_cancel = None;
        }
        if inner.request_epoch != epoch || cancel.load(Ordering::Acquire) {
            return Err(AiError::new("cancelled", "The model test was cancelled."));
        }
        record_capability(
            &mut inner,
            capability_record(
                &tested_profile,
                &selection.model_id,
                "text",
                if result.is_ok() { "verified" } else { "failed" },
            ),
        )?;
        drop(inner);
        self.notify();
        result
    }
    pub fn create_session(&self, input: CreateSessionInput) -> Result<AiSession, AiError> {
        let mut inner = self.lock()?;
        if inner.clearing_all {
            return Err(busy());
        }
        let scenario = input.scenario.clone().unwrap_or_else(default_scenario);
        validate_context_scope(
            &scenario,
            input.incident_id.as_deref(),
            input.from_ms,
            input.to_ms,
        )?;
        let selected_model = input
            .selected_model
            .or_else(|| inner.config.settings.default_model.clone());
        if let Some(selection) = &selected_model {
            validate_selection(&inner, selection)?;
        }
        let temporary = input.temporary.unwrap_or(false);
        if temporary && inner.temporary.len() >= 16 {
            return Err(invalid(
                "Close or delete a temporary conversation before creating another.",
            ));
        }
        let timestamp = now();
        let session = AiSession {
            summary: AiSessionSummary {
                id: new_id()?,
                title: title(input.title.as_deref().unwrap_or("New conversation"))?,
                revision: 1,
                created_at: timestamp,
                updated_at: timestamp,
                temporary,
                selected_model,
                scenario,
                incident_id: input.incident_id,
                from_ms: input.from_ms,
                to_ms: input.to_ms,
                draft_text: String::new(),
                draft_revision: 1,
                storage_status: if temporary { "temporary" } else { "saved" }.into(),
                source_categories: Vec::new(),
            },
            messages: Vec::new(),
        };
        if temporary {
            inner
                .temporary
                .insert(session.summary.id.clone(), session.clone());
        } else {
            inner
                .store
                .insert(&session, inner.config.settings.storage_budget_bytes)?;
        }
        drop(inner);
        self.notify();
        Ok(session)
    }
    pub fn set_session_context(&self, input: SetSessionContextInput) -> Result<AiSession, AiError> {
        validate_context_scope(
            &input.scenario,
            input.incident_id.as_deref(),
            input.from_ms,
            input.to_ms,
        )?;
        let mut inner = self.lock()?;
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.run.session_id == input.session_id)
        {
            return Err(busy());
        }
        let mut value = session(&inner, &input.session_id)?;
        if value.summary.revision != input.expected_revision {
            return Err(stale());
        }
        value.summary.scenario = input.scenario;
        value.summary.incident_id = input.incident_id;
        value.summary.from_ms = input.from_ms;
        value.summary.to_ms = input.to_ms;
        value.summary.revision += 1;
        value.summary.storage_status = if value.summary.temporary {
            "temporary"
        } else {
            "saved"
        }
        .into();
        save_session(&mut inner, &value)?;
        inner
            .prepared
            .retain(|_, frozen| frozen.public.session_id != value.summary.id);
        drop(inner);
        self.notify();
        Ok(value)
    }
    pub fn list_sessions(
        &self,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<SessionPage, AiError> {
        let inner = self.lock()?;
        let offset = offset.unwrap_or(0).min(100_000);
        let limit = limit.unwrap_or(30).clamp(1, 100);
        // Read only enough persistent records to merge the bounded temporary
        // set and retain deterministic pagination across both kinds.
        let mut summaries = inner.store.list(0, offset + limit + 17)?;
        summaries.extend(
            inner
                .temporary
                .values()
                .map(|session| session.summary.clone()),
        );
        for session in inner.unsaved.values() {
            if let Some(summary) = summaries
                .iter_mut()
                .find(|summary| summary.id == session.summary.id)
            {
                *summary = session.summary.clone();
            }
        }
        if let Some(active) = &inner.active
            && let Some(summary) = summaries
                .iter_mut()
                .find(|summary| summary.id == active.session.summary.id)
        {
            *summary = active.session.summary.clone();
        }
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let has_more = summaries.len() > (offset + limit) as usize;
        Ok(SessionPage {
            sessions: summaries
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect(),
            has_more,
        })
    }
    pub fn get_session(&self, id: &str) -> Result<AiSession, AiError> {
        let inner = self.lock()?;
        let mut value = session(&inner, id)?;
        capability_action_service::decorate_card_actions(&inner, &mut value);
        Ok(value)
    }
    pub fn rename_session(&self, id: &str, name: &str) -> Result<AiSession, AiError> {
        let mut inner = self.lock()?;
        let mut value = session(&inner, id)?;
        value.summary.title = title(name)?;
        value.summary.updated_at = now();
        value.summary.storage_status = if value.summary.temporary {
            "temporary"
        } else {
            "saved"
        }
        .into();
        save_session(&mut inner, &value)?;
        drop(inner);
        self.notify();
        Ok(value)
    }
    pub fn save_draft(&self, input: SaveDraftInput) -> Result<AiSession, AiError> {
        if input.text.len() > 16 * 1024 {
            return Err(invalid("Drafts are limited to 16 KiB."));
        }
        let mut inner = self.lock()?;
        let mut value = session(&inner, &input.session_id)?;
        if value.summary.draft_revision != input.expected_draft_revision {
            return Err(stale());
        }
        value.summary.draft_revision += 1;
        value.summary.draft_text = input.text;
        value.summary.storage_status = if value.summary.temporary {
            "temporary"
        } else {
            "saved"
        }
        .into();
        if !value.summary.temporary {
            inner.store.check_capacity(
                value.summary.draft_text.len(),
                inner.config.settings.storage_budget_bytes,
            )?;
        }
        save_session(&mut inner, &value)?;
        drop(inner);
        self.notify();
        Ok(value)
    }
    pub fn select_session_model(
        &self,
        input: SelectSessionModelInput,
    ) -> Result<AiSession, AiError> {
        let mut inner = self.lock()?;
        validate_selection(&inner, &input.selection)?;
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.run.session_id == input.session_id)
        {
            return Err(busy());
        }
        let mut value = session(&inner, &input.session_id)?;
        if value.summary.revision != input.expected_revision {
            return Err(stale());
        }
        let same_model = value
            .summary
            .selected_model
            .as_ref()
            .is_some_and(|selected| {
                selected.connection_id == input.selection.connection_id
                    && selected.model_id == input.selection.model_id
            });
        if same_model {
            return Ok(value);
        }
        if !value.messages.is_empty() {
            // A different destination must never inherit another model's chat
            // merely because a view changed its selection. Keep the old chat
            // and its draft intact; return a fresh native-owned conversation.
            if value.summary.temporary && inner.temporary.len() >= 16 {
                return Err(invalid(
                    "Delete a temporary conversation before creating another.",
                ));
            }
            value.summary.id = new_id()?;
            value.summary.title = "New conversation".into();
            value.summary.revision = 1;
            value.summary.created_at = now();
            value.summary.updated_at = value.summary.created_at;
            value.summary.selected_model = Some(input.selection);
            value.summary.draft_text.clear();
            value.summary.draft_revision = 1;
            value.summary.source_categories.clear();
            value.summary.storage_status = if value.summary.temporary {
                "temporary"
            } else {
                "saved"
            }
            .into();
            value.messages.clear();
            if value.summary.temporary {
                inner
                    .temporary
                    .insert(value.summary.id.clone(), value.clone());
            } else {
                let budget = inner.config.settings.storage_budget_bytes;
                inner.store.insert(&value, budget)?;
            }
            inner
                .prepared
                .retain(|_, prepared| prepared.public.session_id != input.session_id);
            drop(inner);
            self.notify();
            return Ok(value);
        }
        value.summary.selected_model = Some(input.selection);
        value.summary.revision += 1;
        value.summary.storage_status = if value.summary.temporary {
            "temporary"
        } else {
            "saved"
        }
        .into();
        save_session(&mut inner, &value)?;
        inner
            .prepared
            .retain(|_, prepared| prepared.public.session_id != input.session_id);
        drop(inner);
        self.notify();
        Ok(value)
    }
    pub fn delete_session(&self, id: &str) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.run.session_id == id)
        {
            stop_active(&mut inner, "cancelled");
        }
        inner
            .prepared
            .retain(|_, prepared| prepared.public.session_id != id);
        // Persistent tombstone commits before volatile references are removed.
        inner.store.delete(id)?;
        inner
            .tool_targets
            .retain(|_, targets| targets.session_id != id);
        inner.temporary.remove(id);
        inner.unsaved.remove(id);
        inner
            .volatile_submissions
            .retain(|_, run| run.session_id != id);
        if inner
            .last_run
            .as_ref()
            .is_some_and(|run| run.session_id == id)
        {
            inner.last_run = None;
        }
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn clear_conversations(&self) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        invalidate(&mut inner, "cancelled");
        inner.store.clear_conversations()?;
        inner.temporary.clear();
        inner.unsaved.clear();
        inner.volatile_submissions.clear();
        inner.last_run = None;
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn prepare_with_context(
        &self,
        input: PrepareInput,
        facts: AiContextFacts,
    ) -> Result<PreparedAnalysis, AiError> {
        let mut inner = self.lock()?;
        if !inner.config.settings.enabled {
            return Err(AiError::new(
                "ai_disabled",
                "Enable AI in settings to send messages.",
            ));
        }
        let current = session(&inner, &input.session_id)?;
        if current.summary.revision != input.expected_revision {
            return Err(stale());
        }
        if current.summary.scenario != input.scenario
            || current.summary.incident_id != input.incident_id
            || current.summary.from_ms != input.from_ms
            || current.summary.to_ms != input.to_ms
        {
            return Err(stale());
        }
        let selection = current.summary.selected_model.clone().ok_or_else(|| {
            AiError::new("model_required", "Choose a default model in AI settings.")
        })?;
        validate_selection(&inner, &selection)?;
        let profile = profile(&inner, &selection.connection_id)?.clone();
        if input
            .expected_connection_revision
            .is_some_and(|revision| revision != profile.revision)
        {
            return Err(stale());
        }
        validate_destination(&inner, &profile)?;
        validate_model_destination(&inner, &profile, &selection.model_id)?;
        let evidence = if input.include_context {
            facts
                .facts
                .iter()
                .take(64)
                .enumerate()
                .map(|(index, fact)| EvidenceReference {
                    id: format!("E{}", index + 1),
                    label: fact.label.clone(),
                    value: fact.value.clone(),
                    unit: fact.unit.clone(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let language = input.language.as_deref().unwrap_or("en");
        if !matches!(
            language,
            "en" | "zh-CN" | "zh-Hant" | "de" | "es" | "fr" | "ja" | "ko" | "pt-BR" | "ru"
        ) {
            return Err(invalid("Choose a supported application language."));
        }
        let tool_scope = tools::ToolScope {
            include_context: input.include_context,
            scenario: input.scenario.clone(),
            incident_id: input.incident_id.clone(),
            from_ms: input.from_ms,
            to_ms: input.to_ms,
        };
        let system = format!(
            "{SYSTEM_PROMPT} Application language: {language}. Device tools allowed for this message: {}.",
            input.include_context
        );
        let (preview, mut categories, mut coverage) = build_preview(&input, facts)?;
        let mut remaining = MAX_INPUT_BYTES.saturating_sub(
            preview.len() + system.len() + if input.include_context { 8192 } else { 0 },
        );
        let mut history = Vec::new();
        for message in current
            .messages
            .iter()
            .rev()
            .filter(|message| message.reusable_in_context && message.status == "complete")
        {
            let content = message.context_text.as_ref().unwrap_or(&message.content);
            if content.len() > remaining {
                coverage.push("Older messages were omitted to fit this model request.".into());
                break;
            }
            remaining -= content.len();
            history.push(ProviderMessage {
                role: message.role.clone(),
                content: content.clone(),
            });
            for source in &message.source_categories {
                if !categories.contains(source) {
                    categories.push(source.clone());
                }
            }
        }
        history.reverse();
        while history
            .first()
            .is_some_and(|message| message.role != "user")
        {
            history.remove(0);
        }
        categories.sort();
        let proxy_url = if profile.network_policy == NetworkPolicy::Loopback {
            None
        } else {
            profile.proxy_url.clone()
        };
        let processing_location = if known_cloud_model(&inner, &profile, &selection.model_id) {
            "remote"
        } else {
            "unknown"
        };
        let public = PreparedAnalysis {
            protocol: profile.protocol.clone(),
            processing_location: processing_location.into(),
            connection_location: profile.network_policy.clone(),
            id: new_id()?,
            session_id: input.session_id,
            session_revision: current.summary.revision,
            expires_at: now() + 5 * 60 * 1000,
            selection,
            connection_name: profile.name.clone(),
            endpoint: providers::generation_endpoint(&profile)?,
            proxy_url,
            preview,
            user_text: input.text,
            history,
            scenario: input.scenario,
            source_categories: categories,
            coverage,
            request_epoch: inner.request_epoch,
        };
        let timestamp = now();
        inner
            .prepared
            .retain(|_, value| value.public.expires_at > timestamp);
        if inner.prepared.len() >= 32 {
            inner.prepared.clear();
        }
        inner.prepared.insert(
            public.id.clone(),
            Frozen {
                tool_scope,
                public: public.clone(),
                profile,
                evidence,
                system,
            },
        );
        Ok(public)
    }
    pub fn start(self: &Arc<Self>, input: StartInput) -> Result<AnalysisRun, AiError> {
        if input.submission_id.is_empty() || input.submission_id.len() > 128 {
            return Err(invalid("Invalid submission identifier."));
        }
        let executor = self.tool_executor.lock().map_err(AiError::storage)?.clone();
        let (run, request, plan, cancel, scope) = {
            let mut inner = self.lock()?;
            if inner.clearing_all {
                return Err(busy());
            }
            if let Some(previous) = inner
                .volatile_submissions
                .get(&input.submission_id)
                .cloned()
                .or(inner.store.submission(&input.submission_id)?)
            {
                if previous.preparation_id != input.preparation_id {
                    return Err(stale());
                }
                return Ok(previous);
            }
            if inner.active.is_some() || inner.test_cancel.is_some() {
                return Err(busy());
            }
            if !inner.unsaved.is_empty() {
                return Err(AiError::new(
                    "storage_error",
                    "Save or delete the unsaved reply before starting another request.",
                ));
            }
            if !inner.config.settings.enabled {
                return Err(AiError::new(
                    "ai_disabled",
                    "Enable AI in settings to send messages.",
                ));
            }
            let frozen = inner
                .prepared
                .get(&input.preparation_id)
                .cloned()
                .ok_or_else(stale)?;
            let prepared = &frozen.public;
            if prepared.expires_at <= now()
                || prepared.session_revision != input.expected_session_revision
                || prepared.request_epoch != inner.request_epoch
            {
                return Err(stale());
            }
            let current_profile = profile(&inner, &prepared.selection.connection_id)?;
            validate_destination(&inner, current_profile)?;
            validate_model_destination(&inner, current_profile, &prepared.selection.model_id)?;
            if current_profile.revision != frozen.profile.revision
                || known_cloud_model(&inner, current_profile, &prepared.selection.model_id)
                    != (prepared.processing_location == "remote")
            {
                return Err(stale());
            }
            let mut current = session(&inner, &prepared.session_id)?;
            if current.summary.revision != prepared.session_revision {
                return Err(stale());
            }
            if current.summary.storage_status == "error" {
                return Err(AiError::new(
                    "storage_error",
                    "Save or copy the unsaved reply before starting another request.",
                ));
            }
            if current.messages.len() >= 1000 {
                return Err(invalid(
                    "This conversation has reached its message limit. Start a new conversation.",
                ));
            }
            let session_bytes = serde_json::to_vec(&current)
                .map_err(AiError::storage)?
                .len();
            if session_bytes.saturating_add(
                MAX_OUTPUT_BYTES + MAX_TASK_METADATA_BYTES + prepared.preview.len() * 2,
            ) > 16 * 1024 * 1024
            {
                return Err(AiError::new(
                    "conversation_limit",
                    "This conversation has reached its size limit. Start a new conversation; the existing history remains available.",
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
                if used.saturating_add(
                    MAX_OUTPUT_BYTES + MAX_TASK_METADATA_BYTES + prepared.preview.len() * 2,
                ) > 16 * 1024 * 1024
                {
                    return Err(AiError::new(
                        "temporary_storage_full",
                        "Temporary conversations have reached their memory limit. Delete one before continuing.",
                    ));
                }
            }
            let plan = credential_plan(&inner, &frozen.profile)?;
            let request_id = new_id()?;
            let timestamp = now();
            let run = AnalysisRun {
                request_id: request_id.clone(),
                session_id: current.summary.id.clone(),
                submission_id: input.submission_id.clone(),
                preparation_id: input.preparation_id.clone(),
                state: "pending".into(),
                started_at: timestamp,
                finished_at: None,
                error: None,
            };
            let model_label = Some(format!(
                "{} · {}",
                frozen.profile.name, prepared.selection.model_id
            ));
            current.messages.push(AiMessage {
                tool_steps: Vec::new(),
                validated_result: None,
                id: new_id()?,
                role: "user".into(),
                content: prepared.user_text.clone(),
                created_at: timestamp,
                status: "complete".into(),
                request_id: Some(request_id.clone()),
                model_label: model_label.clone(),
                source_categories: prepared.source_categories.clone(),
                reusable_in_context: true,
                usage: None,
                context_text: Some(prepared.preview.clone()),
            });
            current.messages.push(AiMessage {
                tool_steps: Vec::new(),
                validated_result: None,
                id: new_id()?,
                role: "assistant".into(),
                content: String::new(),
                created_at: timestamp,
                status: "pending".into(),
                request_id: Some(request_id),
                model_label,
                source_categories: prepared.source_categories.clone(),
                reusable_in_context: false,
                usage: None,
                context_text: None,
            });
            current.summary.revision += 1;
            current.summary.updated_at = timestamp;
            current.summary.draft_text.clear();
            current.summary.draft_revision += 1;
            for category in &prepared.source_categories {
                if !current.summary.source_categories.contains(category) {
                    current.summary.source_categories.push(category.clone());
                }
            }
            let budget = inner.config.settings.storage_budget_bytes;
            inner.store.begin_run(&current, &run, budget)?;
            if current.summary.temporary {
                inner
                    .temporary
                    .insert(current.summary.id.clone(), current.clone());
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let mut messages = prepared.history.clone();
            messages.push(ProviderMessage {
                role: "user".into(),
                content: prepared.preview.clone(),
            });
            let result_capability = Some(capability_record(
                &frozen.profile,
                &prepared.selection.model_id,
                "text",
                "verified",
            ));
            let request = ProviderRequest {
                tools: if frozen.tool_scope.include_context && executor.is_some() {
                    tools::definitions()
                } else {
                    Vec::new()
                },
                tool_turns: Vec::new(),
                max_output_tokens: frozen.profile.max_output_tokens,
                stream: frozen.profile.stream,
                profile: frozen.profile,
                api_key: None,
                proxy_credentials: None,
                model_id: prepared.selection.model_id.clone(),
                system: frozen.system,
                messages,
            };
            inner.active = Some(Active {
                application_action: false,
                pending_approval: None,
                run: run.clone(),
                session: current,
                cancelled: cancel.clone(),
                persisted_bytes: 0,
                persisted_at: Instant::now(),
                notified_at: Instant::now(),
                request_epoch: inner.request_epoch,
                result_evidence: frozen.evidence,
                result_capability,
            });
            inner
                .prepared
                .retain(|_, value| value.public.session_id != run.session_id);
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.session.summary.temporary)
            {
                inner
                    .volatile_submissions
                    .insert(run.submission_id.clone(), run.clone());
            }
            (run, request, plan, cancel, frozen.tool_scope)
        };
        self.notify();
        let service = self.clone();
        let request_id = run.request_id.clone();
        tauri::async_runtime::spawn(async move {
            let callback_service = service.clone();
            let callback_id = request_id.clone();
            let callback: Arc<dyn Fn(&str) + Send + Sync> =
                Arc::new(move |delta| callback_service.delta(&callback_id, delta));
            let outcome = async {
                let mut request = request;
                let (key, proxy) = service
                    .resolve_credentials(plan, cancel.clone(), request.profile.timeout_seconds)
                    .await?;
                service.ready_for_send(&request_id, &request.profile)?;
                request.api_key = key;
                request.proxy_credentials = proxy;
                service
                    .run_task(request, cancel, callback, scope, executor, &request_id)
                    .await
            }
            .await;
            service.finish(&request_id, outcome);
        });
        Ok(run)
    }
    pub(crate) fn check_tool_active(&self, request_id: &str) -> Result<(), AiError> {
        let inner = self.lock()?;
        let active = inner.active.as_ref().ok_or_else(tools::cancelled)?;
        if active.run.request_id != request_id
            || active.request_epoch != inner.request_epoch
            || active.cancelled.load(Ordering::Acquire)
            || !inner.config.settings.enabled
        {
            return Err(tools::cancelled());
        }
        Ok(())
    }

    fn update_task(
        &self,
        request_id: &str,
        update: impl FnOnce(&mut Active) -> Result<(), AiError>,
    ) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        let active = inner.active.as_ref().ok_or_else(tools::cancelled)?;
        if active.run.request_id != request_id
            || active.request_epoch != inner.request_epoch
            || active.cancelled.load(Ordering::Acquire)
        {
            return Err(tools::cancelled());
        }
        let mut active = inner.active.take().expect("checked active run");
        let mut result = update(&mut active);
        if result.is_ok()
            && active.session.messages.last().is_some_and(|message| {
                serde_json::to_vec(&message.tool_steps)
                    .map_or(true, |data| data.len() > MAX_TASK_METADATA_BYTES)
            })
        {
            result = Err(AiError::new(
                "task_limit",
                "The task reached its execution-record limit. No further action was dispatched.",
            ));
        }
        if result.is_ok() {
            active.session.summary.revision += 1;
            active.session.summary.updated_at = now();
            if !active.session.summary.temporary {
                result = inner.store.update(&active.session);
            }
            if let Err(error) = &result {
                active.cancelled.store(true, Ordering::Release);
                active.session.summary.storage_status = "error".into();
                active.run.error = Some(error.clone());
            }
        }
        inner.active = Some(active);
        drop(inner);
        self.notify();
        result
    }

    pub(crate) async fn confirm_tool(
        &self,
        request_id: &str,
        step_id: &str,
        confirmation: ToolConfirmation,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AiError> {
        let wait_seconds = confirmation
            .expires_at
            .saturating_sub(now())
            .div_ceil(1000)
            .clamp(1, 180);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.update_task(request_id, |active| {
            if active.pending_approval.is_some() {
                return Err(busy());
            }
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
            step.state = "awaiting_confirmation".into();
            step.confirmation = Some(confirmation);
            active.pending_approval = Some((step_id.into(), sender));
            Ok(())
        })?;
        let decision = transport::cancellable(cancelled, wait_seconds, async {
            receiver.await.map_err(|_| tools::cancelled())
        })
        .await;
        self.update_task(request_id, |active| {
            active.pending_approval = None;
            if let Some(step) = active.session.messages.last_mut().and_then(|message| {
                message
                    .tool_steps
                    .iter_mut()
                    .find(|step| step.id == step_id)
            }) {
                step.state = "running".into();
            }
            Ok(())
        })?;
        match decision {
            Ok(true) => Ok(()),
            Ok(false) => Err(AiError::new(
                "action_rejected",
                "The user declined this action. Do not request it again or try another way to perform it.",
            )),
            Err(error) if error.code == "timeout" => Err(AiError::new(
                "confirmation_expired",
                "The action confirmation expired. No action was performed.",
            )),
            Err(error) => Err(error),
        }
    }

    pub fn resolve_tool_confirmation(
        &self,
        request_id: &str,
        step_id: &str,
        approved: bool,
    ) -> Result<(), AiError> {
        let mut decision_sender = None;
        self.update_task(request_id, |active| {
            let (pending_id, _) = active.pending_approval.as_ref().ok_or_else(stale)?;
            if pending_id != step_id {
                return Err(stale());
            }
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
            if step.state != "awaiting_confirmation"
                || step
                    .confirmation
                    .as_ref()
                    .is_none_or(|confirmation| confirmation.expires_at <= now())
            {
                return Err(stale());
            }
            let (_, sender) = active.pending_approval.take().ok_or_else(stale)?;
            step.state = "running".into();
            decision_sender = Some(sender);
            Ok(())
        })?;
        decision_sender
            .ok_or_else(stale)?
            .send(approved)
            .map_err(|_| tools::cancelled())
    }

    async fn run_task(
        self: &Arc<Self>,
        mut request: ProviderRequest,
        cancelled: Arc<AtomicBool>,
        callback: providers::DeltaCallback,
        scope: tools::ToolScope,
        executor: Option<tools::ToolExecutor>,
        request_id: &str,
    ) -> Result<ProviderCompletion, AiError> {
        let targets = Arc::new(Mutex::new(HashMap::new()));
        self.remember_tool_targets(request_id, targets.clone())?;
        let mut completed: HashMap<String, Result<String, AiError>> = HashMap::new();
        let mut total_calls = 0;
        let mut actions_rejected = false;
        let mut all_text = String::new();
        let mut total_usage = TokenUsage {
            input_tokens: None,
            output_tokens: None,
        };
        for _ in 0..tools::MAX_TOOL_ROUNDS {
            self.check_tool_active(request_id)?;
            self.ready_for_send(request_id, &request.profile)?;
            if !request.tools.is_empty() {
                let current_targets = targets.lock().map_err(AiError::storage)?;
                request.tools = tools::definitions_for_targets(&current_targets);
            }
            let mut completion =
                providers::generate(request.clone(), cancelled.clone(), callback.clone()).await?;
            self.check_tool_active(request_id)?;
            if let Some(usage) = completion.usage.take() {
                if let Some(input) = usage.input_tokens {
                    total_usage.input_tokens =
                        Some(total_usage.input_tokens.unwrap_or(0).saturating_add(input));
                }
                if let Some(output) = usage.output_tokens {
                    total_usage.output_tokens = Some(
                        total_usage
                            .output_tokens
                            .unwrap_or(0)
                            .saturating_add(output),
                    );
                }
            }
            all_text.push_str(&completion.text);
            if completion.tool_calls.is_empty() {
                completion.text = all_text;
                completion.usage = Some(total_usage);
                return Ok(completion);
            }
            if !scope.include_context || request.tools.is_empty() {
                return Err(super::provider_tools::tool_unavailable());
            }
            let executor = executor
                .as_ref()
                .ok_or_else(super::provider_tools::tool_unavailable)?;
            if total_calls + completion.tool_calls.len() > tools::MAX_TOOL_CALLS {
                return Err(AiError::new(
                    "task_limit",
                    "The task reached its tool-call limit. Completed steps remain available; narrow the next request.",
                ));
            }
            let mut results = Vec::new();
            for call in completion.tool_calls {
                self.check_tool_active(request_id)?;
                total_calls += 1;
                let step_id = new_id()?;
                self.begin_tool_step(request_id, &step_id, &call.name)?;
                let key = format!("{}:{}", call.name, call.arguments);
                let outcome = if let Some(outcome) = completed.get(&key) {
                    outcome.clone()
                } else if actions_rejected
                    && matches!(
                        call.name.as_str(),
                        "request_process_action" | "request_cleanup"
                    )
                {
                    Err(AiError::new(
                        "action_rejected",
                        "The user declined modifications in this task. Do not request another modifying action.",
                    ))
                } else if let Err(error) = tools::parse(&call) {
                    Err(error)
                } else {
                    self.invoke_tool(
                        executor,
                        call.clone(),
                        tools::ToolContext {
                            service: self.clone(),
                            request_id: request_id.into(),
                            step_id: step_id.clone(),
                            scope: scope.clone(),
                            targets: targets.clone(),
                            cancelled: cancelled.clone(),
                        },
                    )
                    .await
                };
                if outcome
                    .as_ref()
                    .is_err_and(|error| error.code == "action_rejected")
                {
                    actions_rejected = true;
                }
                self.check_tool_active(request_id)?;
                self.complete_tool_step(request_id, &step_id, &outcome)?;
                completed.insert(key, outcome.clone());
                let (output, is_error) = match outcome {
                    Ok(output) => (output, false),
                    Err(error) => (
                        serde_json::to_string(&error).map_err(AiError::storage)?,
                        true,
                    ),
                };
                results.push(ToolResult {
                    call,
                    output,
                    is_error,
                });
            }
            request.tool_turns.push(ProviderToolTurn {
                assistant: completion.continuation,
                results,
            });
            if !all_text.is_empty() {
                all_text.push_str("\n\n");
                callback("\n\n");
            }
        }
        Err(AiError::new(
            "task_limit",
            "The task reached its model-turn limit. Completed steps remain available; narrow the next request.",
        ))
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.run.request_id == request_id)
        {
            stop_active(&mut inner, "cancelled");
        }
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn invalidate_source(&self, category: &str, delete_related: bool) -> Result<(), AiError> {
        let mut inner = self.lock()?;
        invalidate(&mut inner, "cancelled");
        inner.store.invalidate_source(category, delete_related)?;
        invalidate_collection(&mut inner.temporary, category, delete_related);
        invalidate_collection(&mut inner.unsaved, category, delete_related);
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn clear_all(&self) -> Result<(), AiError> {
        let _io = self.keyring_guard()?;
        let mut inner = self.lock()?;
        invalidate(&mut inner, "cancelled");
        // Keep configuration if credential deletion fails so the user can retry
        // deleting every known key rather than leaving an orphaned credential.
        let profiles = inner.config.connections.clone();
        inner.clearing_all = true;
        drop(inner);
        self.notify();
        let removed = (|| {
            for profile in profiles {
                if profile.credential_status == "saved" {
                    Credentials::delete_persistent(&profile.id)?;
                }
                if profile.proxy_credential_status == "saved" {
                    Credentials::delete_persistent(&proxy_slot(&profile.id))?;
                }
            }
            Ok::<(), AiError>(())
        })();
        inner = self.lock()?;
        inner.clearing_all = false;
        removed?;
        inner.store.clear_conversations()?;
        inner.store.clear_meta()?;
        inner.config = Config::default();
        inner.credentials = Credentials::default();
        inner.remote_models.clear();
        inner.capabilities.clear();
        inner.temporary.clear();
        inner.unsaved.clear();
        inner.volatile_submissions.clear();
        inner.last_run = None;
        drop(inner);
        self.notify();
        Ok(())
    }
    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.lock() {
            inner.tool_targets.clear();
            inner.request_epoch += 1;
            inner.prepared.clear();
            if let Some(cancel) = inner.test_cancel.take() {
                cancel.store(true, Ordering::Release);
            }
            if let Some(cancel) = inner.discovery_cancel.take() {
                cancel.store(true, Ordering::Release);
            }
            stop_active(&mut inner, "interrupted");
        }
        self.notify();
    }
    fn delta(&self, request_id: &str, text: &str) {
        let Ok(mut inner) = self.lock() else {
            return;
        };
        let Some(mut active) = inner.active.take() else {
            return;
        };
        if active.run.request_id != request_id || active.cancelled.load(Ordering::Acquire) {
            inner.active = Some(active);
            return;
        }
        let Some(message) = active.session.messages.last_mut() else {
            return;
        };
        if message.content.len().saturating_add(text.len()) > MAX_OUTPUT_BYTES {
            active.cancelled.store(true, Ordering::Release);
            active.run.error = Some(AiError::new(
                "response_too_large",
                "The response exceeded its size limit.",
            ));
        } else {
            message.content.push_str(text);
            message.status = "streaming".into();
            active.run.state = "streaming".into();
            active.session.summary.revision += 1;
        }
        let content_length = message.content.len();
        let needs_save = content_length.saturating_sub(active.persisted_bytes) >= 4096
            || active.persisted_at.elapsed() >= Duration::from_millis(500);
        if needs_save && !active.session.summary.temporary {
            if let Err(error) = inner.store.update(&active.session) {
                active.cancelled.store(true, Ordering::Release);
                active.session.summary.storage_status = "error".into();
                active.run.error = Some(error);
            } else {
                active.persisted_bytes = content_length;
                active.persisted_at = Instant::now();
            }
        }
        let should_notify = active.cancelled.load(Ordering::Acquire)
            || active.notified_at.elapsed() >= Duration::from_millis(40);
        if should_notify {
            active.notified_at = Instant::now();
        }
        inner.active = Some(active);
        drop(inner);
        if should_notify {
            self.notify();
        }
    }
    fn finish(&self, request_id: &str, outcome: Result<ProviderCompletion, AiError>) {
        let Ok(mut inner) = self.lock() else {
            return;
        };
        let Some(mut active) = inner.active.take() else {
            return;
        };
        if active.run.request_id != request_id {
            inner.active = Some(active);
            return;
        }
        let validated = outcome.as_ref().ok().and_then(|completion| {
            // Keep explicitly returned legacy result data readable, without
            // ever forcing ordinary conversation into a schema.
            if !completion.text.trim_start().starts_with('{') {
                return None;
            }
            structured::validate(&completion.text, &active.result_evidence).ok()
        });
        if let Some(mut capability) = active.result_capability.take() {
            capability.status = if outcome.is_err() {
                "expired"
            } else {
                "verified"
            }
            .into();
            capability.checked_at = now();
            // The result remains readable even if saving a capability observation fails.
            let _ = record_capability(&mut inner, capability);
        }
        if let Some(message) = active.session.messages.last_mut() {
            let outcome = if active.run.error.is_some() {
                Err(active.run.error.clone().expect("present error"))
            } else {
                outcome
            };
            match outcome {
                Ok(completion)
                    if !active.cancelled.load(Ordering::Acquire)
                        && (active.application_action || !completion.text.trim().is_empty())
                        && completion.text.len() <= MAX_OUTPUT_BYTES =>
                {
                    message.content = completion.text;
                    message.validated_result = validated;
                    message.usage = completion.usage;
                    message.status = "complete".into();
                    message.reusable_in_context = !active.application_action;
                    active.run.state = "complete".into();
                }
                Ok(_) => {
                    message.status = "failed".into();
                    active.run.state = "failed".into();
                    active.run.error = Some(AiError::new(
                        "invalid_response",
                        "The model did not return a complete usable response.",
                    ));
                }
                Err(error) => {
                    message.status = if error.code == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    active.run.state = message.status.clone();
                    active.run.error = Some(error);
                }
            }
            for step in &mut message.tool_steps {
                if matches!(step.state.as_str(), "running" | "awaiting_confirmation") {
                    step.state = if message.status == "cancelled" {
                        "cancelled"
                    } else {
                        "interrupted"
                    }
                    .into();
                    step.finished_at = Some(now());
                }
            }
        }
        active.session.summary.revision += 1;
        active.session.summary.updated_at = now();
        active.run.finished_at = Some(now());
        persist_completed(&mut inner, &mut active);
        if active.session.summary.temporary {
            inner
                .volatile_submissions
                .insert(active.run.submission_id.clone(), active.run.clone());
        }
        inner.last_run = Some(active.run);
        drop(inner);
        self.notify();
    }
}

fn capability_record(
    profile: &ConnectionProfile,
    model: &str,
    kind: &str,
    status: &str,
) -> CapabilityRecord {
    CapabilityRecord {
        connection_id: profile.id.clone(),
        profile_revision: profile.revision,
        model_id: model.into(),
        checked_at: now(),
        kind: kind.into(),
        status: status.into(),
    }
}
fn record_capability(inner: &mut Inner, record: CapabilityRecord) -> Result<(), AiError> {
    inner.capabilities.retain(|old| {
        !(old.connection_id == record.connection_id
            && old.model_id == record.model_id
            && old.kind == record.kind)
    });
    if inner.capabilities.len() >= 256 {
        inner.capabilities.remove(0);
    }
    inner.capabilities.push(record);
    inner.store.write_meta("capabilities", &inner.capabilities)
}

fn invalid(message: &str) -> AiError {
    AiError::new("invalid_input", message)
}
fn stale() -> AiError {
    AiError::new(
        "stale_state",
        "The conversation, evidence or model changed. Refresh and review the current message before sending.",
    )
}
fn busy() -> AiError {
    AiError::new(
        "busy",
        "Another AI request is running. Wait for it or cancel it first.",
    )
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub(crate) fn new_id() -> Result<String, AiError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        AiError::new(
            "runtime_unavailable",
            "Could not create a secure request identifier.",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn title(value: &str) -> Result<String, AiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 {
        return Err(invalid("Enter a title up to 120 characters."));
    }
    Ok(value.into())
}
fn profile<'a>(inner: &'a Inner, id: &str) -> Result<&'a ConnectionProfile, AiError> {
    inner
        .config
        .connections
        .iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| {
            AiError::new(
                "connection_missing",
                "This connection was removed. Select another model to continue.",
            )
        })
}
fn validate_selection(inner: &Inner, selection: &ModelSelection) -> Result<(), AiError> {
    profile(inner, &selection.connection_id)?;
    if selection.model_id.trim().is_empty()
        || selection.model_id.len() > 256
        || selection.model_id.chars().any(char::is_control)
    {
        return Err(invalid("Enter a model ID up to 256 bytes."));
    }
    Ok(())
}
#[cfg(test)]
fn credential(inner: &Inner, profile: &ConnectionProfile) -> Result<Option<String>, AiError> {
    if profile.auth_kind == AuthKind::None {
        return Ok(None);
    }
    inner
        .credentials
        .get(&profile.id, &profile.credential_status)?
        .map(Some)
        .ok_or_else(|| AiError::new("credential_missing", "Add a credential in AI settings."))
}
fn proxy_slot(id: &str) -> String {
    format!("{id}:proxy")
}
fn credential_plan(inner: &Inner, profile: &ConnectionProfile) -> Result<CredentialPlan, AiError> {
    let auth = if profile.auth_kind == AuthKind::None {
        CredentialLookup::Memory(None)
    } else {
        let lookup = inner
            .credentials
            .lookup(&profile.id, &profile.credential_status);
        if matches!(lookup, CredentialLookup::Memory(None)) {
            return Err(AiError::new(
                "credential_missing",
                "Add a credential in AI settings.",
            ));
        }
        lookup
    };
    let proxy = if profile.proxy_url.is_none() || profile.network_policy == NetworkPolicy::Loopback
    {
        CredentialLookup::Memory(None)
    } else {
        inner
            .credentials
            .lookup(&proxy_slot(&profile.id), &profile.proxy_credential_status)
    };
    Ok(CredentialPlan { auth, proxy })
}
#[cfg(test)]
fn proxy_credential(
    inner: &Inner,
    profile: &ConnectionProfile,
) -> Result<Option<ProxyCredential>, AiError> {
    if profile.proxy_url.is_none() || profile.network_policy == NetworkPolicy::Loopback {
        return Ok(None);
    }
    inner
        .credentials
        .get(&proxy_slot(&profile.id), &profile.proxy_credential_status)?
        .map(|secret| {
            serde_json::from_str(&secret).map_err(|_| {
                AiError::new(
                    "credential_missing",
                    "Set this proxy credential again in AI settings.",
                )
            })
        })
        .transpose()
}
fn validate_destination(inner: &Inner, profile: &ConnectionProfile) -> Result<(), AiError> {
    if inner.clearing_all {
        return Err(busy());
    }
    if inner.config.settings.local_connections_only
        && (profile.network_policy != NetworkPolicy::Loopback || profile.proxy_url.is_some())
    {
        return Err(AiError::new(
            "local_connections_only",
            "Only local service addresses are allowed. Select a loopback connection or change this setting explicitly.",
        ));
    }
    Ok(())
}
fn validate_model_destination(
    inner: &Inner,
    profile: &ConnectionProfile,
    model_id: &str,
) -> Result<(), AiError> {
    if inner.config.settings.local_connections_only && known_cloud_model(inner, profile, model_id) {
        return Err(AiError::new(
            "local_connections_only",
            "This model is identified as a cloud model. Select another model or explicitly change the local-connections policy.",
        ));
    }
    Ok(())
}
fn known_cloud_model(inner: &Inner, profile: &ConnectionProfile, model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    let named_cloud = profile.protocol == Protocol::OllamaNative
        && (id.ends_with("-cloud") || id.ends_with(":cloud"));
    named_cloud
        || inner.remote_models.contains(&(
            profile.id.clone(),
            profile.revision,
            model_id.to_string(),
        ))
}
fn validate_context_scope(
    scenario: &str,
    incident_id: Option<&str>,
    from: Option<u64>,
    to: Option<u64>,
) -> Result<(), AiError> {
    if !matches!(scenario, "current_status" | "network" | "history" | "chat")
        || incident_id.is_some_and(|id| id.len() > 256 || id.chars().any(char::is_control))
        || matches!((from,to),(Some(left),Some(right)) if left>=right)
        || from.is_some() != to.is_some()
    {
        return Err(invalid("Choose a valid scenario and history time range."));
    }
    Ok(())
}
fn state(inner: &Inner) -> AiState {
    let storage_bytes = inner.store.storage_bytes();
    AiState {
        capabilities: inner
            .capabilities
            .iter()
            .filter(|record| {
                profile(inner, &record.connection_id)
                    .is_ok_and(|profile| profile.revision == record.profile_revision)
            })
            .cloned()
            .collect(),
        settings: inner.config.settings.clone(),
        connections: inner.config.connections.clone(),
        active_run: inner
            .active
            .as_ref()
            .map(|active| active.run.clone())
            .or_else(|| inner.last_run.clone()),
        storage_bytes,
        storage_warning: storage_bytes
            >= inner.config.settings.storage_budget_bytes.saturating_mul(4) / 5,
        request_epoch: inner.request_epoch,
    }
}
fn session(inner: &Inner, id: &str) -> Result<AiSession, AiError> {
    if inner.clearing_all {
        return Err(busy());
    }
    if let Some(active) = &inner.active
        && active.session.summary.id == id
    {
        return Ok(active.session.clone());
    }
    if let Some(session) = inner.temporary.get(id) {
        return Ok(session.clone());
    }
    if let Some(session) = inner.unsaved.get(id) {
        if !inner.store.exists(id)? {
            return Err(AiError::new(
                "session_not_found",
                "This conversation is no longer available.",
            ));
        }
        return Ok(session.clone());
    }
    inner.store.get(id)
}
fn save_session(inner: &mut Inner, value: &AiSession) -> Result<(), AiError> {
    let mut saved = value.clone();
    saved.summary.storage_status = if saved.summary.temporary {
        "temporary"
    } else {
        "saved"
    }
    .into();
    if value.summary.temporary {
        inner
            .temporary
            .insert(value.summary.id.clone(), saved.clone());
    } else {
        inner.store.update(&saved)?;
    }
    if let Some(active) = &mut inner.active
        && active.session.summary.id == value.summary.id
    {
        active.session = saved;
    }
    inner.unsaved.remove(&value.summary.id);
    Ok(())
}
fn persist_completed(inner: &mut Inner, active: &mut Active) {
    if active.session.summary.temporary {
        inner
            .temporary
            .insert(active.session.summary.id.clone(), active.session.clone());
    } else if let Err(error) = inner.store.complete_run(&active.session, &active.run) {
        active.session.summary.storage_status = "error".into();
        active.run.error = Some(error);
        inner
            .unsaved
            .insert(active.session.summary.id.clone(), active.session.clone());
    }
}
fn stop_active(inner: &mut Inner, status: &str) {
    if let Some(mut active) = inner.active.take() {
        active.cancelled.store(true, Ordering::Release);
        active.run.state = status.into();
        active.run.finished_at = Some(now());
        active.session.summary.revision += 1;
        if let Some(message) = active.session.messages.last_mut() {
            message.status = status.into();
            message.reusable_in_context = false;
            for step in &mut message.tool_steps {
                if matches!(step.state.as_str(), "running" | "awaiting_confirmation") {
                    step.state = status.into();
                    step.finished_at = Some(now());
                }
            }
        }
        persist_completed(inner, &mut active);
        if active.session.summary.temporary {
            inner
                .volatile_submissions
                .insert(active.run.submission_id.clone(), active.run.clone());
        }
        inner.last_run = Some(active.run);
    }
}
fn invalidate(inner: &mut Inner, status: &str) {
    inner.request_epoch += 1;
    inner.prepared.clear();
    if let Some(cancel) = inner.test_cancel.take() {
        cancel.store(true, Ordering::Release);
    }
    if let Some(cancel) = inner.discovery_cancel.take() {
        cancel.store(true, Ordering::Release);
    }
    stop_active(inner, status);
}
fn invalidate_collection(
    collection: &mut HashMap<String, AiSession>,
    category: &str,
    delete_related: bool,
) {
    if delete_related {
        collection.retain(|_, session| {
            !session
                .summary
                .source_categories
                .iter()
                .any(|source| source == category)
        });
    } else {
        for session in collection.values_mut().filter(|session| {
            session
                .summary
                .source_categories
                .iter()
                .any(|source| source == category)
        }) {
            session.summary.revision += 1;
            for message in &mut session.messages {
                message.reusable_in_context = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn fixture(url: &str) -> (tempfile::TempDir, Arc<AiService>, AiSession) {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(AiService::open(directory.path().join("ai.sqlite")).unwrap());
        let connection = service
            .save_connection(SaveConnectionInput {
                id: None,
                expected_revision: None,
                name: "Local model".into(),
                protocol: Protocol::OllamaNative,
                api_base_url: url.into(),
                auth_kind: AuthKind::None,
                network_policy: NetworkPolicy::Loopback,
                proxy_url: None,
                proxy_network_policy: None,
                auth_header_name: None,
                anthropic_workspace_id: None,
                chat_token_limit_parameter: "auto".into(),
                timeout_seconds: 10,
                max_output_tokens: 1024,
                stream: false,
            })
            .unwrap();
        service
            .update_settings(AiSettings {
                enabled: true,
                default_model: Some(ModelSelection {
                    connection_id: connection.id,
                    model_id: "chosen-model".into(),
                }),
                ..AiSettings::default()
            })
            .unwrap();
        let session = service
            .create_session(CreateSessionInput {
                title: Some("A conversation".into()),
                temporary: None,
                selected_model: None,
                scenario: None,
                incident_id: None,
                from_ms: None,
                to_ms: None,
            })
            .unwrap();
        (directory, service, session)
    }
    fn prepare(service: &AiService, session: &AiSession) -> PreparedAnalysis {
        service
            .prepare_with_context(
                PrepareInput {
                    expected_connection_revision: None,
                    language: None,
                    session_id: session.summary.id.clone(),
                    expected_revision: session.summary.revision,
                    text: "Why is this slow?".into(),
                    scenario: "current_status".into(),
                    include_context: true,
                    incident_id: None,
                    from_ms: None,
                    to_ms: None,
                },
                AiContextFacts {
                    captured_at: 123,
                    facts: vec![AiContextFact {
                        label: "CPU utilization".into(),
                        value: "72".into(),
                        unit: Some("percent".into()),
                        source_category: "resources".into(),
                    }],
                    coverage: vec!["Current sample only.".into()],
                },
            )
            .unwrap()
    }
    #[test]
    fn one_step_send_rejects_a_connection_changed_since_the_user_pressed_send() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let selection = session.summary.selected_model.as_ref().unwrap();
        let old_revision = profile(&service.lock().unwrap(), &selection.connection_id)
            .unwrap()
            .revision;
        service
            .lock()
            .unwrap()
            .config
            .connections
            .iter_mut()
            .find(|connection| connection.id == selection.connection_id)
            .unwrap()
            .revision += 1;
        let input = PrepareInput {
            expected_connection_revision: Some(old_revision),
            language: None,
            session_id: session.summary.id.clone(),
            expected_revision: session.summary.revision,
            text: "hello".into(),
            scenario: "current_status".into(),
            include_context: true,
            incident_id: None,
            from_ms: None,
            to_ms: None,
        };
        assert_eq!(
            service
                .prepare_with_context(input.clone(), AiContextFacts::default())
                .unwrap_err()
                .code,
            "stale_state"
        );
        assert!(service.lock().unwrap().prepared.is_empty());
        assert!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .is_empty()
        );
        service
            .prepare_with_context(
                PrepareInput {
                    expected_connection_revision: Some(old_revision + 1),
                    ..input
                },
                AiContextFacts::default(),
            )
            .unwrap();
    }
    fn input(prepared: &PreparedAnalysis, id: &str) -> StartInput {
        StartInput {
            preparation_id: prepared.id.clone(),
            submission_id: id.into(),
            expected_session_revision: prepared.session_revision,
        }
    }
    fn install_pending(service: &AiService, session: &AiSession) -> String {
        let mut inner = service.lock().unwrap();
        let mut session = session.clone();
        let run = AnalysisRun {
            request_id: "test-run".into(),
            session_id: session.summary.id.clone(),
            submission_id: "test-submission".into(),
            preparation_id: "test-preparation".into(),
            state: "pending".into(),
            started_at: now(),
            finished_at: None,
            error: None,
        };
        session.messages.push(AiMessage {
            tool_steps: Vec::new(),
            validated_result: None,
            id: "test-message".into(),
            role: "assistant".into(),
            content: String::new(),
            created_at: now(),
            status: "pending".into(),
            request_id: Some(run.request_id.clone()),
            model_label: None,
            source_categories: vec!["resources".into()],
            reusable_in_context: false,
            usage: None,
            context_text: None,
        });
        session.summary.source_categories.push("resources".into());
        inner
            .store
            .begin_run(&session, &run, DEFAULT_STORAGE_BUDGET)
            .unwrap();
        inner.active = Some(Active {
            application_action: false,
            pending_approval: None,
            result_evidence: Vec::new(),
            result_capability: None,
            run: run.clone(),
            session,
            cancelled: Arc::new(AtomicBool::new(false)),
            persisted_bytes: 0,
            persisted_at: Instant::now(),
            notified_at: Instant::now(),
            request_epoch: inner.request_epoch,
        });
        run.request_id
    }

    #[test]
    fn persistence_defaults_and_draft_conflicts_survive_restart() {
        let (directory, service, original) = fixture("http://127.0.0.1:11434");
        let saved = service
            .save_draft(SaveDraftInput {
                session_id: original.summary.id.clone(),
                expected_draft_revision: 1,
                text: "A saved draft".into(),
            })
            .unwrap();
        assert_eq!(
            service
                .save_draft(SaveDraftInput {
                    session_id: original.summary.id.clone(),
                    expected_draft_revision: 1,
                    text: "Stale overwrite".into()
                })
                .unwrap_err()
                .code,
            "stale_state"
        );
        let mut settings = service.get_state().unwrap().settings;
        settings.default_model.as_mut().unwrap().model_id = "new-default".into();
        service.update_settings(settings).unwrap();
        assert_eq!(
            service
                .get_session(&original.summary.id)
                .unwrap()
                .summary
                .selected_model
                .as_ref()
                .unwrap()
                .model_id,
            "chosen-model"
        );
        let next = service
            .create_session(CreateSessionInput {
                title: None,
                temporary: None,
                selected_model: None,
                scenario: None,
                incident_id: None,
                from_ms: None,
                to_ms: None,
            })
            .unwrap();
        assert_eq!(next.summary.selected_model.unwrap().model_id, "new-default");
        drop(service);
        let recovered = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        assert_eq!(
            recovered
                .get_session(&saved.summary.id)
                .unwrap()
                .summary
                .draft_text,
            "A saved draft"
        );
    }
    #[test]
    fn changing_model_preserves_old_chat_and_never_forwards_its_history() {
        let (directory, service, mut original) = fixture("http://127.0.0.1:11434");
        original.summary.draft_text = "An unsent private draft".into();
        original.summary.source_categories = vec!["resources".into()];
        original.messages.push(AiMessage {
            tool_steps: Vec::new(),
            validated_result: None,
            id: "old-message".into(),
            role: "user".into(),
            content: "Private history for the original model".into(),
            created_at: now(),
            status: "complete".into(),
            request_id: None,
            model_label: Some("Original model".into()),
            source_categories: vec!["resources".into()],
            reusable_in_context: true,
            usage: None,
            context_text: Some("[E1] CPU: 40%".into()),
        });
        save_session(&mut service.lock().unwrap(), &original).unwrap();
        let old_preview = prepare(&service, &original);
        let mut selection = original.summary.selected_model.clone().unwrap();
        selection.model_id = "different-model".into();
        let next = service
            .select_session_model(SelectSessionModelInput {
                session_id: original.summary.id.clone(),
                expected_revision: original.summary.revision,
                selection,
            })
            .unwrap();
        assert_ne!(next.summary.id, original.summary.id);
        assert!(next.messages.is_empty());
        assert!(next.summary.draft_text.is_empty());
        assert!(next.summary.source_categories.is_empty());
        assert!(prepare(&service, &next).history.is_empty());
        assert!(
            service
                .start(input(&old_preview, "stale-old-preview"))
                .is_err()
        );
        let old = service.get_session(&original.summary.id).unwrap();
        assert_eq!(old.summary.selected_model.unwrap().model_id, "chosen-model");
        assert_eq!(old.summary.draft_text, "An unsent private draft");
        assert_eq!(old.messages.len(), 1);
        drop(service);
        let reopened = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        assert_eq!(
            reopened
                .get_session(&original.summary.id)
                .unwrap()
                .messages
                .len(),
            1
        );
        assert!(
            reopened
                .get_session(&next.summary.id)
                .unwrap()
                .messages
                .is_empty()
        );
    }

    #[test]
    fn stale_previews_are_rejected_after_clear_and_model_change() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let prepared = prepare(&service, &session);
        service.invalidate_source("resources", false).unwrap();
        assert_eq!(
            service.start(input(&prepared, "one")).unwrap_err().code,
            "stale_state"
        );
        let prepared = prepare(&service, &session);
        let mut selection = session.summary.selected_model.clone().unwrap();
        selection.model_id = "another-model".into();
        service
            .select_session_model(SelectSessionModelInput {
                session_id: session.summary.id.clone(),
                expected_revision: session.summary.revision,
                selection,
            })
            .unwrap();
        assert_eq!(
            service.start(input(&prepared, "two")).unwrap_err().code,
            "stale_state"
        );
        assert!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .is_empty()
        );
    }

    #[test]
    fn legacy_schema_observations_do_not_change_chat_format_after_restart() {
        let (directory, service, session) = fixture("http://127.0.0.1:11434");
        let selected = session.summary.selected_model.as_ref().unwrap();
        {
            let mut inner = service.lock().unwrap();
            let profile = profile(&inner, &selected.connection_id).unwrap().clone();
            record_capability(
                &mut inner,
                capability_record(&profile, &selected.model_id, "text", "verified"),
            )
            .unwrap();
            record_capability(
                &mut inner,
                capability_record(&profile, &selected.model_id, "schema", "verified"),
            )
            .unwrap();
        }
        drop(service);
        let reopened = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        let state = reopened.get_state().unwrap();
        assert!(
            state
                .capabilities
                .iter()
                .any(|record| record.kind == "text" && record.status == "verified")
        );
        assert!(
            !state
                .capabilities
                .iter()
                .any(|record| record.kind == "schema")
        );
        let prepared = prepare(&reopened, &session);
        let inner = reopened.lock().unwrap();
        let system = &inner.prepared[&prepared.id].system;
        assert!(system.contains("Respond in natural language"));
        assert!(!system.contains("summary, findings, unknowns and nextSteps"));
    }

    #[test]
    fn removed_grants_quotas_and_overrides_do_not_block_existing_settings_or_drafts() {
        let (directory, service, original) = fixture("http://127.0.0.1:11434");
        let saved = service
            .save_draft(SaveDraftInput {
                session_id: original.summary.id.clone(),
                expected_draft_revision: original.summary.draft_revision,
                text: "Keep my existing draft".into(),
            })
            .unwrap();
        {
            let inner = service.lock().unwrap();
            let mut legacy = serde_json::to_value(&inner.config).unwrap();
            legacy["settings"]["dailyRequestLimit"] = 0.into();
            legacy["settings"]["scenarioModels"] = serde_json::json!({
                "network": {"connectionId": "removed-connection", "modelId": "old-override"}
            });
            inner.store.write_meta("config", &legacy).unwrap();
            inner
                .store
                .write_meta("grants", &"obsolete invalid grant representation")
                .unwrap();
        }
        drop(service);
        let path = directory.path().join("ai.sqlite");
        {
            let database = rusqlite::Connection::open(&path).unwrap();
            database
                .execute_batch(
                    "CREATE TABLE ai_daily(day TEXT PRIMARY KEY,requests INTEGER NOT NULL);
                 INSERT INTO ai_daily VALUES('2026-09-08',10001);",
                )
                .unwrap();
        }
        let reopened = AiService::open(path.clone()).unwrap();
        let restored = reopened.get_session(&original.summary.id).unwrap();
        assert_eq!(restored.summary.draft_text, saved.summary.draft_text);
        assert_eq!(
            restored.summary.selected_model,
            saved.summary.selected_model
        );
        assert_eq!(
            restored.summary.draft_revision,
            saved.summary.draft_revision
        );
        assert_eq!(reopened.get_state().unwrap().connections.len(), 1);
        let settings = serde_json::to_value(reopened.get_state().unwrap().settings).unwrap();
        assert!(settings.get("dailyRequestLimit").is_none());
        assert!(settings.get("scenarioModels").is_none());
        assert!(
            reopened
                .lock()
                .unwrap()
                .store
                .read_meta::<serde_json::Value>("grants")
                .unwrap()
                .is_none()
        );
        let database = rusqlite::Connection::open(path).unwrap();
        assert_eq!(
            database
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ai_daily'",
                    [],
                    |row| row.get::<_, i32>(0)
                )
                .unwrap(),
            0
        );
        // Preparing is local only and does not contact the real Ollama listener.
        assert_eq!(
            prepare(&reopened, &restored).selection,
            saved.summary.selected_model.unwrap()
        );
    }

    #[test]
    fn newly_known_cloud_processing_invalidates_old_preview() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let old = prepare(&service, &session);
        {
            let mut inner = service.lock().unwrap();
            let selected = session.summary.selected_model.as_ref().unwrap();
            let revision = profile(&inner, &selected.connection_id).unwrap().revision;
            inner.remote_models.insert((
                selected.connection_id.clone(),
                revision,
                selected.model_id.clone(),
            ));
        }
        assert_eq!(
            service
                .start(input(&old, "old-processing-location"))
                .unwrap_err()
                .code,
            "stale_state"
        );
        let updated = prepare(&service, &session);
        assert_eq!(updated.processing_location, "remote");
    }

    #[test]
    fn invalid_model_json_is_kept_as_unverified_text_without_creating_actions() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let request = install_pending(&service, &session);
        service.finish(&request, Ok(ProviderCompletion { tool_calls: Vec::new(), continuation: Vec::new(), text:r#"{"summary":"Invalid evidence","findings":[{"statement":"Invented","kind":"observation","evidenceIds":["E999"]}],"unknowns":[],"nextSteps":[]}"#.into(), usage:None,reported_model:None }));
        let saved = service.get_session(&session.summary.id).unwrap();
        assert!(saved.messages[0].validated_result.is_none());
        assert_eq!(saved.messages[0].status, "complete");
    }

    #[test]
    fn native_message_pages_keep_whole_session_revision_and_draft_without_overlap() {
        let (_directory, _service, mut session) = fixture("http://127.0.0.1:11434");
        session.summary.draft_text = "Keep my draft".into();
        session.messages = (0..65)
            .map(|index| AiMessage {
                tool_steps: Vec::new(),
                validated_result: None,
                id: index.to_string(),
                role: "user".into(),
                content: "Synthetic message".into(),
                created_at: now(),
                status: "complete".into(),
                request_id: None,
                model_label: None,
                source_categories: vec![],
                reusable_in_context: true,
                usage: None,
                context_text: None,
            })
            .collect();
        let recent = SessionView::page(session.clone(), None);
        assert_eq!(recent.messages.len(), 30);
        assert_eq!(recent.messages[0].id, "35");
        assert_eq!(recent.total_messages, 65);
        let earlier = SessionView::page(session.clone(), Some(recent.message_offset as u32));
        assert_eq!(earlier.messages[0].id, "5");
        assert_eq!(earlier.messages.last().unwrap().id, "34");
        assert_eq!(earlier.summary.draft_text, "Keep my draft");
        let first = SessionView::page(session, Some(earlier.message_offset as u32));
        assert!(!first.has_older_messages);
        assert_eq!(first.messages.len(), 5);
    }
    #[test]
    fn save_before_send_and_no_automatic_eviction_when_full() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let prepared = prepare(&service, &session);
        service.lock().unwrap().config.settings.storage_budget_bytes = 1;
        assert_eq!(
            service.start(input(&prepared, "full")).unwrap_err().code,
            "storage_full"
        );
        assert!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .is_empty()
        );
        assert!(service.get_state().unwrap().active_run.is_none());
        assert_eq!(service.list_sessions(None, None).unwrap().sessions.len(), 1);
    }
    #[test]
    fn crash_recovery_marks_partial_reply_interrupted_without_replay() {
        let (directory, service, session) = fixture("http://127.0.0.1:11434");
        let request_id = install_pending(&service, &session);
        service.delta(&request_id, &"partial ".repeat(600));
        drop(service);
        let recovered = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        let saved = recovered.get_session(&session.summary.id).unwrap();
        assert_eq!(saved.messages[0].status, "interrupted");
        assert!(!saved.messages[0].content.is_empty());
        assert!(!saved.messages[0].reusable_in_context);
        assert!(recovered.get_state().unwrap().active_run.is_none());
        assert_eq!(
            recovered
                .lock()
                .unwrap()
                .store
                .submission("test-submission")
                .unwrap()
                .unwrap()
                .state,
            "interrupted"
        );
    }
    #[test]
    fn delete_rejects_late_stream_finish_and_draft_writes() {
        let (directory, service, session) = fixture("http://127.0.0.1:11434");
        let request_id = install_pending(&service, &session);
        service.delta(&request_id, "first part");
        service.delete_session(&session.summary.id).unwrap();
        service.delta(&request_id, "late part");
        service.finish(
            &request_id,
            Ok(ProviderCompletion {
                tool_calls: Vec::new(),
                continuation: Vec::new(),
                text: "late complete".into(),
                usage: None,
                reported_model: None,
            }),
        );
        assert_eq!(
            service.get_session(&session.summary.id).unwrap_err().code,
            "session_not_found"
        );
        assert_eq!(
            service
                .save_draft(SaveDraftInput {
                    session_id: session.summary.id.clone(),
                    expected_draft_revision: 1,
                    text: "late draft".into()
                })
                .unwrap_err()
                .code,
            "session_not_found"
        );
        drop(service);
        let recovered = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        assert!(
            recovered
                .list_sessions(None, None)
                .unwrap()
                .sessions
                .is_empty()
        );
    }
    #[test]
    fn source_clear_preserves_visible_history_but_blocks_derived_context() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let request_id = install_pending(&service, &session);
        service.finish(
            &request_id,
            Ok(ProviderCompletion {
                tool_calls: Vec::new(),
                continuation: Vec::new(),
                text: "A derived summary of the CPU evidence".into(),
                usage: None,
                reported_model: None,
            }),
        );
        service.invalidate_source("resources", false).unwrap();
        let recovered = service.get_session(&session.summary.id).unwrap();
        assert_eq!(recovered.messages.len(), 1);
        assert!(!recovered.messages[0].reusable_in_context);
        let preview = prepare(&service, &recovered);
        assert!(preview.history.is_empty());
        service.invalidate_source("resources", true).unwrap();
        assert!(service.get_session(&session.summary.id).is_err());
    }
    #[test]
    fn temporary_credentials_and_chats_never_enter_database() {
        let (directory, service, _) = fixture("http://127.0.0.1:11434");
        let connection = service
            .save_connection(SaveConnectionInput {
                id: None,
                expected_revision: None,
                name: "Temporary credentials".into(),
                protocol: Protocol::OpenaiChat,
                api_base_url: "http://127.0.0.1:11434/v1".into(),
                auth_kind: AuthKind::Bearer,
                network_policy: NetworkPolicy::Loopback,
                proxy_url: None,
                proxy_network_policy: None,
                auth_header_name: None,
                anthropic_workspace_id: None,
                chat_token_limit_parameter: "auto".into(),
                timeout_seconds: 10,
                max_output_tokens: 1024,
                stream: false,
            })
            .unwrap();
        let secret = "test-only-credential-never-store";
        service
            .set_credential(SetCredentialInput {
                connection_id: connection.id.clone(),
                secret: secret.into(),
                temporary: true,
            })
            .unwrap();
        assert!(
            !serde_json::to_string(&service.get_state().unwrap())
                .unwrap()
                .contains(secret)
        );
        let temporary = service
            .create_session(CreateSessionInput {
                title: Some("Temporary private chat".into()),
                temporary: Some(true),
                selected_model: None,
                scenario: None,
                incident_id: None,
                from_ms: None,
                to_ms: None,
            })
            .unwrap();
        service
            .save_draft(SaveDraftInput {
                session_id: temporary.summary.id.clone(),
                expected_draft_revision: 1,
                text: "temporary-private-draft-marker".into(),
            })
            .unwrap();
        drop(service);
        for filename in ["ai.sqlite", "ai.sqlite-wal"] {
            if let Ok(bytes) = std::fs::read(directory.path().join(filename)) {
                let text = String::from_utf8_lossy(&bytes);
                assert!(!text.contains(secret));
                assert!(!text.contains("temporary-private-draft-marker"));
            }
        }
        let recovered = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        assert!(recovered.get_session(&temporary.summary.id).is_err());
        assert_eq!(
            recovered
                .get_state()
                .unwrap()
                .connections
                .iter()
                .find(|profile| profile.id == connection.id)
                .unwrap()
                .credential_status,
            "missing"
        );
    }
    #[test]
    fn disabled_ai_preserves_read_and_delete_access_to_local_history() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let mut settings = service.get_state().unwrap().settings;
        settings.enabled = false;
        service.update_settings(settings).unwrap();
        assert!(service.get_session(&session.summary.id).is_ok());
        service.delete_session(&session.summary.id).unwrap();
    }
    #[test]
    fn storage_failure_before_send_and_during_stream_never_claims_saved() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let prepared = prepare(&service, &session);
        service.lock().unwrap().store.fail_writes(true);
        assert_eq!(
            service
                .start(input(&prepared, "disk-write-failed"))
                .unwrap_err()
                .code,
            "storage_error"
        );
        assert!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .is_empty()
        );
        assert!(service.get_state().unwrap().active_run.is_none());
        service.lock().unwrap().store.fail_writes(false);
        let request_id = install_pending(&service, &session);
        service.lock().unwrap().store.fail_writes(true);
        let partial = "Unsaved reply content. ".repeat(300);
        service.delta(&request_id, &partial);
        service.finish(&request_id, Err(AiError::new("cancelled", "cancelled")));
        let saved = service.get_session(&session.summary.id).unwrap();
        assert_eq!(saved.summary.storage_status, "error");
        assert_eq!(saved.messages[0].content, partial);
        service.lock().unwrap().store.fail_writes(false);
        let recovered = service
            .save_draft(SaveDraftInput {
                session_id: session.summary.id.clone(),
                expected_draft_revision: saved.summary.draft_revision,
                text: "Keep this draft".into(),
            })
            .unwrap();
        assert_eq!(recovered.summary.storage_status, "saved");
        assert!(service.lock().unwrap().unsaved.is_empty());
        assert_eq!(
            service
                .lock()
                .unwrap()
                .store
                .get(&session.summary.id)
                .unwrap()
                .messages[0]
                .content,
            partial
        );
    }
    #[test]
    fn one_default_applies_to_every_scene_without_rerouting_existing_conversations() {
        let (_directory, service, original) = fixture("http://127.0.0.1:11434");
        let cloud = service
            .save_connection(SaveConnectionInput {
                id: None,
                expected_revision: None,
                name: "Cloud".into(),
                protocol: Protocol::OpenaiChat,
                api_base_url: "https://api.example.com/v1".into(),
                auth_kind: AuthKind::None,
                auth_header_name: None,
                network_policy: NetworkPolicy::Public,
                proxy_url: None,
                proxy_network_policy: None,
                anthropic_workspace_id: None,
                chat_token_limit_parameter: "auto".into(),
                timeout_seconds: 60,
                max_output_tokens: 1024,
                stream: false,
            })
            .unwrap();
        let mut settings = service.get_state().unwrap().settings;
        settings.default_model = Some(ModelSelection {
            connection_id: cloud.id.clone(),
            model_id: "cloud-model".into(),
        });
        service.update_settings(settings.clone()).unwrap();
        for scenario in ["current_status", "network", "history"] {
            let session = service
                .create_session(CreateSessionInput {
                    title: None,
                    temporary: None,
                    selected_model: None,
                    scenario: Some(scenario.into()),
                    incident_id: None,
                    from_ms: None,
                    to_ms: None,
                })
                .unwrap();
            assert_eq!(session.summary.selected_model, settings.default_model);
        }
        assert_eq!(
            service
                .get_session(&original.summary.id)
                .unwrap()
                .summary
                .selected_model,
            original.summary.selected_model
        );
        let cloud_session = service
            .create_session(CreateSessionInput {
                title: None,
                temporary: None,
                selected_model: None,
                scenario: None,
                incident_id: None,
                from_ms: None,
                to_ms: None,
            })
            .unwrap();
        settings.local_connections_only = true;
        service.update_settings(settings).unwrap();
        let error = service
            .prepare_with_context(
                PrepareInput {
                    expected_connection_revision: None,
                    language: None,
                    session_id: cloud_session.summary.id.clone(),
                    expected_revision: cloud_session.summary.revision,
                    text: "hello".into(),
                    scenario: "current_status".into(),
                    include_context: false,
                    incident_id: None,
                    from_ms: None,
                    to_ms: None,
                },
                AiContextFacts::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, "local_connections_only");
        assert!(prepare(&service, &original).proxy_url.is_none());
    }
    #[test]
    fn proxy_credential_is_separate_from_model_credential_and_never_in_config() {
        let (_directory, service, _) = fixture("http://127.0.0.1:11434");
        let connection = service
            .save_connection(SaveConnectionInput {
                id: None,
                expected_revision: None,
                name: "Proxied".into(),
                protocol: Protocol::OpenaiChat,
                api_base_url: "https://api.example.com/v1".into(),
                auth_kind: AuthKind::Bearer,
                auth_header_name: None,
                network_policy: NetworkPolicy::Public,
                proxy_url: Some("http://127.0.0.1:8080".into()),
                proxy_network_policy: None,
                anthropic_workspace_id: None,
                chat_token_limit_parameter: "max_tokens".into(),
                timeout_seconds: 60,
                max_output_tokens: 1024,
                stream: false,
            })
            .unwrap();
        service
            .set_credential(SetCredentialInput {
                connection_id: connection.id.clone(),
                secret: "model-secret-marker".into(),
                temporary: true,
            })
            .unwrap();
        service
            .set_proxy_credential(SetProxyCredentialInput {
                connection_id: connection.id.clone(),
                username: "proxy-user-marker".into(),
                password: "proxy-secret-marker".into(),
                temporary: true,
            })
            .unwrap();
        let json = serde_json::to_string(&service.get_state().unwrap()).unwrap();
        assert!(!json.contains("model-secret-marker"));
        assert!(!json.contains("proxy-user-marker"));
        assert!(!json.contains("proxy-secret-marker"));
        {
            let inner = service.lock().unwrap();
            let profile = profile(&inner, &connection.id).unwrap();
            assert_eq!(
                credential(&inner, profile).unwrap().unwrap(),
                "model-secret-marker"
            );
            assert_eq!(
                proxy_credential(&inner, profile).unwrap().unwrap().password,
                "proxy-secret-marker"
            );
        }
        service.delete_proxy_credential(&connection.id).unwrap();
        let inner = service.lock().unwrap();
        let profile = profile(&inner, &connection.id).unwrap();
        assert!(proxy_credential(&inner, profile).unwrap().is_none());
        assert!(credential(&inner, profile).unwrap().is_some());
    }
    #[test]
    fn conversation_scope_survives_handoff_and_invalidates_old_preview() {
        let (directory, service, session) = fixture("http://127.0.0.1:11434");
        let preview = prepare(&service, &session);
        let updated = service
            .set_session_context(SetSessionContextInput {
                session_id: session.summary.id.clone(),
                expected_revision: session.summary.revision,
                scenario: "history".into(),
                incident_id: Some("incident-7".into()),
                from_ms: Some(1000),
                to_ms: Some(2000),
            })
            .unwrap();
        assert_eq!(
            service
                .start(input(&preview, "old-scope"))
                .unwrap_err()
                .code,
            "stale_state"
        );
        assert_eq!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .summary
                .scenario,
            "history"
        );
        drop(service);
        let reopened = AiService::open(directory.path().join("ai.sqlite")).unwrap();
        let restored = reopened.get_session(&session.summary.id).unwrap();
        assert_eq!(restored.summary.incident_id, Some("incident-7".into()));
        assert_eq!(restored.summary.from_ms, Some(1000));
        assert_eq!(restored.summary.to_ms, Some(2000));
        assert_eq!(restored.summary.revision, updated.summary.revision);
    }
    #[test]
    fn local_policy_rejects_known_cloud_models_and_all_proxies() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let mut inner = service.lock().unwrap();
        inner.config.settings.local_connections_only = true;
        let mut profile = inner.config.connections[0].clone();
        for model in ["gpt-oss:120b-cloud", "model:cloud"] {
            assert_eq!(
                validate_model_destination(&inner, &profile, model)
                    .unwrap_err()
                    .code,
                "local_connections_only"
            );
        }
        assert!(validate_model_destination(&inner, &profile, "location-not-verified").is_ok());
        inner.remote_models.insert((
            profile.id.clone(),
            profile.revision,
            "custom-cloud-alias".into(),
        ));
        assert_eq!(
            validate_model_destination(&inner, &profile, "custom-cloud-alias")
                .unwrap_err()
                .code,
            "local_connections_only"
        );
        profile.proxy_url = Some("http://127.0.0.1:8080".into());
        assert_eq!(
            validate_destination(&inner, &profile).unwrap_err().code,
            "local_connections_only"
        );
        drop(inner);
        assert!(prepare(&service, &session).proxy_url.is_none());
    }
    #[test]
    fn streamed_tokens_are_lossless_and_notification_bursts_are_bounded() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let request_id = install_pending(&service, &session);
        let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = notifications.clone();
        service.set_notifier(Arc::new(move || {
            observed.fetch_add(1, Ordering::Relaxed);
        }));
        let started = Instant::now();
        for _ in 0..1000 {
            service.delta(&request_id, "x");
        }
        let updates = notifications.load(Ordering::Relaxed);
        assert!(updates <= (started.elapsed().as_millis() / 40 + 1) as usize);
        assert_eq!(
            service.get_session(&session.summary.id).unwrap().messages[0]
                .content
                .len(),
            1000
        );
        service.cancel(&request_id).unwrap();
        assert_eq!(notifications.load(Ordering::Relaxed), updates + 1);
    }
    #[tokio::test]
    async fn blocked_keyring_lookup_does_not_block_state_or_cancel_and_late_secret_is_discarded() {
        let (_directory, service, session) = fixture("http://127.0.0.1:11434");
        let request_id = install_pending(&service, &session);
        let cancel = service
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .cancelled
            .clone();
        let started = Arc::new(AtomicBool::new(false));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let plan = CredentialPlan {
            auth: CredentialLookup::Blocked {
                started: started.clone(),
                release: release_rx,
                value: "late-test-secret".into(),
            },
            proxy: CredentialLookup::Memory(None),
        };
        let lookup_service = service.clone();
        let lookup =
            tokio::spawn(async move { lookup_service.resolve_credentials(plan, cancel, 30).await });
        for _ in 0..100 {
            if started.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(started.load(Ordering::Acquire));
        let state_service = service.clone();
        let snapshot = tokio::task::spawn_blocking(move || state_service.get_state());
        assert!(
            tokio::time::timeout(Duration::from_millis(200), snapshot)
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        let cancel_service = service.clone();
        let cancel_id = request_id.clone();
        let cancellation = tokio::task::spawn_blocking(move || cancel_service.cancel(&cancel_id));
        assert!(
            tokio::time::timeout(Duration::from_millis(200), cancellation)
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        let outcome = tokio::time::timeout(Duration::from_millis(200), lookup)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(outcome,Err(error) if error.code=="cancelled"));
        // The OS request itself is non-cancellable; no second blocking lookup
        // can accumulate while its prompt remains open.
        assert!(service.keyring_guard().is_err());
        release_tx.send(()).unwrap();
        for _ in 0..100 {
            if !service.keyring_io.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!service.keyring_io.load(Ordering::Acquire));
        let profile = service.get_state().unwrap().connections[0].clone();
        assert_eq!(
            service
                .ready_for_send(&request_id, &profile)
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(
            service.get_session(&session.summary.id).unwrap().messages[0].status,
            "cancelled"
        );
    }
    #[tokio::test]
    async fn actual_request_matches_preview_and_duplicate_submission_is_not_replayed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let body_start;
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    body_start = index + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&bytes[..body_start]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < body_start + length {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            tx.send(
                serde_json::from_slice::<serde_json::Value>(
                    &bytes[body_start..body_start + length],
                )
                .unwrap(),
            )
            .unwrap();
            let body = r#"{"model":"chosen-model","message":{"role":"assistant","content":"A complete grounded explanation"},"done":true,"done_reason":"stop","prompt_eval_count":15,"eval_count":7}"#;
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let (directory, service, session) = fixture(&format!("http://{address}"));
        let prepared = prepare(&service, &session);
        let submission = input(&prepared, "stable-submission");
        let first = service.start(submission.clone()).unwrap();
        let repeated = service.start(submission.clone()).unwrap();
        assert_eq!(first.request_id, repeated.request_id);
        for _ in 0..200 {
            if service
                .get_state()
                .unwrap()
                .active_run
                .as_ref()
                .is_some_and(|run| run.state == "complete")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        assert_eq!(request["messages"][1]["content"], prepared.preview);
        assert_eq!(request["model"], "chosen-model");
        assert!(request.get("tools").is_none());
        let saved = service.get_session(&session.summary.id).unwrap();
        assert_eq!(saved.messages.last().unwrap().status, "complete");
        assert_eq!(
            saved
                .messages
                .last()
                .unwrap()
                .usage
                .as_ref()
                .unwrap()
                .output_tokens,
            Some(7)
        );
        service.shutdown();
        drop(service);
        let restarted = Arc::new(AiService::open(directory.path().join("ai.sqlite")).unwrap());
        assert_eq!(
            restarted.start(submission).unwrap().request_id,
            first.request_id
        );
        assert_eq!(
            restarted
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .len(),
            2
        );
    }
    mod task_tests {
        include!("task_tests.rs");
    }
}

#[path = "capability_action_service.rs"]
mod capability_action_service;
