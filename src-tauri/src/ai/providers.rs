//! Four independent protocol codecs with a shared bounded transport.
//! Visible text streams separately from bounded function-call continuation.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};

use super::provider_tools::{ToolDecoder, append_turns};
use super::transport::{self, MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, Transport};
use super::types::{
    AiError, AuthKind, ConnectionProfile, ModelInfo, Protocol, ProviderCompletion, ProviderRequest,
    ProxyCredential, TokenUsage,
};

pub type DeltaCallback = Arc<dyn Fn(&str) + Send + Sync>;
const MODEL_PAGE_LIMIT: usize = 20;
const MODEL_COUNT_LIMIT: usize = 2000;

fn malformed() -> AiError {
    AiError::new(
        "invalid_response",
        "The service returned an invalid response for the selected protocol.",
    )
}
fn interrupted() -> AiError {
    AiError::new(
        "incomplete_response",
        "The model response ended before a complete answer was confirmed.",
    )
}
fn refused() -> AiError {
    AiError::new(
        "model_refused",
        "The model declined to answer this request.",
    )
}
fn unsupported_content() -> AiError {
    AiError::new(
        "unsupported_content",
        "The model returned a content type this text assistant cannot use.",
    )
}

fn headers(profile: &ConnectionProfile, key: Option<&str>) -> Result<HeaderMap, AiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream, application/x-ndjson"),
    );
    if matches!(profile.protocol, Protocol::AnthropicMessages) {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        if let Some(workspace) = profile.anthropic_workspace_id.as_deref() {
            headers.insert(
                "anthropic-workspace-id",
                HeaderValue::from_str(workspace).map_err(|_| {
                    AiError::new("invalid_workspace", "Enter a valid Anthropic workspace ID.")
                })?,
            );
        }
    }
    if !matches!(profile.auth_kind, AuthKind::None) {
        let key = key.filter(|k| !k.is_empty()).ok_or_else(|| {
            AiError::new(
                "credential_missing",
                "Set an API credential for this connection.",
            )
        })?;
        if key.len() > 8192 {
            return Err(AiError::new(
                "invalid_credential",
                "The API credential is too long.",
            ));
        }
        let (name, value) = match profile.auth_kind {
            AuthKind::Bearer => (AUTHORIZATION, format!("Bearer {key}")),
            // Explicit x-api-key authentication is also used by user-managed
            // compatible gateways. Selecting it never adds Bearer authentication.
            AuthKind::ApiKey => (
                reqwest::header::HeaderName::from_static("x-api-key"),
                key.to_owned(),
            ),
            AuthKind::CustomHeader => (
                transport::custom_auth_header(
                    profile.auth_header_name.as_deref().unwrap_or_default(),
                )?,
                key.to_owned(),
            ),
            _ => {
                return Err(AiError::new(
                    "unsupported_auth",
                    "This authentication method is not supported by the selected protocol.",
                ));
            }
        };
        let mut value = HeaderValue::from_str(&value).map_err(|_| {
            AiError::new(
                "invalid_credential",
                "The API credential contains invalid header characters.",
            )
        })?;
        value.set_sensitive(true);
        headers.insert(name, value);
    }
    Ok(headers)
}

fn request_body(request: &ProviderRequest) -> Result<Value, AiError> {
    if request.model_id.trim().is_empty()
        || request.model_id.len() > 256
        || request.model_id.chars().any(char::is_control)
    {
        return Err(AiError::new("invalid_model", "Enter a valid model ID."));
    }
    let input_bytes = request
        .messages
        .iter()
        .try_fold(request.system.len(), |n, message| {
            if !matches!(message.role.as_str(), "user" | "assistant") {
                return Err(malformed());
            }
            n.checked_add(message.content.len()).ok_or_else(malformed)
        })?;
    if input_bytes > MAX_INPUT_BYTES || request.messages.is_empty() || request.messages.len() > 128
    {
        return Err(AiError::new(
            "input_too_large",
            "The conversation exceeds the input limit. Start a new conversation or reduce its context.",
        ));
    }
    let max_tokens = request.max_output_tokens.clamp(32, 8192);
    let visible: Vec<Value> = request
        .messages
        .iter()
        .map(|m| json!({"role":m.role,"content":m.content}))
        .collect();
    let mut messages = vec![json!({"role":"system","content":request.system})];
    messages.extend(visible.iter().cloned());
    let mut body = match request.profile.protocol {
        Protocol::OllamaNative => {
            json!({"model":request.model_id,"messages":messages,"stream":request.stream,"options":{"num_predict":max_tokens}})
        }
        Protocol::OpenaiChat => {
            let mut body = json!({"model":request.model_id,"messages":messages,"stream":request.stream,"store":false});
            // Official OpenAI models use max_completion_tokens; compatible endpoints
            // commonly retain max_tokens. No failed real request is replayed.
            let official = reqwest::Url::parse(&request.profile.api_base_url)
                .ok()
                .is_some_and(|url| url.host_str() == Some("api.openai.com"));
            let limit_parameter = match request.profile.chat_token_limit_parameter.as_str() {
                "max_tokens" => "max_tokens",
                "max_completion_tokens" => "max_completion_tokens",
                "auto" if official => "max_completion_tokens",
                "auto" => "max_tokens",
                _ => {
                    return Err(AiError::new(
                        "invalid_options",
                        "Choose a supported Chat token-limit parameter.",
                    ));
                }
            };
            body[limit_parameter] = json!(max_tokens);
            if request.stream {
                body["stream_options"] = json!({"include_usage":true});
            }
            body
        }
        Protocol::OpenaiResponses => {
            json!({"model":request.model_id,"instructions":request.system,"input":visible,"max_output_tokens":max_tokens,"stream":request.stream,"store":false})
        }
        Protocol::AnthropicMessages => {
            let blocks: Vec<Value> = request
                .messages
                .iter()
                .map(|m| json!({"role":m.role,"content":[{"type":"text","text":m.content}]}))
                .collect();
            json!({"model":request.model_id,"system":request.system,"messages":blocks,"max_tokens":max_tokens,"stream":request.stream})
        }
    };
    append_turns(&mut body, request)?;
    Ok(body)
}

fn generation_path(protocol: &Protocol) -> &'static str {
    match protocol {
        Protocol::OllamaNative => "api/chat",
        Protocol::OpenaiChat => "chat/completions",
        Protocol::OpenaiResponses => "responses",
        Protocol::AnthropicMessages => "messages",
    }
}

pub fn generation_endpoint(profile: &ConnectionProfile) -> Result<String, AiError> {
    let base = transport::validate_endpoint(&profile.api_base_url, &profile.network_policy)?;
    Ok(transport::endpoint_path(&base, generation_path(&profile.protocol))?.to_string())
}

pub async fn generate(
    request: ProviderRequest,
    cancelled: Arc<AtomicBool>,
    on_delta: DeltaCallback,
) -> Result<ProviderCompletion, AiError> {
    let seconds = request.profile.timeout_seconds.clamp(10, 300);
    transport::cancellable(cancelled, seconds, async move {
        transport::validate_profile(&request.profile)?;
        let body = request_body(&request)?;
        let headers = headers(&request.profile, request.api_key.as_deref())?;
        let transport =
            Transport::new(&request.profile, request.proxy_credentials.as_ref()).await?;
        let url = transport::endpoint_path(
            &transport.base_url,
            generation_path(&request.profile.protocol),
        )?;
        let response = transport
            .client
            .post(url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(transport::network_error)?;
        transport::check_status(&response)?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut decoder = Decoder::new(request.profile.protocol.clone());
        decoder.tools.enabled = !request.tools.is_empty();
        // Some compatible services deliberately answer stream:true with one JSON
        // completion. Parse it directly rather than issuing another generation.
        if !request.stream
            || (content_type.contains("application/json")
                && !matches!(request.profile.protocol, Protocol::OllamaNative))
        {
            let bytes = transport::read_bounded(response, MAX_RESPONSE_BYTES).await?;
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
            decoder.parse_full(&value, &on_delta)?;
        } else {
            decode_stream(response, &mut decoder, &on_delta).await?;
        }
        decoder.finish()
    })
    .await
}

async fn decode_stream(
    mut response: reqwest::Response,
    decoder: &mut Decoder,
    on_delta: &DeltaCallback,
) -> Result<(), AiError> {
    if response
        .content_length()
        .is_some_and(|v| v > MAX_RESPONSE_BYTES as u64)
    {
        return Err(transport::response_too_large());
    }
    let mut framing = Framing::new(matches!(decoder.protocol, Protocol::OllamaNative));
    while let Some(chunk) = response.chunk().await.map_err(transport::network_error)? {
        for event in framing.push(&chunk)? {
            decoder.event(&event, on_delta)?;
            if decoder.completed {
                return Ok(());
            }
        }
        if decoder.completed {
            return Ok(());
        }
    }
    for event in framing.end()? {
        decoder.event(&event, on_delta)?;
    }
    Ok(())
}

#[cfg(test)]
pub async fn list_models(
    profile: ConnectionProfile,
    credential: Option<String>,
    proxy_credentials: Option<ProxyCredential>,
) -> Result<Vec<ModelInfo>, AiError> {
    list_models_cancellable(
        profile,
        credential,
        proxy_credentials,
        Arc::new(AtomicBool::new(false)),
    )
    .await
}

pub async fn list_models_cancellable(
    profile: ConnectionProfile,
    credential: Option<String>,
    proxy_credentials: Option<ProxyCredential>,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ModelInfo>, AiError> {
    transport::cancellable(cancelled, 30, async move {
        transport::validate_profile(&profile)?;
        let headers = headers(&profile, credential.as_deref())?;
        let transport = Transport::new(&profile, proxy_credentials.as_ref()).await?;
        let path = if matches!(profile.protocol, Protocol::OllamaNative) {
            "api/tags"
        } else {
            "models"
        };
        let endpoint = transport::endpoint_path(&transport.base_url, path)?;
        let mut models = Vec::new();
        let mut seen = HashSet::new();
        let mut after: Option<String> = None;
        let mut cursors = HashSet::new();
        let mut bytes_left = MAX_RESPONSE_BYTES;
        for _ in 0..MODEL_PAGE_LIMIT {
            let mut url = endpoint.clone();
            if let Some(cursor) = &after {
                let key = if matches!(profile.protocol, Protocol::AnthropicMessages) {
                    "after_id"
                } else {
                    "after"
                };
                url.query_pairs_mut().append_pair(key, cursor);
            }
            if matches!(profile.protocol, Protocol::AnthropicMessages) {
                url.query_pairs_mut().append_pair("limit", "100");
            }
            let response = transport
                .client
                .get(url)
                .headers(headers.clone())
                .send()
                .await
                .map_err(transport::network_error)?;
            transport::check_status(&response)?;
            let bytes = transport::read_bounded(response, bytes_left).await?;
            bytes_left = bytes_left.saturating_sub(bytes.len());
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
            let entries = body[if matches!(profile.protocol, Protocol::OllamaNative) {
                "models"
            } else {
                "data"
            }]
            .as_array()
            .ok_or_else(malformed)?;
            for entry in entries {
                let id = if matches!(profile.protocol, Protocol::OllamaNative) {
                    entry["model"].as_str().or_else(|| entry["name"].as_str())
                } else {
                    entry["id"].as_str()
                }
                .ok_or_else(malformed)?;
                if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
                    return Err(malformed());
                }
                if seen.insert(id.to_owned()) {
                    let name = entry["display_name"].as_str().unwrap_or(id);
                    if name.len() > 512 || name.chars().any(char::is_control) {
                        return Err(malformed());
                    }
                    models.push(ModelInfo {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        processing_location: if matches!(profile.protocol, Protocol::OllamaNative)
                            && ["remote_host", "remote_model"].iter().any(|field| {
                                entry[*field]
                                    .as_str()
                                    .is_some_and(|value| !value.trim().is_empty())
                            }) {
                            "remote".into()
                        } else {
                            "unknown".into()
                        },
                    });
                }
                if models.len() > MODEL_COUNT_LIMIT {
                    return Err(AiError::new(
                        "model_list_too_large",
                        "The model directory is too large. Enter a model ID manually.",
                    ));
                }
            }
            if !body["has_more"].as_bool().unwrap_or(false) {
                return Ok(models);
            }
            let cursor = body["last_id"]
                .as_str()
                .or_else(|| entries.last().and_then(|e| e["id"].as_str()))
                .ok_or_else(malformed)?;
            if cursor.is_empty() || cursor.len() > 256 || !cursors.insert(cursor.to_owned()) {
                return Err(malformed());
            }
            after = Some(cursor.to_owned());
        }
        Err(AiError::new(
            "model_list_too_large",
            "The model directory exceeded its page limit. Enter a model ID manually.",
        ))
    })
    .await
}

/// Framing works on bytes until a complete line is available, so a split UTF-8
/// codepoint never becomes replacement text. Body, line and event memory are bounded.
struct Framing {
    ndjson: bool,
    buffer: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    bytes: usize,
    scanned: usize,
}
struct WireEvent {
    name: Option<String>,
    data: String,
}

impl Framing {
    fn new(ndjson: bool) -> Self {
        Self {
            ndjson,
            buffer: Vec::new(),
            data: Vec::new(),
            event: None,
            bytes: 0,
            scanned: 0,
        }
    }
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<WireEvent>, AiError> {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(self.bytes) {
            return Err(transport::response_too_large());
        }
        self.bytes += chunk.len();
        self.buffer.extend_from_slice(chunk);
        self.lines(false)
    }
    fn end(&mut self) -> Result<Vec<WireEvent>, AiError> {
        self.lines(true)
    }
    fn lines(&mut self, eof: bool) -> Result<Vec<WireEvent>, AiError> {
        let mut result = Vec::new();
        let mut consumed = 0;
        let mut lines = Vec::new();
        loop {
            let Some(relative) = self.buffer[self.scanned..]
                .iter()
                .position(|b| *b == b'\n' || *b == b'\r')
            else {
                self.scanned = self.buffer.len();
                break;
            };
            let index = self.scanned + relative;
            if self.buffer[index] == b'\r' && index + 1 == self.buffer.len() && !eof {
                self.scanned = index;
                break;
            }
            let length = index
                + if self.buffer[index] == b'\r' && self.buffer.get(index + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
            let line = std::str::from_utf8(&self.buffer[consumed..index])
                .map_err(|_| malformed())?
                .to_owned();
            consumed = length;
            self.scanned = length;
            lines.push(line);
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
            self.scanned -= consumed;
        }
        for line in lines {
            self.line(&line, &mut result)?;
        }
        if eof {
            if !self.buffer.is_empty() {
                let line = std::str::from_utf8(&self.buffer)
                    .map_err(|_| malformed())?
                    .to_owned();
                self.buffer.clear();
                self.scanned = 0;
                self.line(&line, &mut result)?;
            }
            // A complete terminal JSON line is accepted without a final blank line;
            // the protocol decoder still requires its own terminal marker/reason.
            self.dispatch(&mut result);
        }
        Ok(result)
    }
    fn line(&mut self, line: &str, result: &mut Vec<WireEvent>) -> Result<(), AiError> {
        if self.ndjson {
            if !line.trim().is_empty() {
                result.push(WireEvent {
                    name: None,
                    data: line.to_owned(),
                });
            }
        } else if line.is_empty() {
            self.dispatch(result);
        } else if !line.starts_with(':') {
            let (key, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match key {
                "data" => self.data.push(value.to_owned()),
                "event" => self.event = Some(value.to_owned()),
                _ => {}
            }
        }
        Ok(())
    }
    fn dispatch(&mut self, result: &mut Vec<WireEvent>) {
        if !self.data.is_empty() {
            result.push(WireEvent {
                name: self.event.take(),
                data: self.data.join("\n"),
            });
            self.data.clear();
        }
        self.event = None;
    }
}

struct Decoder {
    tools: ToolDecoder,
    protocol: Protocol,
    text: String,
    usage: Option<TokenUsage>,
    reported_model: Option<String>,
    completed: bool,
    stop_reason: Option<String>,
    anthropic_started: bool,
    anthropic_blocks: BTreeMap<u64, (String, bool)>,
    last_response_key: Option<(u64, u64)>,
}

impl Decoder {
    fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            tools: ToolDecoder::new(false),
            text: String::new(),
            usage: None,
            reported_model: None,
            completed: false,
            stop_reason: None,
            anthropic_started: false,
            anthropic_blocks: BTreeMap::new(),
            last_response_key: None,
        }
    }
    fn append(&mut self, value: &str, callback: &DeltaCallback) -> Result<(), AiError> {
        if value.len() > MAX_RESPONSE_BYTES.saturating_sub(self.text.len()) {
            return Err(transport::response_too_large());
        }
        if !value.is_empty() {
            self.text.push_str(value);
            callback(value);
        }
        Ok(())
    }
    fn model(&mut self, value: &Value) -> Result<(), AiError> {
        if let Some(model) = value.as_str() {
            if model.len() > 256 || model.chars().any(char::is_control) {
                return Err(malformed());
            }
            self.reported_model = Some(model.to_owned());
        }
        Ok(())
    }
    fn usage(&mut self, value: &Value, input: &str, output: &str) {
        let input_tokens = value[input].as_u64();
        let output_tokens = value[output].as_u64();
        if input_tokens.is_some() || output_tokens.is_some() {
            let usage = self.usage.get_or_insert(TokenUsage {
                input_tokens: None,
                output_tokens: None,
            });
            if input_tokens.is_some() {
                usage.input_tokens = input_tokens;
            }
            if output_tokens.is_some() {
                usage.output_tokens = output_tokens;
            }
        }
    }
    fn accept_reason(&mut self, reason: &str, allowed: &[&str]) -> Result<(), AiError> {
        if matches!(reason, "tool_calls" | "tool_use") {
            self.tools.require_enabled()?;
            if !self.tools.has_calls()
                || !matches!(
                    (&self.protocol, reason),
                    (Protocol::OpenaiChat, "tool_calls")
                        | (Protocol::AnthropicMessages, "tool_use")
                )
            {
                return Err(malformed());
            }
            self.stop_reason = Some(reason.to_owned());
            return Ok(());
        }
        if matches!(reason, "function_call" | "pause_turn") {
            return Err(interrupted());
        }
        if matches!(reason, "content_filter" | "refusal") {
            return Err(refused());
        }
        if !allowed.contains(&reason) {
            return Err(interrupted());
        }
        if self.tools.has_calls() && self.protocol != Protocol::OllamaNative {
            return Err(interrupted());
        }
        self.stop_reason = Some(reason.to_owned());
        Ok(())
    }
    fn event(&mut self, event: &WireEvent, callback: &DeltaCallback) -> Result<(), AiError> {
        if self.completed {
            return Err(malformed());
        }
        if matches!(self.protocol, Protocol::OpenaiChat) && event.data.trim() == "[DONE]" {
            if !matches!(self.stop_reason.as_deref(), Some("stop" | "tool_calls")) {
                return Err(interrupted());
            }
            self.completed = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&event.data).map_err(|_| malformed())?;
        if value.get("error").is_some_and(|e| !e.is_null()) {
            return Err(AiError::new(
                "provider_error",
                "The model service returned an error while generating. The request was not retried.",
            ));
        }
        if let Some(name) = event.name.as_deref().filter(|v| !v.is_empty())
            && !matches!(self.protocol, Protocol::OpenaiChat)
            && value["type"].as_str() != Some(name)
        {
            return Err(malformed());
        }
        match self.protocol {
            Protocol::OllamaNative => self.ollama(&value, callback),
            Protocol::OpenaiChat => self.chat(&value, true, callback),
            Protocol::OpenaiResponses => self.responses_event(&value, callback),
            Protocol::AnthropicMessages => self.anthropic_event(&value, callback),
        }
    }
    fn parse_full(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        if value.get("error").is_some_and(|e| !e.is_null()) {
            return Err(AiError::new(
                "provider_error",
                "The model service returned an error.",
            ));
        }
        match self.protocol {
            Protocol::OllamaNative => self.ollama(value, callback),
            Protocol::OpenaiChat => self.chat(value, false, callback),
            Protocol::OpenaiResponses => self.responses_full(value, callback),
            Protocol::AnthropicMessages => self.anthropic_full(value, callback),
        }
    }
    fn ollama(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        self.model(&value["model"])?;
        let message = &value["message"];
        self.tools.ollama(message)?;
        if let Some(role) = message["role"].as_str()
            && role != "assistant"
        {
            return Err(malformed());
        }
        if let Some(content) = message["content"].as_str() {
            self.append(content, callback)?;
        }
        // `thinking` is intentionally neither appended nor retained.
        self.usage(value, "prompt_eval_count", "eval_count");
        if value["done"].as_bool() == Some(true) {
            self.accept_reason(
                value["done_reason"].as_str().ok_or_else(interrupted)?,
                &["stop"],
            )?;
            self.completed = true;
        }
        Ok(())
    }
    fn chat(
        &mut self,
        value: &Value,
        stream: bool,
        callback: &DeltaCallback,
    ) -> Result<(), AiError> {
        self.model(&value["model"])?;
        self.usage(&value["usage"], "prompt_tokens", "completion_tokens");
        let choices = value["choices"].as_array().ok_or_else(malformed)?;
        if choices.len() > 1 {
            return Err(malformed());
        }
        if choices.is_empty() {
            return if stream { Ok(()) } else { Err(malformed()) };
        }
        let choice = &choices[0];
        if choice["index"].as_u64().is_some_and(|v| v != 0) {
            return Err(malformed());
        }
        let message = &choice[if stream { "delta" } else { "message" }];
        if self.stop_reason.is_some()
            && message
                .get("tool_calls")
                .is_some_and(|calls| !calls.is_null())
        {
            return Err(malformed());
        }
        self.tools.chat(message, stream)?;
        if message["refusal"].as_str().is_some_and(|v| !v.is_empty()) {
            return Err(refused());
        }
        if let Some(role) = message["role"].as_str()
            && role != "assistant"
        {
            return Err(malformed());
        }
        if let Some(text) = message["content"].as_str() {
            if self.stop_reason.is_some() && !text.is_empty() {
                return Err(malformed());
            }
            self.append(text, callback)?;
        } else if message.get("content").is_some_and(|v| !v.is_null()) {
            return Err(unsupported_content());
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.accept_reason(reason, &["stop"])?;
        }
        if !stream {
            if self.stop_reason.is_none() {
                return Err(interrupted());
            }
            self.completed = true;
        }
        Ok(())
    }
    fn responses_event(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        let kind = value["type"].as_str().ok_or_else(malformed)?;
        match kind {
            "response.created" | "response.in_progress" => self.model(&value["response"]["model"]),
            "response.output_text.delta" => {
                let key = (
                    value["output_index"].as_u64().ok_or_else(malformed)?,
                    value["content_index"].as_u64().ok_or_else(malformed)?,
                );
                if self.last_response_key.is_some_and(|last| key < last) {
                    return Err(malformed());
                }
                self.last_response_key = Some(key);
                self.append(value["delta"].as_str().ok_or_else(malformed)?, callback)
            }
            "response.output_item.added" | "response.output_item.done" => {
                match value["item"]["type"].as_str() {
                    Some("message" | "reasoning") => Ok(()),
                    Some("function_call") => self.tools.require_enabled(),
                    Some(t) if t.contains("call") => Err(unsupported_content()),
                    _ => Err(unsupported_content()),
                }
            }
            "response.content_part.added" | "response.content_part.done" => {
                match value["part"]["type"].as_str() {
                    Some("output_text") => Ok(()),
                    // Compatible Responses services can bracket reasoning text
                    // with content-part events. Discard it just like reasoning
                    // deltas and completed reasoning items; never publish it.
                    Some("reasoning_text") => Ok(()),
                    Some("refusal") => Err(refused()),
                    _ => Err(unsupported_content()),
                }
            }
            "response.refusal.delta" | "response.refusal.done" => Err(refused()),
            "response.completed" => self.responses_full(&value["response"], callback),
            "response.incomplete" => Err(interrupted()),
            "response.failed" | "error" => Err(AiError::new(
                "provider_error",
                "The model service could not complete this response.",
            )),
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                self.tools.require_enabled()
            }
            _ if kind.contains("function_call") || kind.contains("tool_call") => {
                Err(unsupported_content())
            }
            // Lifecycle, annotations and reasoning events carry no visible answer.
            _ => Ok(()),
        }
    }
    fn responses_full(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        if value["status"].as_str() != Some("completed") {
            return Err(interrupted());
        }
        self.model(&value["model"])?;
        self.usage(&value["usage"], "input_tokens", "output_tokens");
        let output = value["output"].as_array().ok_or_else(malformed)?;
        let mut full = String::new();
        let mut call_index = 0;
        for item in output {
            match item["type"].as_str() {
                Some("reasoning") => {}
                Some("message") => {
                    if item["role"].as_str() != Some("assistant") {
                        return Err(malformed());
                    }
                    if item["status"].as_str().is_some_and(|s| s != "completed") {
                        return Err(interrupted());
                    }
                    for part in item["content"].as_array().ok_or_else(malformed)? {
                        match part["type"].as_str() {
                            Some("output_text") => {
                                full.push_str(part["text"].as_str().ok_or_else(malformed)?)
                            }
                            Some("refusal") => return Err(refused()),
                            _ => return Err(unsupported_content()),
                        }
                    }
                }
                Some("function_call") => {
                    if item["status"].as_str().is_some_and(|s| s != "completed") {
                        return Err(interrupted());
                    }
                    self.tools.full_call(
                        call_index,
                        item["call_id"].as_str().ok_or_else(malformed)?,
                        item["name"].as_str().ok_or_else(malformed)?,
                        &item["arguments"],
                    )?;
                    call_index += 1;
                }
                Some(t) if t.contains("call") => return Err(unsupported_content()),
                _ => return Err(unsupported_content()),
            }
        }
        if self.text.is_empty() {
            self.append(&full, callback)?;
        } else if self.text != full {
            return Err(malformed());
        }
        if self.tools.has_calls() {
            self.tools.continuation = output.clone();
        }
        self.completed = true;
        Ok(())
    }
    fn anthropic_event(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        let kind = value["type"].as_str().ok_or_else(malformed)?;
        if kind == "ping" {
            return Ok(());
        }
        if kind == "message_start" {
            if self.anthropic_started {
                return Err(malformed());
            }
            self.anthropic_started = true;
            if value["message"]["role"].as_str() != Some("assistant") {
                return Err(malformed());
            }
            self.model(&value["message"]["model"])?;
            self.usage(&value["message"]["usage"], "input_tokens", "output_tokens");
            return Ok(());
        }
        if !self.anthropic_started {
            return Err(malformed());
        }
        match kind {
            "content_block_start" => {
                let index = value["index"].as_u64().ok_or_else(malformed)?;
                let block = &value["content_block"];
                let block_kind = block["type"].as_str().ok_or_else(malformed)?;
                if index != self.anthropic_blocks.len() as u64
                    || self.anthropic_blocks.values().any(|block| !block.1)
                    || self.stop_reason.is_some()
                {
                    return Err(malformed());
                }
                match block_kind {
                    "text" => {
                        self.append(block["text"].as_str().ok_or_else(malformed)?, callback)?
                    }
                    "thinking" | "redacted_thinking" => {}
                    "tool_use" => self.tools.require_enabled()?,
                    "server_tool_use" => return Err(unsupported_content()),
                    _ => return Err(unsupported_content()),
                }
                self.tools.anthropic_start(index, block)?;
                self.anthropic_blocks
                    .insert(index, (block_kind.to_owned(), false));
                Ok(())
            }
            "content_block_delta" => {
                let index = value["index"].as_u64().ok_or_else(malformed)?;
                let block = self.anthropic_blocks.get(&index).ok_or_else(malformed)?;
                if block.1 {
                    return Err(malformed());
                }
                self.tools.anthropic_delta(index, &value["delta"])?;
                match value["delta"]["type"].as_str() {
                    Some("text_delta") if block.0 == "text" => self.append(
                        value["delta"]["text"].as_str().ok_or_else(malformed)?,
                        callback,
                    ),
                    Some("thinking_delta" | "signature_delta") if block.0 == "thinking" => Ok(()),
                    Some("input_json_delta") if block.0 == "tool_use" => {
                        self.tools.require_enabled()
                    }
                    _ => Err(unsupported_content()),
                }
            }
            "content_block_stop" => {
                let index = value["index"].as_u64().ok_or_else(malformed)?;
                let block = self
                    .anthropic_blocks
                    .get_mut(&index)
                    .ok_or_else(malformed)?;
                if block.1 {
                    return Err(malformed());
                }
                block.1 = true;
                Ok(())
            }
            "message_delta" => {
                if self.anthropic_blocks.values().any(|b| !b.1) {
                    return Err(malformed());
                }
                self.usage(&value["usage"], "input_tokens", "output_tokens");
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.accept_reason(reason, &["end_turn", "stop_sequence"])?;
                }
                Ok(())
            }
            "message_stop" => {
                if self.stop_reason.is_none() || self.anthropic_blocks.values().any(|b| !b.1) {
                    return Err(interrupted());
                }
                self.completed = true;
                Ok(())
            }
            // New metadata-only events are safe to ignore; required content blocks
            // remain strict and cannot accidentally become a complete text answer.
            _ => Ok(()),
        }
    }
    fn anthropic_full(&mut self, value: &Value, callback: &DeltaCallback) -> Result<(), AiError> {
        if value["type"].as_str() != Some("message") || value["role"].as_str() != Some("assistant")
        {
            return Err(malformed());
        }
        self.model(&value["model"])?;
        self.usage(&value["usage"], "input_tokens", "output_tokens");
        for (index, block) in value["content"]
            .as_array()
            .ok_or_else(malformed)?
            .iter()
            .enumerate()
        {
            match block["type"].as_str() {
                Some("text") => {
                    self.append(block["text"].as_str().ok_or_else(malformed)?, callback)?
                }
                Some("thinking" | "redacted_thinking") => {}
                Some("tool_use") => self.tools.require_enabled()?,
                Some("server_tool_use") => return Err(unsupported_content()),
                _ => return Err(unsupported_content()),
            }
            self.tools.anthropic_start(index as u64, block)?;
        }
        self.accept_reason(
            value["stop_reason"].as_str().ok_or_else(interrupted)?,
            &["end_turn", "stop_sequence"],
        )?;
        self.completed = true;
        Ok(())
    }
    fn finish(self) -> Result<ProviderCompletion, AiError> {
        if !self.completed {
            return Err(interrupted());
        }
        let (tool_calls, continuation) = self.tools.finish(&self.protocol, &self.text)?;
        if self.text.trim().is_empty() && tool_calls.is_empty() {
            return Err(AiError::new(
                "empty_response",
                "The model completed without a visible text answer.",
            ));
        }
        Ok(ProviderCompletion {
            tool_calls,
            continuation,
            text: self.text,
            usage: self.usage,
            reported_model: self.reported_model,
        })
    }
}

#[cfg(test)]
#[path = "providers_tests.rs"]
mod tests;
