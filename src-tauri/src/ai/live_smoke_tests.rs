//! Opt-in live acceptance tests. Never run in the normal test suite.
//! Require explicit user authorization before setting CORE_ROBIN_LIVE_SMOKE=1.
//! Only synthetic prompts are sent. Keys remain temporary/in memory; the
//! isolated database is removed on drop and no user application data is read.

use super::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn authorized_model(name: &str) -> String {
    assert!(
        std::env::var("CORE_ROBIN_LIVE_SMOKE").as_deref() == Ok("1"),
        "Live tests require explicit user authorization and CORE_ROBIN_LIVE_SMOKE=1"
    );
    let model = std::env::var(name).expect("Set the explicitly selected live model variable");
    assert!(!model.is_empty() && model.len() <= 256 && !model.chars().any(char::is_control));
    model
}

fn connection(protocol: Protocol, base: &str, remote: bool) -> SaveConnectionInput {
    SaveConnectionInput {
        id: None,
        expected_revision: None,
        name: "Authorized synthetic live smoke".into(),
        protocol,
        api_base_url: base.into(),
        auth_kind: if remote {
            AuthKind::Bearer
        } else {
            AuthKind::None
        },
        auth_header_name: None,
        network_policy: if remote {
            NetworkPolicy::Public
        } else {
            NetworkPolicy::Loopback
        },
        proxy_url: None,
        proxy_network_policy: None,
        anthropic_workspace_id: None,
        chat_token_limit_parameter: "auto".into(),
        timeout_seconds: 90,
        max_output_tokens: 512,
        stream: true,
    }
}

fn report(label: &str, started: Instant, result: &Result<ProviderCompletion, AiError>) {
    let mut output = serde_json::json!({
        "check": label,
        "elapsedMs": started.elapsed().as_millis(),
        "success": result.is_ok(),
    });
    match result {
        Ok(completion) => {
            output["visibleBytes"] = serde_json::json!(completion.text.len());
            output["usage"] = serde_json::json!(completion.usage);
            output["reportedModel"] = serde_json::json!(completion.reported_model);
        }
        Err(error) => output["errorCode"] = serde_json::json!(error.code),
    }
    println!("{output}");
}

async fn smoke(input: SaveConnectionInput, model: String, secret: Option<String>) {
    let directory = tempfile::tempdir().expect("isolated temporary test directory");
    let database = directory.path().join("live-smoke.sqlite");
    let service = Arc::new(AiService::open(database.clone()).expect("isolated AI service"));
    let mut profile = service
        .save_connection(input)
        .expect("save isolated connection");
    if let Some(secret) = secret {
        service
            .set_credential(SetCredentialInput {
                connection_id: profile.id.clone(),
                secret,
                temporary: true,
            })
            .expect("temporary credential");
        profile = service.get_state().unwrap().connections.remove(0);
        assert_eq!(profile.credential_status, "temporary");
    }
    let selection = ModelSelection {
        connection_id: profile.id.clone(),
        model_id: model,
    };
    service
        .update_settings(AiSettings {
            enabled: true,
            default_model: Some(selection.clone()),
            ..AiSettings::default()
        })
        .unwrap();
    let models = service
        .list_models(&profile.id)
        .await
        .expect("native model discovery");
    assert!(models.iter().any(|model| model.id == selection.model_id));
    println!(
        "{}",
        serde_json::json!({"check":"discovery", "model": selection.model_id, "modelCount": models.len()})
    );

    let started = Instant::now();
    let text = service.test_model(selection.clone()).await;
    report("streaming_text", started, &text);
    let text = text.expect("live streaming text must complete");
    assert!(!text.text.trim().is_empty());
    assert!(text.text.len() <= MAX_OUTPUT_BYTES);

    let session = service
        .create_session(CreateSessionInput {
            title: Some("Synthetic live smoke; no device data".into()),
            temporary: Some(false),
            selected_model: None,
            scenario: Some("chat".into()),
            incident_id: None,
            from_ms: None,
            to_ms: None,
        })
        .unwrap();
    assert_eq!(session.summary.selected_model.as_ref(), Some(&selection));
    let prepared = service.prepare_with_context(PrepareInput {
                    expected_connection_revision: None,
        language: Some("en".into()),
        session_id: session.summary.id.clone(),
        expected_revision: session.summary.revision,
        text: "This is a synthetic connection test with no device data. Reply briefly with OK. Do not infer device status.".into(),
        scenario: "chat".into(),
        include_context: false,
        incident_id: None,
        from_ms: None,
        to_ms: None,
    }, AiContextFacts::default()).unwrap();
    assert!(prepared.source_categories.is_empty() && prepared.history.is_empty());
    assert_eq!(prepared.preview, prepared.user_text);
    let start = StartInput {
        preparation_id: prepared.id,
        submission_id: "synthetic-live-smoke-only".into(),
        expected_session_revision: prepared.session_revision,
    };
    let started = Instant::now();
    let run = service.start(start.clone()).unwrap();
    assert_eq!(service.start(start).unwrap().request_id, run.request_id);
    let mut observed_stream = false;
    while service.get_state().unwrap().active_run.is_some_and(|run| {
        !matches!(
            run.state.as_str(),
            "complete" | "failed" | "cancelled" | "interrupted"
        )
    }) {
        let current = service.get_session(&session.summary.id).unwrap();
        observed_stream |= current.messages.iter().any(|message| {
            message.role == "assistant"
                && !message.content.is_empty()
                && message.status != "complete"
        });
        assert!(
            started.elapsed() < Duration::from_secs(100),
            "bounded live runtime wait"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let saved = service.get_session(&session.summary.id).unwrap();
    let assistant = saved.messages.last().expect("saved assistant message");
    println!(
        "{}",
        serde_json::json!({
            "check":"shared_session_persistence", "elapsedMs": started.elapsed().as_millis(),
            "status": assistant.status, "messageCount": saved.messages.len(),
            "observedStream": observed_stream, "structured": assistant.validated_result.is_some(),
            "usage": assistant.usage,
        })
    );
    assert_eq!(
        saved.messages.len(),
        2,
        "cross-window duplicate must not add another request"
    );
    assert_eq!(assistant.status, "complete");
    assert!(!assistant.content.trim().is_empty());
    service.shutdown();
    drop(service);
    let reopened = AiService::open(database).expect("reopen isolated persistence");
    assert!(reopened.get_state().unwrap().active_run.is_none());
    assert_eq!(
        reopened
            .get_session(&session.summary.id)
            .unwrap()
            .messages
            .len(),
        2
    );
    assert!(
        reopened
            .get_state()
            .unwrap()
            .connections
            .iter()
            .all(|profile| profile.credential_status != "temporary")
    );
    reopened.delete_session(&session.summary.id).unwrap();
    assert!(reopened.get_session(&session.summary.id).is_err());
    println!(
        "{}",
        serde_json::json!({"check":"reopen_and_delete", "success":true})
    );
}

#[tokio::test]
#[ignore = "Explicitly authorized DeepSeek account only; incurs a few small synthetic requests"]
async fn authorized_deepseek_native_service_smoke() {
    let model = authorized_model("CORE_ROBIN_LIVE_DEEPSEEK_MODEL");
    let secret = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY must be set");
    smoke(
        connection(Protocol::OpenaiChat, "https://api.deepseek.com", true),
        model,
        Some(secret),
    )
    .await;
}

#[tokio::test]
#[ignore = "Explicitly authorized local Ollama only; loads the selected installed model, never downloads"]
async fn authorized_ollama_native_service_smoke() {
    let model = authorized_model("CORE_ROBIN_LIVE_OLLAMA_MODEL");
    smoke(
        connection(Protocol::OllamaNative, "http://127.0.0.1:11434", false),
        model,
        None,
    )
    .await;
}

#[tokio::test]
#[ignore = "Explicitly authorized DeepSeek account only; four small synthetic compatibility requests"]
async fn authorized_deepseek_compatible_protocols_smoke() {
    let model = authorized_model("CORE_ROBIN_LIVE_DEEPSEEK_MODEL");
    let secret = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY must be set");
    for (protocol, base, label) in [
        (
            Protocol::OpenaiResponses,
            "https://api.deepseek.com",
            "responses",
        ),
        (
            Protocol::AnthropicMessages,
            "https://api.deepseek.com/anthropic/v1",
            "messages",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let service = AiService::open(directory.path().join("protocol-smoke.sqlite")).unwrap();
        let mut input = connection(protocol, base, true);
        if input.protocol == Protocol::AnthropicMessages {
            input.auth_kind = AuthKind::ApiKey;
        }
        let profile = service.save_connection(input).unwrap();
        for stream in [true, false] {
            let started = Instant::now();
            let deltas = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let callback_deltas = deltas.clone();
            let completion = providers::generate(
                ProviderRequest {
                    tools: Vec::new(),
                    tool_turns: Vec::new(),
                    profile: profile.clone(),
                    api_key: Some(secret.clone()),
                    proxy_credentials: None,
                    model_id: model.clone(),
                    system: "This is a synthetic connection test. Reply only with OK.".into(),
                    messages: vec![ProviderMessage {
                        role: "user".into(),
                        content: "Reply with OK.".into(),
                    }],
                    max_output_tokens: 512,
                    stream,
                },
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                Arc::new(move |_| {
                    callback_deltas.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }),
            )
            .await;
            report(&format!("{label}_stream_{stream}"), started, &completion);
            let completion = completion.expect("live compatible protocol completion");
            assert!(!completion.text.trim().is_empty());
            if stream {
                assert!(deltas.load(std::sync::atomic::Ordering::Relaxed) > 0);
            }
        }
    }
}

async fn tool_smoke(input: SaveConnectionInput, model: String, secret: Option<String>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let directory = tempfile::tempdir().unwrap();
    let service =
        Arc::new(AiService::open(directory.path().join("synthetic-task.sqlite")).unwrap());
    let profile = service.save_connection(input).unwrap();
    if let Some(secret) = secret {
        service
            .set_credential(SetCredentialInput {
                connection_id: profile.id.clone(),
                secret,
                temporary: true,
            })
            .unwrap();
    }
    service
        .update_settings(AiSettings {
            enabled: true,
            default_model: Some(ModelSelection {
                connection_id: profile.id,
                model_id: model.clone(),
            }),
            ..AiSettings::default()
        })
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let captured = calls.clone();
    service.set_tool_executor(Arc::new(move |call, _context| {
        let count = captured.clone();
        Box::pin(async move {
            if call.name != "get_device_status" { return Err(AiError::new("synthetic_scope", "This synthetic smoke exposes only get_device_status. No device data or actions are available.")); }
            count.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({"fixture":"synthetic-only","cpu":{"usagePercent":12},"memory":{"availableBytes":8589934592u64,"totalBytes":17179869184u64},"limitations":["These are synthetic values, not the user's device.","A single sample cannot diagnose a fault."]}))
        })
    }));
    let session = service
        .create_session(CreateSessionInput {
            title: Some("Synthetic tool acceptance".into()),
            temporary: Some(true),
            selected_model: None,
            scenario: Some("current_status".into()),
            incident_id: None,
            from_ms: None,
            to_ms: None,
        })
        .unwrap();
    let prepared = service.prepare_with_context(PrepareInput { expected_connection_revision: None, language: Some("zh-CN".into()), session_id: session.summary.id.clone(), expected_revision: session.summary.revision, text: "请执行设备检查：调用 get_device_status 获取数据，再根据工具返回的测量值给出两句中文结论。这是合成数据测试，无需检查进程、网络、磁盘，也不要提出修改操作。".into(), scenario: "current_status".into(), include_context: true, incident_id: None, from_ms: None, to_ms: None }, AiContextFacts::default()).unwrap();
    let started = Instant::now();
    let run = service
        .start(StartInput {
            preparation_id: prepared.id,
            submission_id: "synthetic-tool-acceptance".into(),
            expected_session_revision: prepared.session_revision,
        })
        .unwrap();
    while service
        .get_state()
        .unwrap()
        .active_run
        .as_ref()
        .is_some_and(|run| matches!(run.state.as_str(), "pending" | "streaming"))
    {
        if started.elapsed() > Duration::from_secs(150) {
            service.cancel(&run.request_id).unwrap();
            panic!("synthetic task exceeded 150 seconds");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let saved = service.get_session(&session.summary.id).unwrap();
    let answer = saved.messages.last().unwrap();
    println!(
        "{}",
        serde_json::json!({"check":"synthetic_tool_task","model":model,"elapsedMs":started.elapsed().as_millis(),"state":answer.status,"nativeExecutions":calls.load(Ordering::SeqCst),"toolSteps":answer.tool_steps.iter().map(|step|&step.name).collect::<Vec<_>>(),"visibleBytes":answer.content.len(),"errorCode":service.get_state().unwrap().active_run.and_then(|run|run.error).map(|error|error.code)})
    );
    assert_eq!(answer.status, "complete");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(answer.content.contains("12"));
    service.shutdown();
}

#[tokio::test]
#[ignore = "Explicitly authorized DeepSeek account only; two synthetic tool-loop requests"]
async fn deepseek_native_tool_smoke() {
    tool_smoke(
        connection(Protocol::OpenaiChat, "https://api.deepseek.com", true),
        authorized_model("CORE_ROBIN_LIVE_DEEPSEEK_MODEL"),
        Some(std::env::var("DEEPSEEK_API_KEY").expect("Authorized API key")),
    )
    .await;
}
#[tokio::test]
#[ignore = "Explicitly authorized installed Ollama model; synthetic tool loop without device access"]
async fn ollama_native_tool_smoke() {
    tool_smoke(
        connection(Protocol::OllamaNative, "http://127.0.0.1:11434", false),
        authorized_model("CORE_ROBIN_LIVE_OLLAMA_MODEL"),
        None,
    )
    .await;
}
