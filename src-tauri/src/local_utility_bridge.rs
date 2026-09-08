//! Finite pure computations executed by the trusted main WebView's existing
//! toolbox functions. No script, file path, clipboard read, or stored input API.
use crate::ai::{AiError, tools::ToolContext};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;

const EVENT: &str = "core-robin:local-utility-request";
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UtilityOperation {
    JsonFormat,
    JsonCompact,
    UrlEncode,
    UrlDecode,
    UrlInspect,
    Base64Encode,
    Base64Decode,
    Base64urlEncode,
    Base64urlDecode,
    TimeSeconds,
    TimeMilliseconds,
    UuidV4,
    TextSha256,
    Regex,
    Color,
}
impl UtilityOperation {
    pub fn tool_id(self) -> &'static str {
        match self {
            Self::JsonFormat | Self::JsonCompact => "json",
            Self::UrlEncode | Self::UrlDecode | Self::UrlInspect => "url",
            Self::Base64Encode
            | Self::Base64Decode
            | Self::Base64urlEncode
            | Self::Base64urlDecode => "base64",
            Self::TimeSeconds | Self::TimeMilliseconds => "time",
            Self::UuidV4 => "uuid",
            Self::TextSha256 => "text-sha256",
            Self::Regex => "regex",
            Self::Color => "color",
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UtilityArgs {
    pub operation: UtilityOperation,
    pub input: String,
    pub pattern: Option<String>,
    pub flags: Option<String>,
    pub replacement: Option<String>,
    pub count: Option<u16>,
    pub indent: Option<u8>,
}
impl UtilityArgs {
    fn validate(&self) -> Result<(), AiError> {
        if self.input.len() > 4096
            || self.pattern.as_ref().is_some_and(|value| value.len() > 256)
            || self.flags.as_ref().is_some_and(|value| value.len() > 8)
            || self
                .replacement
                .as_ref()
                .is_some_and(|value| value.len() > 1024)
            || self.count.is_some_and(|value| !(1..=100).contains(&value))
            || self.indent.is_some_and(|value| value != 2 && value != 4)
            || (!matches!(self.operation, UtilityOperation::Regex)
                && (self.pattern.is_some() || self.flags.is_some() || self.replacement.is_some()))
            || (!matches!(self.operation, UtilityOperation::UuidV4) && self.count.is_some())
            || (!matches!(
                self.operation,
                UtilityOperation::JsonFormat | UtilityOperation::JsonCompact
            ) && self.indent.is_some())
        {
            return Err(invalid());
        }
        if matches!(self.operation, UtilityOperation::Regex) && self.pattern.is_none() {
            return Err(invalid());
        }
        Ok(())
    }
}
fn invalid() -> AiError {
    AiError::new(
        "invalid_tool_arguments",
        "Use the finite operation and its documented bounded text arguments.",
    )
}
fn expired() -> AiError {
    AiError::new(
        "capability_target_expired",
        "The local computation request expired or was already consumed.",
    )
}
fn require_main(window: &WebviewWindow) -> Result<(), AiError> {
    if window.label() != "main" {
        return Err(AiError::new(
            "surface_denied",
            "Only the main window executes local utilities.",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UtilityReply {
    pub output: Option<String>,
    pub truncated: bool,
    pub error_code: Option<String>,
}
struct Pending {
    arguments: UtilityArgs,
    check_active: Arc<dyn Fn() -> Result<(), AiError> + Send + Sync>,
    claimed: bool,
    reply: oneshot::Sender<Result<Value, AiError>>,
}
#[derive(Default)]
pub struct UtilityBroker {
    pending: Mutex<HashMap<String, Pending>>,
}
impl UtilityBroker {
    fn claim(&self, nonce: &str) -> Result<UtilityArgs, AiError> {
        let mut pending = self.pending.lock().map_err(AiError::storage)?;
        let task = pending.get_mut(nonce).ok_or_else(expired)?;
        (task.check_active)()?;
        if task.claimed {
            return Err(expired());
        }
        task.claimed = true;
        Ok(task.arguments.clone())
    }
    fn complete(&self, nonce: &str, reply: UtilityReply) -> Result<(), AiError> {
        let mut pending = self.pending.lock().map_err(AiError::storage)?;
        let task = pending.get(nonce).ok_or_else(expired)?;
        (task.check_active)()?;
        if !task.claimed {
            return Err(expired());
        }
        if reply
            .output
            .as_ref()
            .is_some_and(|value| value.len() > 6144)
            || reply.error_code.as_ref().is_some_and(|value| {
                value.len() > 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            })
            || (reply.error_code.is_some() == reply.output.is_some())
        {
            return Err(invalid());
        }
        let result = if let Some(code) = reply.error_code {
            Err(AiError::new(
                code,
                "The fixed local utility did not complete. Correct the input or open its form to retry.",
            ))
        } else {
            let receipt = json!({"kind":"application_capability", "capabilityId":format!("toolbox.{}", task.arguments.operation.tool_id()), "surface":"main_window", "requiresUserInput":false, "operationExecuted":true,
                "utilityOutput":reply.output.unwrap_or_default(), "outputTruncated":reply.truncated,
                "note":"Computed using CoreRobin's existing fixed local utility, only on the supplied text. The full result is offered to the shared toolbox state unless the user cleared data or edited its inputs meanwhile. This is not a file operation."});
            if receipt.to_string().len() > crate::ai::tools::MAX_TOOL_RESULT_BYTES {
                return Err(invalid());
            }
            Ok(receipt)
        };
        let task = pending.remove(nonce).ok_or_else(expired)?;
        task.reply.send(result).map_err(|_| expired())
    }
}
struct PendingGuard {
    broker: Arc<UtilityBroker>,
    nonce: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.broker.pending.lock() {
            pending.remove(&self.nonce);
        }
    }
}

pub async fn execute(
    app: &AppHandle,
    arguments: UtilityArgs,
    context: &ToolContext,
) -> Result<Value, AiError> {
    arguments.validate()?;
    context.check_active()?;
    let broker = app.state::<Arc<UtilityBroker>>().inner().clone();
    let nonce = crate::ai::service::new_id()?;
    let (sender, mut receiver) = oneshot::channel();
    let active_context = context.clone();
    {
        let mut pending = broker.pending.lock().map_err(AiError::storage)?;
        if pending.len() >= 8 {
            return Err(AiError::new(
                "task_limit",
                "Too many local computations are pending.",
            ));
        }
        pending.insert(
            nonce.clone(),
            Pending {
                arguments,
                check_active: Arc::new(move || active_context.check_active()),
                claimed: false,
                reply: sender,
            },
        );
    }
    let _guard = PendingGuard {
        broker,
        nonce: nonce.clone(),
    };
    app.emit_to("main", EVENT, &nonce).map_err(|_| {
        AiError::new(
            "tool_unavailable",
            "Open the main window to use local computations.",
        )
    })?;
    let deadline = tokio::time::sleep(Duration::from_secs(12));
    tokio::pin!(deadline);
    let mut check = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            response = &mut receiver => { context.check_active()?; return response.map_err(|_| expired())?; }
            _ = &mut deadline => return Err(AiError::new("tool_unavailable", "The main window did not finish this computation. Open the utility form to retry.")),
            _ = check.tick() => context.check_active()?,
        }
    }
}
#[tauri::command]
pub fn ai_pending_utility_requests(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<String>, AiError> {
    require_main(&window)?;
    Ok(app
        .state::<Arc<UtilityBroker>>()
        .pending
        .lock()
        .map_err(AiError::storage)?
        .iter()
        .filter(|(_, task)| !task.claimed && (task.check_active)().is_ok())
        .map(|(nonce, _)| nonce.clone())
        .collect())
}
#[tauri::command]
pub async fn ai_claim_utility_request(
    app: AppHandle,
    window: WebviewWindow,
    nonce: String,
) -> Result<UtilityArgs, AiError> {
    require_main(&window)?;
    let runtime = app.state::<crate::ai_commands::AiRuntime>();
    let _gate = runtime.context_gate.read().await;
    runtime.require_source_ready()?;
    app.state::<Arc<UtilityBroker>>().claim(&nonce)
}
#[tauri::command]
pub async fn ai_complete_utility_request(
    app: AppHandle,
    window: WebviewWindow,
    nonce: String,
    reply: UtilityReply,
) -> Result<(), AiError> {
    require_main(&window)?;
    let runtime = app.state::<crate::ai_commands::AiRuntime>();
    let _gate = runtime.context_gate.read().await;
    runtime.require_source_ready()?;
    app.state::<Arc<UtilityBroker>>().complete(&nonce, reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn args() -> UtilityArgs {
        serde_json::from_value(json!({"operation":"json_format","input":"{}"})).unwrap()
    }
    #[test]
    fn arguments_are_bounded_and_cannot_name_executors_or_files() {
        assert!(
            serde_json::from_value::<UtilityArgs>(json!({"operation":"shell","input":"x"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<UtilityArgs>(
                json!({"operation":"json_format","input":"{}","path":"/tmp/file"})
            )
            .is_err()
        );
        let mut value = args();
        value.input = "界".repeat(2000);
        assert!(value.validate().is_err());
        let mut value = args();
        value.count = Some(2);
        assert!(value.validate().is_err());
        assert!(args().validate().is_ok());
    }
    #[test]
    fn only_claimed_live_requests_can_complete_once() {
        let broker = UtilityBroker::default();
        let active = Arc::new(AtomicBool::new(true));
        let current = active.clone();
        let (reply, mut received) = oneshot::channel();
        broker.pending.lock().unwrap().insert(
            "native-nonce".into(),
            Pending {
                arguments: args(),
                check_active: Arc::new(move || {
                    if current.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(expired())
                    }
                }),
                claimed: false,
                reply,
            },
        );
        let response = || UtilityReply {
            output: Some("{}".into()),
            error_code: None,
            truncated: false,
        };
        assert!(broker.complete("native-nonce", response()).is_err());
        assert!(broker.claim("invented").is_err());
        broker.claim("native-nonce").unwrap();
        assert!(broker.claim("native-nonce").is_err());
        active.store(false, Ordering::Release);
        assert!(broker.complete("native-nonce", response()).is_err());
        assert!(received.try_recv().is_err());
        active.store(true, Ordering::Release);
        broker.complete("native-nonce", response()).unwrap();
        assert_eq!(
            received.try_recv().unwrap().unwrap()["operationExecuted"],
            true
        );
        assert!(broker.complete("native-nonce", response()).is_err());
    }
}
