use serde::{Deserialize, Serialize};

pub const DEFAULT_STORAGE_BUDGET: u64 = 256 * 1024 * 1024;
pub const MAX_INPUT_BYTES: usize = 32 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_TASK_METADATA_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: String,
    pub message: String,
}
impl AiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn storage(_: impl std::fmt::Display) -> Self {
        Self::new(
            "storage_error",
            "AI records could not be saved. Check available disk space and try again.",
        )
    }
}
impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AiError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    OllamaNative,
    OpenaiChat,
    OpenaiResponses,
    AnthropicMessages,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    None,
    Bearer,
    ApiKey,
    CustomHeader,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Loopback,
    Public,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub connection_id: String,
    pub model_id: String,
}

pub fn default_stream() -> bool {
    true
}
pub fn default_token_parameter() -> String {
    "auto".into()
}
pub fn default_scenario() -> String {
    "current_status".into()
}
pub fn unknown_location() -> String {
    "unknown".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub protocol: Protocol,
    pub api_base_url: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub auth_header_name: Option<String>,
    pub network_policy: NetworkPolicy,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub proxy_network_policy: Option<NetworkPolicy>,
    #[serde(default)]
    pub proxy_credential_status: String,
    #[serde(default)]
    pub anthropic_workspace_id: Option<String>,
    #[serde(default = "default_token_parameter")]
    pub chat_token_limit_parameter: String,
    pub timeout_seconds: u64,
    pub max_output_tokens: u32,
    #[serde(default = "default_stream")]
    pub stream: bool,
    pub credential_status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub name: String,
    pub protocol: Protocol,
    pub api_base_url: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub auth_header_name: Option<String>,
    pub network_policy: NetworkPolicy,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub proxy_network_policy: Option<NetworkPolicy>,
    #[serde(default)]
    pub anthropic_workspace_id: Option<String>,
    #[serde(default = "default_token_parameter")]
    pub chat_token_limit_parameter: String,
    pub timeout_seconds: u64,
    pub max_output_tokens: u32,
    #[serde(default = "default_stream")]
    pub stream: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialInput {
    pub connection_id: String,
    pub secret: String,
    pub temporary: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProxyCredentialInput {
    pub connection_id: String,
    pub username: String,
    pub password: String,
    pub temporary: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProxyCredential {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enabled: bool,
    pub default_model: Option<ModelSelection>,
    pub storage_budget_bytes: u64,
    #[serde(default)]
    pub local_connections_only: bool,
}
impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_model: None,
            storage_budget_bytes: DEFAULT_STORAGE_BUDGET,
            local_connections_only: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiState {
    pub capabilities: Vec<CapabilityRecord>,
    pub settings: AiSettings,
    pub connections: Vec<ConnectionProfile>,
    pub active_run: Option<AnalysisRun>,
    pub storage_bytes: u64,
    pub storage_warning: bool,
    pub request_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSummary {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub temporary: bool,
    pub selected_model: Option<ModelSelection>,
    #[serde(default = "default_scenario")]
    pub scenario: String,
    #[serde(default)]
    pub incident_id: Option<String>,
    #[serde(default)]
    pub from_ms: Option<u64>,
    #[serde(default)]
    pub to_ms: Option<u64>,
    pub draft_text: String,
    pub draft_revision: u64,
    pub storage_status: String,
    pub source_categories: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    #[serde(flatten)]
    pub summary: AiSessionSummary,
    pub messages: Vec<AiMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub summary: AiSessionSummary,
    pub messages: Vec<AiMessage>,
    pub total_messages: usize,
    pub message_offset: usize,
    pub has_older_messages: bool,
}
impl SessionView {
    pub fn page(session: AiSession, before: Option<u32>) -> Self {
        let total_messages = session.messages.len();
        let end = before.map_or(total_messages, |value| (value as usize).min(total_messages));
        let mut start = end;
        let mut bytes = 0;
        while start > 0 && end - start < 30 {
            let message = &session.messages[start - 1];
            let size = serde_json::to_vec(message).map_or(2 * 1024 * 1024, |bytes| bytes.len());
            if start < end && bytes + size > 2 * 1024 * 1024 {
                break;
            }
            bytes += size;
            start -= 1;
        }
        Self {
            summary: session.summary,
            messages: session
                .messages
                .into_iter()
                .skip(start)
                .take(end - start)
                .collect(),
            total_messages,
            message_offset: start,
            has_older_messages: start > 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    #[serde(default)]
    pub tool_steps: Vec<ToolStep>,
    #[serde(default)]
    pub validated_result: Option<ValidatedResult>,
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    pub status: String,
    pub request_id: Option<String>,
    pub model_label: Option<String>,
    pub source_categories: Vec<String>,
    pub reusable_in_context: bool,
    pub usage: Option<TokenUsage>,
    #[serde(default)]
    pub context_text: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<AiSessionSummary>,
    pub has_more: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub title: Option<String>,
    pub temporary: Option<bool>,
    pub selected_model: Option<ModelSelection>,
    pub scenario: Option<String>,
    pub incident_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionContextInput {
    pub session_id: String,
    pub expected_revision: u64,
    pub scenario: String,
    pub incident_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftInput {
    pub session_id: String,
    pub expected_draft_revision: u64,
    pub text: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectSessionModelInput {
    pub session_id: String,
    pub expected_revision: u64,
    pub selection: ModelSelection,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareInput {
    #[serde(default)]
    pub expected_connection_revision: Option<u64>,
    #[serde(default)]
    pub language: Option<String>,
    pub session_id: String,
    pub expected_revision: u64,
    pub text: String,
    pub scenario: String,
    pub include_context: bool,
    pub incident_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAnalysis {
    pub processing_location: String,
    pub connection_location: NetworkPolicy,
    pub id: String,
    pub session_id: String,
    pub session_revision: u64,
    pub expires_at: u64,
    pub selection: ModelSelection,
    pub connection_name: String,
    pub endpoint: String,
    pub proxy_url: Option<String>,
    pub protocol: Protocol,
    pub preview: String,
    pub user_text: String,
    pub history: Vec<ProviderMessage>,
    pub scenario: String,
    pub source_categories: Vec<String>,
    pub coverage: Vec<String>,
    pub request_epoch: u64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub preparation_id: String,
    pub submission_id: String,
    pub expected_session_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRun {
    pub request_id: String,
    pub session_id: String,
    pub submission_id: String,
    pub preparation_id: String,
    pub state: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<AiError>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    #[serde(default = "unknown_location")]
    pub processing_location: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMessage {
    pub role: String,
    pub content: String,
}
#[derive(Clone)]
pub struct ProviderRequest {
    pub tools: Vec<ToolDefinition>,
    pub tool_turns: Vec<ProviderToolTurn>,
    pub profile: ConnectionProfile,
    pub api_key: Option<String>,
    pub proxy_credentials: Option<ProxyCredential>,
    pub model_id: String,
    pub system: String,
    pub messages: Vec<ProviderMessage>,
    pub max_output_tokens: u32,
    pub stream: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCompletion {
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// Protocol continuation, including reasoning where required. Current run
    /// only: never serialize, show, persist, or reuse in a later user turn.
    #[serde(skip)]
    pub continuation: Vec<serde_json::Value>,
    pub text: String,
    pub usage: Option<TokenUsage>,
    pub reported_model: Option<String>,
}

impl std::fmt::Debug for ProviderCompletion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderCompletion")
            .field("text", &self.text)
            .field("tool_calls", &self.tool_calls)
            .field("usage", &self.usage)
            .field("reported_model", &self.reported_model)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}
#[derive(Clone)]
pub struct ProviderToolTurn {
    pub assistant: Vec<serde_json::Value>,
    pub results: Vec<ToolResult>,
}
#[derive(Clone)]
pub struct ToolResult {
    pub call: ToolCall,
    pub output: String,
    pub is_error: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStep {
    #[serde(default)]
    pub actions_expires_at: Option<u64>,
    pub id: String,
    pub name: String,
    pub state: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub result: Option<String>,
    pub error: Option<AiError>,
    pub confirmation: Option<ToolConfirmation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfirmation {
    pub action: String,
    pub targets: Vec<String>,
    pub detail: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Default)]
pub struct AiContextFacts {
    pub captured_at: u64,
    pub facts: Vec<AiContextFact>,
    pub coverage: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct AiContextFact {
    pub label: String,
    pub value: String,
    pub unit: Option<String>,
    pub source_category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    pub id: String,
    pub label: String,
    pub value: String,
    pub unit: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedResult {
    pub result: super::structured::DiagnosticResult,
    pub evidence: Vec<EvidenceReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRecord {
    pub connection_id: String,
    pub profile_revision: u64,
    pub model_id: String,
    pub checked_at: u64,
    pub kind: String,
    pub status: String,
}
