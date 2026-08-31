//! Toolbox file commands are main-window-only. IO occurs outside the service
//! mutex and selection is native; the WebView never supplies a read path.
use crate::toolbox_inputs::{FILE_CHUNK_BYTES, FileJobKey, InputRole, InputToken};
use crate::{AppState, error::CommandError, require_main_window};
use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn get_toolbox_network_snapshot(
    window: WebviewWindow,
) -> Result<crate::toolbox_network::ToolboxNetworkSnapshot, CommandError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(crate::toolbox_network::collect_network_snapshot)
        .await
        .map_err(|_| unavailable())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareInputsRequest {
    pub job: FileJobKey,
    pub role: InputRole,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadInputRequest {
    pub job: FileJobKey,
    pub token: String,
    pub offset: u64,
    pub length: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseInputsRequest {
    pub job: FileJobKey,
    pub tokens: Vec<String>,
}

#[tauri::command]
pub async fn prepare_toolbox_inputs(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    request: PrepareInputsRequest,
) -> Result<Vec<InputToken>, CommandError> {
    require_main_window(&window)?;
    let inputs = state
        .toolbox
        .lock()
        .map_err(|_| unavailable())?
        .inputs_for_job(&request.job)?;
    tauri::async_runtime::spawn_blocking(move || {
        inputs.select(&request.job, request.role, || {
            let Some(selected) = app.dialog().file().blocking_pick_files() else {
                return Ok(Vec::new());
            };
            selected
                .into_iter()
                .map(|path| {
                    path.into_path().map_err(|_| {
                        CommandError::new("invalid_file", "Only local files can be selected.")
                    })
                })
                .collect()
        })
    })
    .await
    .map_err(|_| unavailable())?
}

#[tauri::command]
pub async fn read_toolbox_input(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ReadInputRequest,
) -> Result<tauri::ipc::Response, CommandError> {
    require_main_window(&window)?;
    if request.length == 0 || request.length > FILE_CHUNK_BYTES {
        return Err(CommandError::new(
            "invalid_range",
            "File reads are limited to 1 MiB.",
        ));
    }
    let inputs = state
        .toolbox
        .lock()
        .map_err(|_| unavailable())?
        .inputs_for_job(&request.job)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        inputs.read(&request.job, &request.token, request.offset, request.length)
    })
    .await
    .map_err(|_| unavailable())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn release_toolbox_inputs(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ReleaseInputsRequest,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    if request.tokens.len() > 32 {
        return Err(CommandError::new(
            "invalid_request",
            "Too many input tokens.",
        ));
    }
    let inputs = state
        .toolbox
        .lock()
        .map_err(|_| unavailable())?
        .inputs_for_job(&request.job)?;
    inputs.release(&request.job, &request.tokens)
}

#[tauri::command]
pub async fn revalidate_toolbox_inputs(
    window: WebviewWindow,
    state: State<'_, AppState>,
    job: FileJobKey,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    let inputs = state
        .toolbox
        .lock()
        .map_err(|_| unavailable())?
        .inputs_for_job(&job)?;
    tauri::async_runtime::spawn_blocking(move || inputs.revalidate_all(&job))
        .await
        .map_err(|_| unavailable())?
}

fn unavailable() -> CommandError {
    CommandError::internal("The toolbox file service is unavailable.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_selection_request_never_accepts_a_webview_supplied_path() {
        let request = serde_json::json!({
            "job": { "jobId": "job", "generation": 1, "resetEpoch": 0 },
            "role": "input", "path": "/private/user-file"
        });
        assert!(serde_json::from_value::<PrepareInputsRequest>(request).is_err());
    }

    #[test]
    fn read_requires_an_explicit_generation_and_reset_epoch() {
        let request = serde_json::json!({ "job": { "jobId": "job" }, "token": "token", "offset": 0, "length": 4 });
        assert!(serde_json::from_value::<ReadInputRequest>(request).is_err());
    }
}
