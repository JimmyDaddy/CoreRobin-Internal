//! The small, explicit tool surface available to Robin. No shell or arbitrary IO.
use super::{service::AiService, types::*};
use crate::models::{CleanupDeleteLeaseRequest, ProcessKey};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub const MAX_TOOL_CALLS: usize = 8;
pub const MAX_TOOL_ROUNDS: usize = 6;
pub const MAX_TOOL_RESULT_BYTES: usize = 8192;
pub type ToolFuture = Pin<Box<dyn Future<Output = Result<Value, AiError>> + Send>>;
pub type ToolExecutor = Arc<dyn Fn(ToolCall, ToolContext) -> ToolFuture + Send + Sync>;

#[derive(Clone)]
pub struct ToolScope {
    pub include_context: bool,
    pub scenario: String,
    pub incident_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}
#[derive(Clone)]
pub enum NativeTarget {
    Process { key: ProcessKey, name: String },
    Cleanup(Box<CleanupDeleteLeaseRequest>),
}
#[derive(Clone)]
pub struct ToolContext {
    pub service: Arc<AiService>,
    pub request_id: String,
    pub step_id: String,
    pub scope: ToolScope,
    pub cancelled: Arc<AtomicBool>,
    pub targets: Arc<Mutex<HashMap<String, NativeTarget>>>,
}
impl ToolContext {
    pub fn check_active(&self) -> Result<(), AiError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        self.service.check_tool_active(&self.request_id)
    }
    pub async fn confirm(&self, confirmation: ToolConfirmation) -> Result<(), AiError> {
        self.service
            .confirm_tool(
                &self.request_id,
                &self.step_id,
                confirmation,
                self.cancelled.clone(),
            )
            .await
    }
}
pub fn cancelled() -> AiError {
    AiError::new(
        "cancelled",
        "The task was stopped. No further steps will run.",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessSort {
    Cpu,
    Memory,
}
fn default_sort() -> ProcessSort {
    ProcessSort::Cpu
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessArgs {
    #[serde(default = "default_sort")]
    pub sort_by: ProcessSort,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessActionArgs {
    pub target_ref: String,
    pub action: crate::models::ProcessAction,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupArgs {
    pub target_ref: String,
}
pub enum ToolOperation {
    Device,
    Processes(ProcessArgs),
    History,
    Network,
    Disk,
    ProcessAction(ProcessActionArgs),
    Cleanup(CleanupArgs),
    OpenCapability(crate::application_capability_catalog::OpenCapabilityArgs),
    QuickCleanupAnalysis,
    LocalUtility(crate::local_utility_bridge::UtilityArgs),
}
pub fn parse(call: &ToolCall) -> Result<ToolOperation, AiError> {
    fn args<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, AiError> {
        serde_json::from_value(value.clone()).map_err(|_| AiError::new("invalid_tool_arguments", "Use the documented tool arguments; extra fields, paths and process IDs are not accepted."))
    }
    Ok(match call.name.as_str() {
        "get_device_status" => {
            let _: EmptyArgs = args(&call.arguments)?;
            ToolOperation::Device
        }
        "get_process_usage" => ToolOperation::Processes(args(&call.arguments)?),
        "get_recorded_history" => {
            let _: EmptyArgs = args(&call.arguments)?;
            ToolOperation::History
        }
        "run_network_check" => {
            let _: EmptyArgs = args(&call.arguments)?;
            ToolOperation::Network
        }
        "scan_disk_usage" => {
            let _: EmptyArgs = args(&call.arguments)?;
            ToolOperation::Disk
        }
        "request_process_action" => ToolOperation::ProcessAction(args(&call.arguments)?),
        "request_cleanup" => ToolOperation::Cleanup(args(&call.arguments)?),
        "run_local_utility" => ToolOperation::LocalUtility(args(&call.arguments)?),
        "open_application_capability" => ToolOperation::OpenCapability(args(&call.arguments)?),
        "analyze_quick_cleanup" => {
            let _: EmptyArgs = args(&call.arguments)?;
            ToolOperation::QuickCleanupAnalysis
        }
        _ => {
            return Err(AiError::new(
                "unknown_tool",
                "This tool is not available. Use one of the provided CoreRobin tools.",
            ));
        }
    })
}
pub fn definitions() -> Vec<ToolDefinition> {
    let empty = json!({"type":"object","properties":{},"required":[],"additionalProperties":false});
    [
        ("get_device_status", "Inspect current CPU, memory, storage, temperature and the existing CoreRobin diagnosis. Start here when asked to check the computer. Values are observations, not universal healthy thresholds.", empty.clone()),
        ("get_process_usage", "Inspect the top 10 processes by CPU or memory. Returns names, usage and native target_ref values for eligible processes. Does not read files or command lines.", json!({"type":"object","properties":{"sort_by":{"type":"string","enum":["cpu","memory"]}},"additionalProperties":false})),
        ("get_recorded_history", "Inspect existing saved resource and network history in the user's selected time range. Does not enable recording or invent missing samples.", empty.clone()),
        ("run_network_check", "Run CoreRobin's actual bounded DNS, route and TCP connectivity checks. Makes probes to built-in public endpoints; does not change network settings. Use when asked to check a network problem.", empty.clone()),
        ("scan_disk_usage", "Scan common user locations for disk usage with CoreRobin's scanner. Can take time. Reports sizes and native target_ref values; never reads file contents or deletes files. Use only when storage inspection is relevant to the task.", empty.clone()),
        ("analyze_quick_cleanup", "Analyze CoreRobin's fixed user-cache, logs, temporary-files and Trash categories. No files are deleted. The result updates Quick Cleanup and provides a shared local form for the user to select categories and explicitly confirm cleanup.", empty),
        ("run_local_utility", "Compute using CoreRobin's existing fixed text utilities. Only the text supplied in this tool call is read; never reads files, clipboard, secrets or the user's existing toolbox input. Input is limited to 4096 UTF-8 bytes. Output may be abbreviated in conversation; the full result is offered to the original toolbox. Choose open_application_capability for larger text, files, images and private local input.", json!({"type":"object","properties":{"operation":{"type":"string","enum":["json_format","json_compact","url_encode","url_decode","url_inspect","base64_encode","base64_decode","base64url_encode","base64url_decode","time_seconds","time_milliseconds","uuid_v4","text_sha256","regex","color"]},"input":{"type":"string","maxLength":4096},"pattern":{"type":"string","maxLength":256},"flags":{"type":"string","maxLength":8},"replacement":{"type":"string","maxLength":1024},"count":{"type":"integer","minimum":1,"maximum":100},"indent":{"type":"integer","enum":[2,4]}},"required":["operation","input"],"additionalProperties":false})),
        ("open_application_capability", "Offer an existing CoreRobin operation as an interactive card: device health, GPU, network connections, volumes, quick cleanup, duplicate files, application management, startup items, history, export, diagnosis, privacy controls, system tools, text utilities, images or binary patches. The user operates the same form used by the application. This only opens a form; never claim that an operation ran or inputs were processed. User file selections, file contents and secrets stay local. System changes, keyboard cleaning, schedules and all file operations require explicit local user input.", json!({"type":"object","properties":{"capability_id":{"type":"string","enum":crate::application_capability_catalog::form_ids()}},"required":["capability_id"],"additionalProperties":false})),
        ("request_process_action", "Ask the user to confirm closing or force-stopping a specific process returned by get_process_usage in this task. Native UI shows the exact target and unsaved-work risk. Never claim success before the result. Do not request again after rejection.", json!({"type":"object","properties":{"target_ref":{"type":"string"},"action":{"type":"string","enum":["request_close","force_kill"]}},"required":["target_ref","action"],"additionalProperties":false})),
        ("request_cleanup", "Ask the user to confirm moving one exact item returned by scan_disk_usage to the system trash. Never permanently deletes. Native UI validates and shows the actual target; never claim reclaimed space before the result. Do not request again after rejection.", json!({"type":"object","properties":{"target_ref":{"type":"string"}},"required":["target_ref"],"additionalProperties":false})),
    ].into_iter().map(|(name,description,parameters)|ToolDefinition{name:name.into(),description:description.into(),parameters}).collect()
}
pub fn categories(name: &str) -> &'static [&'static str] {
    match name {
        "get_device_status" => &["resources", "incidents"],
        "get_process_usage" | "request_process_action" => &["applications", "resources"],
        "run_network_check" => &["network_quality"],
        "get_recorded_history" => &["resources", "network_quality", "incidents"],
        "scan_disk_usage" | "request_cleanup" => &["applications"],
        "analyze_quick_cleanup" => &["applications", "incidents"],
        _ => &[],
    }
}

// Keep the first model turn focused on inspection. Native target validation
// remains authoritative even if a provider invents an unadvertised tool call.
pub fn definitions_for_targets(targets: &HashMap<String, NativeTarget>) -> Vec<ToolDefinition> {
    let processes = targets
        .values()
        .any(|target| matches!(target, NativeTarget::Process { .. }));
    let cleanup = targets
        .values()
        .any(|target| matches!(target, NativeTarget::Cleanup(_)));
    definitions()
        .into_iter()
        .filter(|tool| match tool.name.as_str() {
            "request_process_action" => processes,
            "request_cleanup" => cleanup,
            _ => true,
        })
        .collect()
}
