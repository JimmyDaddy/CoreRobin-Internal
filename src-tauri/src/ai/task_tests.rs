use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicUsize;

type Requests = Arc<Mutex<Vec<Value>>>;
fn server(replies: Vec<Value>) -> (String, Requests, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let worker = std::thread::spawn(move || {
        for reply in replies {
            let start = Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if start.elapsed() > Duration::from_secs(4) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 8192];
            let body_start = loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let length: usize = String::from_utf8_lossy(&bytes[..body_start])
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < body_start + length {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap());
            let body = reply.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    (url, requests, worker)
}
fn call(name: &str, args: Value) -> Value {
    json!({"function":{"name":name,"arguments":args}})
}
fn tools_reply(calls: Vec<Value>) -> Value {
    json!({"message":{"role":"assistant","content":"Checking.","thinking":"PRIVATE_TASK_REASONING","tool_calls":calls},"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":2})
}
fn final_reply() -> Value {
    json!({"message":{"role":"assistant","content":"The actual result is ready."},"done":true,"done_reason":"stop","prompt_eval_count":8,"eval_count":3})
}
async fn wait_until(service: &AiService, predicate: impl Fn(&Inner) -> bool) {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if predicate(&service.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("task did not reach expected state");
}
async fn finished(service: &AiService) {
    wait_until(service, |inner| {
        inner.active.is_none() && inner.last_run.is_some()
    })
    .await;
}
fn start_task(service: &Arc<AiService>, session: &AiSession) -> AnalysisRun {
    service
        .start(input(&prepare(service, session), "tool-submission"))
        .unwrap()
}
fn counting_executor(count: Arc<AtomicUsize>) -> tools::ToolExecutor {
    Arc::new(move |_, _| {
        let count = count.clone();
        Box::pin(async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"cpuPercent":12,"evidence":"synthetic native result"}))
        })
    })
}
fn confirmation_executor(count: Arc<AtomicUsize>) -> tools::ToolExecutor {
    Arc::new(move |_, context| {
        let count = count.clone();
        Box::pin(async move {
            context
                .confirm(ToolConfirmation {
                    action: "request_close".into(),
                    targets: vec!["Synthetic app · PID 999999".into()],
                    detail: "Synthetic unsaved-work risk".into(),
                    expires_at: now() + 60_000,
                })
                .await?;
            context.check_active()?;
            count.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"signalSent":true}))
        })
    })
}
async fn pending_step(service: &AiService) -> String {
    wait_until(service, |inner| {
        inner
            .active
            .as_ref()
            .is_some_and(|active| active.pending_approval.is_some())
    })
    .await;
    service
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .pending_approval
        .as_ref()
        .unwrap()
        .0
        .clone()
}

#[tokio::test]
async fn real_http_loop_executes_once_returns_evidence_and_persists_no_reasoning() {
    let (url, requests, worker) = server(vec![
        tools_reply(vec![
            call("get_device_status", json!({})),
            call("get_device_status", json!({})),
        ]),
        final_reply(),
    ]);
    let (directory, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(counting_executor(count.clone()));
    start_task(&service, &session);
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), tools::definitions_for_targets(&HashMap::new()).len());
    let next = requests[1]["messages"].as_array().unwrap();
    assert_eq!(next.iter().filter(|m| m["role"] == "tool").count(), 2);
    assert!(
        next.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("cpuPercent")
    );
    assert!(requests[1].to_string().contains("PRIVATE_TASK_REASONING"));
    let saved = service.get_session(&session.summary.id).unwrap();
    let message = saved.messages.last().unwrap();
    assert_eq!(message.status, "complete");
    assert_eq!(message.tool_steps.len(), 2);
    assert!(message.tool_steps.iter().all(|s| s.state == "complete"));
    assert_eq!(message.usage.as_ref().unwrap().output_tokens, Some(5));
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("PRIVATE_TASK_REASONING")
    );
    service.shutdown();
    drop(service);
    let reopened = AiService::open(directory.path().join("ai.sqlite")).unwrap();
    assert_eq!(
        reopened
            .get_session(&session.summary.id)
            .unwrap()
            .messages
            .last()
            .unwrap()
            .tool_steps
            .len(),
        2
    );
    for file in std::fs::read_dir(directory.path()).unwrap().flatten() {
        if file.file_type().unwrap().is_file() {
            assert!(
                !std::fs::read(file.path())
                    .unwrap()
                    .windows(b"PRIVATE_TASK_REASONING".len())
                    .any(|part| part == b"PRIVATE_TASK_REASONING")
            );
        }
    }
}
#[tokio::test]
async fn unknown_tools_extra_fields_and_arbitrary_paths_never_reach_executor() {
    let (url, requests, worker) = server(vec![
        tools_reply(vec![
            call("run_shell", json!({"command":"danger"})),
            call("get_process_usage", json!({"pid":123})),
            call(
                "request_cleanup",
                json!({"target_ref":"forged","path":"/fixture"}),
            ),
        ]),
        final_reply(),
    ]);
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(counting_executor(count.clone()));
    start_task(&service, &session);
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let next = requests.lock().unwrap()[1].clone();
    assert!(next.to_string().contains("unknown_tool"));
    assert!(next.to_string().contains("invalid_tool_arguments"));
    assert!(
        service
            .get_session(&session.summary.id)
            .unwrap()
            .messages
            .last()
            .unwrap()
            .tool_steps
            .iter()
            .all(|s| s.state == "failed")
    );
}
#[tokio::test]
async fn unchecked_device_context_disables_calls_even_with_executor_installed() {
    let (url, requests, worker) = server(vec![tools_reply(vec![call(
        "get_device_status",
        json!({}),
    )])]);
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(counting_executor(count.clone()));
    let preview = service
        .prepare_with_context(
            PrepareInput {
                expected_connection_revision: None,
                language: None,
                session_id: session.summary.id.clone(),
                expected_revision: session.summary.revision,
                text: "hello".into(),
                scenario: "current_status".into(),
                include_context: false,
                incident_id: None,
                from_ms: None,
                to_ms: None,
            },
            AiContextFacts::default(),
        )
        .unwrap();
    service.start(input(&preview, "unchecked")).unwrap();
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(requests.lock().unwrap()[0].get("tools").is_none());
    assert_eq!(
        service
            .lock()
            .unwrap()
            .last_run
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .code,
        "unsupported_tool"
    );
}
#[tokio::test]
async fn approval_is_explicit_bound_to_request_and_step_and_consumed_once() {
    let (url, _, worker) = server(vec![
        tools_reply(vec![call(
            "request_process_action",
            json!({"target_ref":"fixture","action":"request_close"}),
        )]),
        final_reply(),
    ]);
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let run = start_task(&service, &session);
    let step = pending_step(&service).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(
        service
            .resolve_tool_confirmation("wrong-run", &step, true)
            .is_err()
    );
    assert!(
        service
            .resolve_tool_confirmation(&run.request_id, "wrong-step", true)
            .is_err()
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    service
        .resolve_tool_confirmation(&run.request_id, &step, true)
        .unwrap();
    assert!(
        service
            .resolve_tool_confirmation(&run.request_id, &step, true)
            .is_err()
    );
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn rejecting_one_action_blocks_later_modifications_in_the_same_task() {
    let (url, requests, worker) = server(vec![
        tools_reply(vec![
            call(
                "request_process_action",
                json!({"target_ref":"fixture","action":"request_close"}),
            ),
            call(
                "request_process_action",
                json!({"target_ref":"another","action":"force_kill"}),
            ),
        ]),
        final_reply(),
    ]);
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let run = start_task(&service, &session);
    let step = pending_step(&service).await;
    service
        .resolve_tool_confirmation(&run.request_id, &step, false)
        .unwrap();
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert!(
        service
            .get_session(&session.summary.id)
            .unwrap()
            .messages
            .last()
            .unwrap()
            .tool_steps
            .iter()
            .all(|step| step.error.as_ref().unwrap().code == "action_rejected")
    );
}
#[tokio::test]
async fn cancellation_and_source_clear_invalidate_pending_approval_without_continuation() {
    for clear in [false, true] {
        let (url, requests, worker) = server(vec![tools_reply(vec![call(
            "request_process_action",
            json!({"target_ref":"fixture","action":"request_close"}),
        )])]);
        let (_dir, service, session) = fixture(&url);
        let count = Arc::new(AtomicUsize::new(0));
        service.set_tool_executor(confirmation_executor(count.clone()));
        let run = start_task(&service, &session);
        let step = pending_step(&service).await;
        if clear {
            service.invalidate_source("applications", false).unwrap();
        } else {
            service.cancel(&run.request_id).unwrap();
        }
        assert!(
            service
                .resolve_tool_confirmation(&run.request_id, &step, true)
                .is_err()
        );
        finished(&service).await;
        worker.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(
            service
                .get_session(&session.summary.id)
                .unwrap()
                .messages
                .last()
                .unwrap()
                .tool_steps
                .iter()
                .all(|s| s.state == "cancelled" || s.state == "interrupted")
        );
    }
}
#[tokio::test]
async fn approval_storage_failure_does_not_dispatch_action() {
    let (url, _, worker) = server(vec![tools_reply(vec![call(
        "request_process_action",
        json!({"target_ref":"fixture","action":"request_close"}),
    )])]);
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let run = start_task(&service, &session);
    let step = pending_step(&service).await;
    service.lock().unwrap().store.fail_writes(true);
    assert_eq!(
        service
            .resolve_tool_confirmation(&run.request_id, &step, true)
            .unwrap_err()
            .code,
        "storage_error"
    );
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(
        service.lock().unwrap().last_run.as_ref().unwrap().state,
        "failed"
    );
}
#[tokio::test]
async fn model_turn_budget_stops_repeated_calls_without_repeating_native_work() {
    let (url, requests, worker) = server(
        (0..tools::MAX_TOOL_ROUNDS)
            .map(|_| tools_reply(vec![call("get_device_status", json!({}))]))
            .collect(),
    );
    let (_dir, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(counting_executor(count.clone()));
    start_task(&service, &session);
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(requests.lock().unwrap().len(), tools::MAX_TOOL_ROUNDS);
    assert_eq!(
        service
            .lock()
            .unwrap()
            .last_run
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .code,
        "task_limit"
    );
}

#[tokio::test]
async fn expired_confirmation_is_not_executable() {
    let (url, _, worker) = server(vec![tools_reply(vec![call(
        "request_process_action",
        json!({"target_ref":"fixture","action":"request_close"}),
    )])]);
    let (_directory, service, session) = fixture(&url);
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let run = start_task(&service, &session);
    let step = pending_step(&service).await;
    service
        .update_task(&run.request_id, |active| {
            active
                .session
                .messages
                .last_mut()
                .unwrap()
                .tool_steps
                .last_mut()
                .unwrap()
                .confirmation
                .as_mut()
                .unwrap()
                .expires_at = now() - 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        service
            .resolve_tool_confirmation(&run.request_id, &step, true)
            .unwrap_err()
            .code,
        "stale_state"
    );
    service.cancel(&run.request_id).unwrap();
    finished(&service).await;
    worker.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn restart_retains_interrupted_steps_without_resuming_their_approval() {
    let (directory, service, session) = fixture("http://127.0.0.1:11434");
    let run = install_pending(&service, &session);
    service
        .update_task(&run, |active| {
            active
                .session
                .messages
                .last_mut()
                .unwrap()
                .tool_steps
                .push(ToolStep {
                        actions_expires_at: None,                    id: "old-step".into(),
                    name: "request_cleanup".into(),
                    state: "awaiting_confirmation".into(),
                    started_at: now(),
                    finished_at: None,
                    result: None,
                    error: None,
                    confirmation: Some(ToolConfirmation {
                        action: "trash".into(),
                        targets: vec!["/synthetic/item".into()],
                        detail: "Synthetic".into(),
                        expires_at: now() + 60_000,
                    }),
                });
            Ok(())
        })
        .unwrap();
    drop(service);
    let recovered = AiService::open(directory.path().join("ai.sqlite")).unwrap();
    let saved = recovered.get_session(&session.summary.id).unwrap();
    assert_eq!(
        saved.messages.last().unwrap().tool_steps[0].state,
        "interrupted"
    );
    assert!(
        recovered
            .resolve_tool_confirmation(&run, "old-step", true)
            .is_err()
    );
}

#[test]
fn message_pagination_counts_execution_evidence_as_well_as_text() {
    let (_directory, service, session) = fixture("http://127.0.0.1:11434");
    install_pending(&service, &session);
    let mut saved = service.get_session(&session.summary.id).unwrap();
    let mut message = saved.messages[0].clone();
    message.content = "t".repeat(8192);
    message.tool_steps = (0..8)
        .map(|id| ToolStep {
                        actions_expires_at: None,            id: id.to_string(),
            name: "get_device_status".into(),
            state: "complete".into(),
            started_at: now(),
            finished_at: Some(now()),
            result: Some("e".repeat(8192)),
            error: None,
            confirmation: None,
        })
        .collect();
    saved.messages = (0..30)
        .map(|id| {
            let mut message = message.clone();
            message.id = id.to_string();
            message
        })
        .collect();
    let page = SessionView::page(saved.clone(), None);
    assert!(page.messages.len() < 30);
    assert!(serde_json::to_vec(&page.messages).unwrap().len() <= 2 * 1024 * 1024);
    let older = SessionView::page(saved, Some(page.message_offset as u32));
    assert_eq!(older.messages.len() + page.messages.len(), 30);
    assert_ne!(older.messages.last().unwrap().id, page.messages[0].id);
}

#[tokio::test]
async fn expired_native_deadline_releases_the_confirmation_wait() {
    let (_directory, service, session) = fixture("http://127.0.0.1:11434");
    let run = install_pending(&service, &session);
    service
        .update_task(&run, |active| {
            active
                .session
                .messages
                .last_mut()
                .unwrap()
                .tool_steps
                .push(ToolStep {
                        actions_expires_at: None,                    id: "expiring".into(),
                    name: "request_cleanup".into(),
                    state: "running".into(),
                    started_at: now(),
                    finished_at: None,
                    result: None,
                    error: None,
                    confirmation: None,
                });
            Ok(())
        })
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        service.confirm_tool(
            &run,
            "expiring",
            ToolConfirmation {
                action: "trash".into(),
                targets: vec!["/synthetic/item".into()],
                detail: "Synthetic".into(),
                expires_at: now() + 20,
            },
            Arc::new(AtomicBool::new(false)),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, "confirmation_expired");
    assert!(
        service
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .pending_approval
            .is_none()
    );
}

#[tokio::test]
async fn modification_schemas_appear_only_after_the_corresponding_native_inspection() {
    let (url, requests, worker) = server(vec![
        tools_reply(vec![call("get_process_usage", json!({}))]),
        final_reply(),
    ]);
    let (_directory, service, session) = fixture(&url);
    service.set_tool_executor(Arc::new(|_call, context| {
        Box::pin(async move {
            context.targets.lock().unwrap().insert(
                "native-fixture-reference".into(),
                tools::NativeTarget::Process {
                    key: crate::models::ProcessKey {
                        pid: 999999,
                        birth_token: "fixture-birth".into(),
                    },
                    name: "Fixture process".into(),
                },
            );
            Ok(json!({"targetRef":"native-fixture-reference","name":"Fixture process"}))
        })
    }));
    start_task(&service, &session);
    finished(&service).await;
    worker.join().unwrap();
    let requests = requests.lock().unwrap();
    let names = |request: &Value| {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let initial = names(&requests[0]);
    assert!(!initial.contains(&"request_process_action".to_owned()));
    assert!(!initial.contains(&"request_cleanup".to_owned()));
    let after_inspection = names(&requests[1]);
    assert!(after_inspection.contains(&"request_process_action".to_owned()));
    assert!(!after_inspection.contains(&"request_cleanup".to_owned()));
}

async fn card_fixture() -> (tempfile::TempDir, Arc<AiService>, AiSession) {
    // No HTTP server exists. Successful card runs must never call a provider.
    let (directory, service, original) = fixture("http://127.0.0.1:1");
    let session = service.save_draft(SaveDraftInput {
        session_id: original.summary.id.clone(), expected_draft_revision: 1,
        text: "Do not send or erase this draft".into(),
    }).unwrap();
    service.set_tool_executor(Arc::new(|_, context| Box::pin(async move {
        context.targets.lock().unwrap().insert("native-card-target".into(), tools::NativeTarget::Process {
            key: crate::models::ProcessKey { pid: 999999, birth_token: "synthetic-birth".into() }, name: "Synthetic process".into(),
        });
        Ok(json!({"processes":[{"targetRef":"native-card-target","name":"Synthetic process"}]}))
    })));
    let run = install_pending(&service, &session);
    service.execute_single_tool(&run, ToolCall { id: "inspect".into(), name: "get_process_usage".into(), arguments: json!({}) },
        tools::ToolScope { include_context: true, scenario: "current_status".into(), incident_id: None, from_ms: None, to_ms: None },
        Arc::new(Mutex::new(HashMap::new())), Arc::new(AtomicBool::new(false))).await.unwrap();
    service.finish(&run, Ok(ProviderCompletion { text: "Actual inspection".into(), usage: None, reported_model: None, tool_calls: vec![], continuation: vec![] }));
    let saved = service.get_session(&session.summary.id).unwrap();
    (directory, service, saved)
}
fn card_input(session: &AiSession, action: crate::ai::capability_actions::CapabilityAction) -> crate::ai::capability_actions::CapabilityActionInput {
    let message = session.messages.last().unwrap();
    crate::ai::capability_actions::CapabilityActionInput {
        submission_id: "card-submission".into(), session_id: session.summary.id.clone(), expected_session_revision: session.summary.revision,
        message_id: message.id.clone(), step_id: message.tool_steps[0].id.clone(), action,
        target_refs: if matches!(action, crate::ai::capability_actions::CapabilityAction::Refresh) { vec![] } else { vec!["native-card-target".into()] },
    }
}
#[tokio::test]
async fn card_refresh_runs_without_provider_and_preserves_the_unsent_draft() {
    let (_directory, service, session) = card_fixture().await;
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(counting_executor(count.clone()));
    let input = card_input(&session, crate::ai::capability_actions::CapabilityAction::Refresh);
    let run = service.start_capability_action(input.clone()).unwrap();
    assert_eq!(service.start_capability_action(input).unwrap().request_id, run.request_id);
    finished(&service).await;
    let saved = service.get_session(&session.summary.id).unwrap();
    let last = saved.messages.last().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(last.status, "complete");
    assert!(last.content.is_empty() && last.usage.is_none() && last.model_label.is_none());
    assert!(!last.reusable_in_context);
    assert_eq!(saved.summary.draft_text, "Do not send or erase this draft");
}
#[tokio::test]
async fn card_process_action_requires_explicit_confirmation_and_consumes_original_targets() {
    let (_directory, service, session) = card_fixture().await;
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let input = card_input(&session, crate::ai::capability_actions::CapabilityAction::RequestClose);
    let run = service.start_capability_action(input.clone()).unwrap();
    let step = pending_step(&service).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    service.resolve_tool_confirmation(&run.request_id, &step, true).unwrap();
    finished(&service).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(service.start_capability_action(input.clone()).unwrap().request_id, run.request_id);
    let saved = service.get_session(&session.summary.id).unwrap();
    let mut second = input;
    second.submission_id = "second-card-click".into();
    second.expected_session_revision = saved.summary.revision;
    assert_eq!(service.start_capability_action(second).unwrap_err().code, "capability_target_expired");
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn card_rejects_forged_targets_and_loses_action_authority_after_restart() {
    let (directory, service, session) = card_fixture().await;
    let input = card_input(&session, crate::ai::capability_actions::CapabilityAction::ForceKill);
    let mut forged = input.clone(); forged.target_refs = vec!["999999".into()];
    assert_eq!(service.start_capability_action(forged).unwrap_err().code, "capability_target_expired");
    assert!(service.get_session(&session.summary.id).unwrap().messages[0].tool_steps[0].actions_expires_at.is_some());
    service.shutdown(); drop(service);
    let reopened = Arc::new(AiService::open(directory.path().join("ai.sqlite")).unwrap());
    let saved = reopened.get_session(&session.summary.id).unwrap();
    assert!(saved.messages[0].tool_steps[0].actions_expires_at.is_none());
    assert_eq!(reopened.start_capability_action(input).unwrap_err().code, "capability_target_expired");
}

#[tokio::test]
async fn card_storage_failure_cannot_execute_and_does_not_consume_authority() {
    let (_directory, service, session) = card_fixture().await;
    let count = Arc::new(AtomicUsize::new(0));
    service.set_tool_executor(confirmation_executor(count.clone()));
    let input = card_input(&session, crate::ai::capability_actions::CapabilityAction::RequestClose);
    service.lock().unwrap().store.fail_writes(true);
    assert!(service.start_capability_action(input.clone()).is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(service.lock().unwrap().active.is_none());
    service.lock().unwrap().store.fail_writes(false);
    let run = service.start_capability_action(input).unwrap();
    let step = pending_step(&service).await;
    service.resolve_tool_confirmation(&run.request_id, &step, false).unwrap();
    finished(&service).await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn card_source_invalidation_and_deadline_reject_before_execution() {
    let (_directory, service, session) = card_fixture().await;
    let input = card_input(&session, crate::ai::capability_actions::CapabilityAction::ForceKill);
    service.lock().unwrap().tool_targets.values_mut().for_each(|saved| saved.expires_at = 0);
    assert_eq!(service.start_capability_action(input).unwrap_err().code, "capability_target_expired");
    service.invalidate_source("resources", false).unwrap();
    let saved = service.get_session(&session.summary.id).unwrap();
    assert!(saved.messages[0].tool_steps[0].actions_expires_at.is_none());
    assert_eq!(service.start_capability_action(card_input(&saved, crate::ai::capability_actions::CapabilityAction::RequestClose)).unwrap_err().code, "capability_target_expired");
}
