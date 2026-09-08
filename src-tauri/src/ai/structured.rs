//! Bounded result validation. Model text never supplies measurements or actions.
use super::types::{AiError, EvidenceReference, ValidatedResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    pub statement: String,
    pub evidence_ids: Vec<String>,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NextStep {
    pub target: String,
    pub evidence_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticResult {
    pub summary: String,
    pub findings: Vec<Finding>,
    pub unknowns: Vec<String>,
    pub next_steps: Vec<NextStep>,
}

pub fn validate(text: &str, evidence: &[EvidenceReference]) -> Result<ValidatedResult, AiError> {
    let invalid = || {
        AiError::new(
            "invalid_structured_output",
            "The reply could not be linked to verified evidence. It is shown as unverified text; no action is available.",
        )
    };
    if text.len() > 64 * 1024 {
        return Err(invalid());
    }
    let result: DiagnosticResult = serde_json::from_str(text).map_err(|_| invalid())?;
    let valid_text = |text: &str| !text.trim().is_empty() && text.len() <= 4096;
    let valid_ids = |ids: &[String]| {
        ids.len() <= 64
            && ids
                .iter()
                .all(|id| evidence.iter().any(|item| item.id == *id))
    };
    if !valid_text(&result.summary)
        || result.findings.len() > 32
        || result.unknowns.len() > 32
        || result.next_steps.len() > 8
        || result.unknowns.iter().any(|text| !valid_text(text))
        || result.findings.iter().any(|finding| {
            !valid_text(&finding.statement)
                || !matches!(finding.kind.as_str(), "observation" | "hypothesis")
                || (finding.kind == "observation" && finding.evidence_ids.is_empty())
                || !valid_ids(&finding.evidence_ids)
        })
        || result.next_steps.iter().any(|step| {
            !matches!(
                step.target.as_str(),
                "current_status" | "network" | "history"
            ) || !valid_ids(&step.evidence_ids)
        })
    {
        return Err(invalid());
    }
    Ok(ValidatedResult {
        result,
        evidence: evidence.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn output() -> Value {
        json!({"summary":"Synthetic observation","findings":[{"statement":"CPU observed","evidenceIds":["E1"],"kind":"observation"}],"unknowns":[],"nextSteps":[{"target":"history","evidenceIds":["E1"]}]})
    }
    fn evidence() -> Vec<EvidenceReference> {
        vec![EvidenceReference {
            id: "E1".into(),
            label: "CPU".into(),
            value: "10".into(),
            unit: Some("%".into()),
        }]
    }
    #[test]
    fn only_local_evidence_values_survive_validation() {
        let validated = validate(&output().to_string(), &evidence()).unwrap();
        assert_eq!(validated.evidence[0].value, "10");
        assert_eq!(validated.result.next_steps[0].target, "history");
    }
    #[test]
    fn rejects_unknown_references_actions_and_model_measurements() {
        let mut value = output();
        value["findings"][0]["evidenceIds"] = json!(["E999"]);
        assert!(validate(&value.to_string(), &evidence()).is_err());
        let mut value = output();
        value["nextSteps"][0]["target"] = json!("shell:rm");
        assert!(validate(&value.to_string(), &evidence()).is_err());
        let mut value = output();
        value["findings"][0]["unit"] = json!("GB");
        assert!(validate(&value.to_string(), &evidence()).is_err());
        assert!(validate("{\"summary\":", &evidence()).is_err());
    }
}
