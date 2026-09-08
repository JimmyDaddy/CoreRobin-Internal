//! A finite catalog of implemented, user-operated forms. Opening a form is not
//! executing its operation, granting permission, or sharing its local inputs.
use crate::{
    AppState,
    ai::{AiError, tools::ToolContext},
    toolbox_service::TOOL_IDS,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenCapabilityArgs {
    pub capability_id: String,
}

pub const BUSINESS_FORM_IDS: &[&str] = &[
    "processes.usage",
    "processes.control",
    "network.quality",
    "storage.scan",
    "storage.cleanup",
    "device.status",
    "device.gpu_energy",
    "network.connections",
    "storage.volumes",
    "storage.eject",
    "storage.file_insights",
    "applications.activity",
    "applications.manage",
    "startup.manage",
    "history.records",
    "history.export",
    "diagnosis.incidents",
    "settings.privacy",
];

pub fn form_ids() -> Vec<String> {
    std::iter::once("storage.quick_clean".to_owned())
        .chain(BUSINESS_FORM_IDS.iter().map(|id| (*id).to_owned()))
        .chain(TOOL_IDS.iter().map(|id| format!("toolbox.{id}")))
        .collect()
}

pub fn open_form(id: &str) -> Result<Value, AiError> {
    if !form_ids().iter().any(|candidate| candidate == id) {
        return Err(AiError::new(
            "unknown_capability",
            "Choose an implemented capability from the tool schema.",
        ));
    }
    Ok(
        json!({"kind":"application_capability", "capabilityId":id, "surface":"main_window", "requiresUserInput":true, "operationExecuted":false,
        "note":"A local operation form is available in this conversation. The user must open it, choose inputs, and explicitly run or confirm the operation. Opening it does not execute anything. Platform availability and current prerequisites are checked when the form is opened; do not claim an operation is supported or complete from this receipt. File contents, file selections and secrets are not sent back to the model."}),
    )
}

pub async fn analyze_quick_cleanup(
    app: AppHandle,
    context: &ToolContext,
) -> Result<Value, AiError> {
    let summaries =
        crate::quick_cleanup_capability::analyze(app.clone(), Some(context.cancelled.clone()))
            .await
            .map_err(|error| {
                AiError::new(
                    error.code,
                    "Quick cleanup analysis did not complete. No cleanup was performed.",
                )
            })?;
    context.check_active()?;
    let revision = app
        .state::<AppState>()
        .quick_clean
        .snapshot()
        .map_err(AiError::storage)?
        .revision;
    let mut form = open_form("storage.quick_clean")?;
    form["analysis"] = json!({"revision":revision,"categories":summaries});
    form["note"] = json!(
        "Analysis completed in the shared Quick Cleanup feature. Nothing was deleted. The card lets the user select categories and explicitly confirm cleanup in the main window. The model cannot start quick cleanup."
    );
    Ok(form)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_implemented_forms_are_accepted_and_opening_does_not_claim_execution() {
        assert_eq!(form_ids().len(), 55);
        for id in form_ids() {
            let receipt = open_form(&id).unwrap();
            assert_eq!(receipt["operationExecuted"], false);
            assert_eq!(receipt["requiresUserInput"], true);
        }
        assert!(open_form("shell.run").is_err());
        assert!(open_form("toolbox.arbitrary").is_err());
    }
}
