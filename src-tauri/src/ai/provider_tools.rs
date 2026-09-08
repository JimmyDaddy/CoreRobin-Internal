//! Bounded protocol continuation. No data from this module is persisted or shown.
use super::types::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MAX_CALLS: usize = 8;
const MAX_ARGUMENTS: usize = 4096;
const MAX_CONTINUATION: usize = 256 * 1024;

fn invalid() -> AiError {
    AiError::new(
        "invalid_tool_call",
        "The model returned an incomplete or invalid tool call. No action was executed.",
    )
}
pub(super) fn tool_unavailable() -> AiError {
    AiError::new(
        "unsupported_tool",
        "This request does not allow device tools. Enable device context to run checks.",
    )
}

pub(super) fn append_turns(body: &mut Value, request: &ProviderRequest) -> Result<(), AiError> {
    if request.tools.is_empty() && !request.tool_turns.is_empty() {
        return Err(tool_unavailable());
    }
    if !request.tools.is_empty() {
        let definitions: Vec<Value> = request.tools.iter().map(|tool| match request.profile.protocol {
            Protocol::OpenaiResponses => json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":false}),
            Protocol::AnthropicMessages => json!({"name":tool.name,"description":tool.description,"input_schema":tool.parameters}),
            _ => json!({"type":"function","function":{"name":tool.name,"description":tool.description,"parameters":tool.parameters}}),
        }).collect();
        body["tools"] = json!(definitions);
        if request.profile.protocol == Protocol::OpenaiResponses {
            // Required for stateless reasoning-model tool continuation with store:false.
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
    }
    let field = if request.profile.protocol == Protocol::OpenaiResponses {
        "input"
    } else {
        "messages"
    };
    let messages = body[field].as_array_mut().ok_or_else(invalid)?;
    for turn in &request.tool_turns {
        messages.extend(turn.assistant.iter().cloned());
        if request.profile.protocol == Protocol::AnthropicMessages {
            let results: Vec<_> = turn.results.iter().map(|result| json!({"type":"tool_result","tool_use_id":result.call.id,"content":result.output,"is_error":result.is_error})).collect();
            messages.push(json!({"role":"user","content":results}));
        } else {
            for result in &turn.results {
                messages.push(match request.profile.protocol {
                    Protocol::OpenaiResponses => json!({"type":"function_call_output","call_id":result.call.id,"output":result.output}),
                    Protocol::OllamaNative => json!({"role":"tool","tool_name":result.call.name,"content":result.output}),
                    _ => json!({"role":"tool","tool_call_id":result.call.id,"content":result.output}),
                });
            }
        }
    }
    if serde_json::to_vec(body).map_err(|_| invalid())?.len() > 384 * 1024 {
        return Err(AiError::new(
            "input_too_large",
            "The task reached its context limit. Start a new task with a narrower scope.",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}
pub(super) struct ToolDecoder {
    pub enabled: bool,
    calls: BTreeMap<u64, PendingCall>,
    pub continuation: Vec<Value>,
    reasoning: String,
    pub anthropic_content: BTreeMap<u64, Value>,
}
impl ToolDecoder {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            calls: BTreeMap::new(),
            continuation: Vec::new(),
            reasoning: String::new(),
            anthropic_content: BTreeMap::new(),
        }
    }
    pub fn has_calls(&self) -> bool {
        !self.calls.is_empty()
    }
    pub fn require_enabled(&self) -> Result<(), AiError> {
        if self.enabled {
            Ok(())
        } else {
            Err(tool_unavailable())
        }
    }
    fn pending(&mut self, index: u64) -> Result<&mut PendingCall, AiError> {
        self.require_enabled()?;
        if index >= MAX_CALLS as u64 {
            return Err(invalid());
        }
        Ok(self.calls.entry(index).or_default())
    }
    pub fn reasoning(&mut self, text: &str) -> Result<(), AiError> {
        if self.enabled {
            if self.reasoning.len().saturating_add(text.len()) > MAX_CONTINUATION {
                return Err(invalid());
            }
            self.reasoning.push_str(text);
        }
        Ok(())
    }
    pub fn chat(&mut self, message: &Value, stream: bool) -> Result<(), AiError> {
        if message.get("function_call").is_some_and(|v| !v.is_null())
            || message
                .get("tool_calls")
                .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|calls| !calls.is_empty()))
        {
            self.require_enabled()?;
        }
        if message.get("function_call").is_some_and(|v| !v.is_null()) {
            return Err(invalid());
        }
        if let Some(reasoning) = message["reasoning_content"].as_str() {
            self.reasoning(reasoning)?;
        }
        let Some(calls) = message.get("tool_calls").filter(|v| !v.is_null()) else {
            return Ok(());
        };
        for (offset, call) in calls.as_array().ok_or_else(invalid)?.iter().enumerate() {
            if call["type"].as_str().is_some_and(|kind| kind != "function") {
                return Err(invalid());
            }
            let index = if stream {
                call["index"].as_u64().ok_or_else(invalid)?
            } else {
                offset as u64
            };
            let pending = self.pending(index)?;
            if let Some(id) = call["id"].as_str() {
                if !pending.id.is_empty() && pending.id != id {
                    return Err(invalid());
                }
                pending.id = id.into();
            }
            if let Some(name) = call["function"]["name"].as_str() {
                pending.name.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                pending.arguments.push_str(arguments);
            }
            if pending.id.len() > 256
                || pending.name.len() > 64
                || pending.arguments.len() > MAX_ARGUMENTS
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub fn ollama(&mut self, message: &Value) -> Result<(), AiError> {
        if let Some(thinking) = message["thinking"].as_str() {
            self.reasoning(thinking)?;
        }
        if let Some(calls) = message.get("tool_calls").filter(|v| !v.is_null()) {
            if calls.as_array().is_none_or(|calls| !calls.is_empty()) {
                self.require_enabled()?;
            }
            for call in calls.as_array().ok_or_else(invalid)? {
                let index = self.calls.len() as u64;
                let id = format!("ollama_call_{index}");
                self.full_call(
                    index,
                    &id,
                    call["function"]["name"].as_str().ok_or_else(invalid)?,
                    &call["function"]["arguments"],
                )?;
            }
        }
        Ok(())
    }
    pub fn full_call(
        &mut self,
        index: u64,
        id: &str,
        name: &str,
        args: &Value,
    ) -> Result<(), AiError> {
        let arguments = if let Some(text) = args.as_str() {
            text.to_owned()
        } else {
            serde_json::to_string(args).map_err(|_| invalid())?
        };
        if self.calls.contains_key(&index) {
            return Err(invalid());
        }
        *self.pending(index)? = PendingCall {
            id: id.into(),
            name: name.into(),
            arguments,
        };
        self.validated_calls()?;
        Ok(())
    }
    pub fn anthropic_start(&mut self, index: u64, block: &Value) -> Result<(), AiError> {
        if !self.enabled {
            return Ok(());
        }
        self.anthropic_content.insert(index, block.clone());
        if block["type"] == "tool_use" {
            let pending = self.pending(index)?;
            pending.id = block["id"].as_str().ok_or_else(invalid)?.into();
            pending.name = block["name"].as_str().ok_or_else(invalid)?.into();
        }
        self.check_size()
    }
    pub fn anthropic_delta(&mut self, index: u64, delta: &Value) -> Result<(), AiError> {
        if !self.enabled {
            return Ok(());
        }
        let kind = delta["type"].as_str().ok_or_else(invalid)?;
        if kind == "input_json_delta" {
            let pending = self.calls.get_mut(&index).ok_or_else(invalid)?;
            pending
                .arguments
                .push_str(delta["partial_json"].as_str().ok_or_else(invalid)?);
            if pending.arguments.len() > MAX_ARGUMENTS {
                return Err(invalid());
            }
        } else {
            let field = match kind {
                "text_delta" => "text",
                "thinking_delta" => "thinking",
                "signature_delta" => "signature",
                _ => return Err(invalid()),
            };
            let block = self.anthropic_content.get_mut(&index).ok_or_else(invalid)?;
            let value = format!(
                "{}{}",
                block[field].as_str().unwrap_or(""),
                delta[field].as_str().ok_or_else(invalid)?
            );
            block[field] = json!(value);
        }
        self.check_size()
    }
    fn check_size(&self) -> Result<(), AiError> {
        if serde_json::to_vec(&self.anthropic_content)
            .map_err(|_| invalid())?
            .len()
            > MAX_CONTINUATION
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn validated_calls(&self) -> Result<Vec<ToolCall>, AiError> {
        let mut ids = std::collections::HashSet::new();
        self.calls
            .values()
            .map(|pending| {
                if pending.id.is_empty()
                    || pending.id.len() > 256
                    || pending.id.chars().any(char::is_control)
                    || pending.name.is_empty()
                    || pending.name.len() > 64
                    || !pending
                        .name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    || pending.arguments.len() > MAX_ARGUMENTS
                    || !ids.insert(&pending.id)
                {
                    return Err(invalid());
                }
                let arguments: Value =
                    serde_json::from_str(&pending.arguments).map_err(|_| invalid())?;
                if !arguments.is_object() {
                    return Err(invalid());
                }
                Ok(ToolCall {
                    id: pending.id.clone(),
                    name: pending.name.clone(),
                    arguments,
                })
            })
            .collect()
    }
    pub fn finish(
        mut self,
        protocol: &Protocol,
        text: &str,
    ) -> Result<(Vec<ToolCall>, Vec<Value>), AiError> {
        // Anthropic streams empty input objects as no deltas or as '{}'.
        for (index, pending) in &mut self.calls {
            if *protocol == Protocol::AnthropicMessages && pending.arguments.is_empty() {
                pending.arguments = serde_json::to_string(&self.anthropic_content[index]["input"])
                    .map_err(|_| invalid())?;
            }
        }
        let calls = self.validated_calls()?;
        if calls.is_empty() {
            return Ok((calls, Vec::new()));
        }
        let continuation = match protocol {
            Protocol::OpenaiResponses => self.continuation,
            Protocol::AnthropicMessages => {
                let mut content: Vec<_> = self.anthropic_content.into_values().collect();
                for block in &mut content {
                    if block["type"] == "tool_use" {
                        let call = calls
                            .iter()
                            .find(|call| block["id"] == call.id)
                            .ok_or_else(invalid)?;
                        block["input"] = call.arguments.clone();
                    }
                }
                vec![json!({"role":"assistant","content":content})]
            }
            Protocol::OllamaNative => {
                let wire: Vec<_> = calls
                    .iter()
                    .map(|call| json!({"function":{"name":call.name,"arguments":call.arguments}}))
                    .collect();
                let mut message = json!({"role":"assistant","content":text,"tool_calls":wire});
                if !self.reasoning.is_empty() {
                    message["thinking"] = json!(self.reasoning);
                }
                vec![message]
            }
            Protocol::OpenaiChat => {
                let wire: Vec<_> = calls.iter().map(|call| json!({"type":"function","id":call.id,"function":{"name":call.name,"arguments":call.arguments.to_string()}})).collect();
                let mut message = json!({"role":"assistant","content":text,"tool_calls":wire});
                if !self.reasoning.is_empty() {
                    message["reasoning_content"] = json!(self.reasoning);
                }
                vec![message]
            }
        };
        if serde_json::to_vec(&continuation)
            .map_err(|_| invalid())?
            .len()
            > MAX_CONTINUATION
        {
            return Err(invalid());
        }
        Ok((calls, continuation))
    }
}
