use super::super::types::{NetworkPolicy, ProviderMessage};
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

fn profile(protocol: Protocol) -> ConnectionProfile {
    ConnectionProfile {
        id: "fixture".into(),
        revision: 1,
        name: "Synthetic fixture".into(),
        protocol,
        api_base_url: "http://127.0.0.1:11434".into(),
        auth_kind: AuthKind::None,
        network_policy: NetworkPolicy::Loopback,
        proxy_url: None,
        proxy_network_policy: None,
        timeout_seconds: 10,
        max_output_tokens: 128,
        stream: true,
        credential_status: "not_required".into(),
        proxy_credential_status: "not_required".into(),
        chat_token_limit_parameter: "auto".into(),
        anthropic_workspace_id: None,
        auth_header_name: None,
    }
}
fn request(protocol: Protocol) -> ProviderRequest {
    ProviderRequest {
        tools: Vec::new(),
        tool_turns: Vec::new(),
        profile: profile(protocol),
        api_key: None,
        proxy_credentials: None,
        model_id: "synthetic-model".into(),
        system: "Explain the synthetic fixture only.".into(),
        messages: vec![ProviderMessage {
            role: "user".into(),
            content: "Reply with one greeting.".into(),
        }],
        max_output_tokens: 128,
        stream: true,
    }
}
fn sink() -> (DeltaCallback, Arc<Mutex<String>>) {
    let text = Arc::new(Mutex::new(String::new()));
    let captured = text.clone();
    (
        Arc::new(move |delta| captured.lock().unwrap().push_str(delta)),
        text,
    )
}
fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\r\ndata: {}\r\n\r\n",
                event["type"].as_str().unwrap(),
                event
            )
        })
        .collect()
}
fn anthropic() -> String {
    sse(&[
        json!({"type":"message_start","message":{"role":"assistant","model":"synthetic-model","usage":{"input_tokens":10,"output_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"NEVER RETAIN"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"NEVER RETAIN"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"NEVER RETAIN"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"ping"}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好 🌿"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":3}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
        json!({"type":"message_stop"}),
    ])
}
fn responses_full() -> Value {
    json!({"status":"completed","model":"synthetic-model","usage":{"input_tokens":10,"output_tokens":5},"output":[{"type":"reasoning","summary":[{"text":"NEVER RETAIN"}]},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"你好 🌿"}]}]})
}
fn responses() -> String {
    sse(&[
        json!({"type":"response.created","response":{"model":"synthetic-model"}}),
        json!({"type":"response.output_item.added","item":{"type":"reasoning"}}),
        json!({"type":"response.reasoning_summary_text.delta","delta":"NEVER RETAIN"}),
        json!({"type":"response.output_item.added","item":{"type":"message"}}),
        json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"你好 🌿"}),
        json!({"type":"response.completed","response":responses_full()}),
    ])
}
fn chat() -> String {
    [json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"你好 🌿","reasoning_content":"NEVER RETAIN"},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}})].iter().map(|e|format!("data: {e}\n\n")).collect::<String>()+"data: [DONE]\n\n"
}
fn ollama() -> String {
    format!(
        "{}\n{}\n",
        json!({"model":"synthetic-model","message":{"role":"assistant","content":"你好 🌿","thinking":"NEVER RETAIN"},"done":false}),
        json!({"model":"synthetic-model","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5})
    )
}

fn decode_parts(
    protocol: Protocol,
    wire: &str,
    size: usize,
) -> Result<ProviderCompletion, AiError> {
    let mut framing = Framing::new(matches!(protocol, Protocol::OllamaNative));
    let mut decoder = Decoder::new(protocol);
    let (callback, captured) = sink();
    for chunk in wire.as_bytes().chunks(size) {
        for event in framing.push(chunk)? {
            decoder.event(&event, &callback)?;
        }
    }
    for event in framing.end()? {
        decoder.event(&event, &callback)?;
    }
    let completion = decoder.finish()?;
    assert_eq!(*captured.lock().unwrap(), completion.text);
    Ok(completion)
}

#[test]
fn four_protocols_survive_every_small_chunk_size_and_hide_reasoning() {
    for (protocol, wire) in [
        (Protocol::OllamaNative, ollama()),
        (Protocol::OpenaiChat, chat()),
        (Protocol::OpenaiResponses, responses()),
        (Protocol::AnthropicMessages, anthropic()),
    ] {
        for size in 1..=33 {
            let result = decode_parts(protocol.clone(), &wire, size).unwrap();
            assert_eq!(result.text, "你好 🌿");
            let usage = result.usage.unwrap();
            assert_eq!(usage.input_tokens, Some(10));
            assert_eq!(usage.output_tokens, Some(5));
        }
    }
}

#[test]
fn responses_reasoning_content_parts_are_discarded_in_streams_and_completed_body() {
    let mut completed = responses_full();
    completed["output"][0]["content"] =
        json!([{"type":"reasoning_text","text":"SYNTHETIC PRIVATE REASONING"}]);
    let wire = sse(&[
        json!({"type":"response.created","response":{"model":"synthetic-model"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}),
        json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"reasoning_text","text":""}}),
        json!({"type":"response.reasoning_text.delta","output_index":0,"content_index":0,"delta":"SYNTHETIC PRIVATE REASONING"}),
        json!({"type":"response.reasoning_text.done","output_index":0,"content_index":0,"text":"SYNTHETIC PRIVATE REASONING"}),
        json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"reasoning_text","text":"SYNTHETIC PRIVATE REASONING"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":completed["output"][0]}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message"}}),
        json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"你好 🌿"}),
        json!({"type":"response.completed","response":completed}),
    ]);
    for size in 1..=33 {
        let result = decode_parts(Protocol::OpenaiResponses, &wire, size).unwrap();
        assert_eq!(result.text, "你好 🌿");
        assert_eq!(result.usage.unwrap().output_tokens, Some(5));
    }
    let (callback, captured) = sink();
    let mut decoder = Decoder::new(Protocol::OpenaiResponses);
    decoder.parse_full(&completed, &callback).unwrap();
    assert_eq!(decoder.finish().unwrap().text, "你好 🌿");
    assert_eq!(*captured.lock().unwrap(), "你好 🌿");
}

#[test]
fn responses_unknown_parts_and_reasoning_only_answers_are_not_accepted_as_text() {
    for kind in ["image", "audio", "tool_use", "unexpected"] {
        let wire = sse(&[json!({"type":"response.content_part.added","part":{"type":kind}})]);
        assert_eq!(
            decode_parts(Protocol::OpenaiResponses, &wire, 2)
                .unwrap_err()
                .code,
            "unsupported_content"
        );
    }
    let wire = sse(&[
        json!({"type":"response.content_part.added","part":{"type":"reasoning_text","text":"PRIVATE"}}),
        json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"PRIVATE"}]}]}}),
    ]);
    assert_eq!(
        decode_parts(Protocol::OpenaiResponses, &wire, 2)
            .unwrap_err()
            .code,
        "empty_response"
    );
}

#[test]
fn all_protocols_require_their_own_terminal_signal() {
    let truncated_chat = chat().replace("data: [DONE]\n\n", "");
    let truncated_anthropic = anthropic().replace(
        "event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n",
        "",
    );
    for (protocol, wire) in [
        (
            Protocol::OllamaNative,
            format!(
                "{}\n",
                json!({"message":{"content":"Partial"},"done":false})
            ),
        ),
        (Protocol::OpenaiChat, truncated_chat),
        (
            Protocol::OpenaiResponses,
            sse(&[
                json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Partial"}),
            ]),
        ),
        (Protocol::AnthropicMessages, truncated_anthropic),
    ] {
        assert_eq!(
            decode_parts(protocol, &wire, 1).unwrap_err().code,
            "incomplete_response"
        );
    }
    assert_eq!(
        decode_parts(Protocol::OpenaiChat, "data: [DONE]\n\n", 1)
            .unwrap_err()
            .code,
        "incomplete_response"
    );
}

#[test]
fn truncated_refused_tool_and_error_outputs_never_complete() {
    for (protocol, wire, code) in [
        (
            Protocol::OllamaNative,
            ollama().replace("\"stop\"", "\"length\""),
            "incomplete_response",
        ),
        (
            Protocol::OpenaiChat,
            chat().replace("\"stop\"", "\"length\""),
            "incomplete_response",
        ),
        (
            Protocol::AnthropicMessages,
            anthropic().replace("\"end_turn\"", "\"max_tokens\""),
            "incomplete_response",
        ),
        (
            Protocol::OpenaiResponses,
            sse(&[json!({"type":"response.incomplete","response":{"status":"incomplete"}})]),
            "incomplete_response",
        ),
        (
            Protocol::OpenaiChat,
            chat().replace("\"stop\"", "\"content_filter\""),
            "model_refused",
        ),
        (
            Protocol::OpenaiResponses,
            sse(&[json!({"type":"response.refusal.delta","delta":"No"})]),
            "model_refused",
        ),
        (
            Protocol::OpenaiChat,
            format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"name":"delete"}}]}}]})
            ),
            "unsupported_tool",
        ),
        (
            Protocol::OllamaNative,
            format!(
                "{}\n",
                json!({"message":{"tool_calls":[{"function":{"name":"delete"}}]},"done":false})
            ),
            "unsupported_tool",
        ),
        (
            Protocol::OpenaiResponses,
            sse(&[json!({"type":"response.output_item.added","item":{"type":"function_call"}})]),
            "unsupported_tool",
        ),
        (
            Protocol::AnthropicMessages,
            anthropic().replace("\"type\":\"text\"", "\"type\":\"tool_use\""),
            "unsupported_tool",
        ),
        (
            Protocol::OpenaiChat,
            format!("data: {}\n\n", json!({"error":{"message":"SECRET ECHO"}})),
            "provider_error",
        ),
    ] {
        let error = decode_parts(protocol, &wire, 2).unwrap_err();
        assert_eq!(error.code, code, "{}", error.message);
        assert!(!error.message.contains("SECRET"));
    }
}

#[test]
fn nonstreaming_shapes_have_the_same_text_and_completion_checks() {
    let cases = [
        (
            Protocol::OllamaNative,
            json!({"message":{"role":"assistant","content":"你好 🌿"},"done":true,"done_reason":"stop"}),
        ),
        (
            Protocol::OpenaiChat,
            json!({"choices":[{"message":{"role":"assistant","content":"你好 🌿"},"finish_reason":"stop"}]}),
        ),
        (Protocol::OpenaiResponses, responses_full()),
        (
            Protocol::AnthropicMessages,
            json!({"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"NEVER RETAIN"},{"type":"text","text":"你好 🌿"}],"stop_reason":"end_turn"}),
        ),
    ];
    for (protocol, body) in cases {
        let (callback, _) = sink();
        let mut decoder = Decoder::new(protocol);
        decoder.parse_full(&body, &callback).unwrap();
        assert_eq!(decoder.finish().unwrap().text, "你好 🌿");
    }
}

#[test]
fn anthropic_block_completion_is_not_message_completion_and_usage_is_cumulative() {
    let wire = anthropic();
    let prefix = wire.split("event: message_delta").next().unwrap();
    assert_eq!(
        decode_parts(Protocol::AnthropicMessages, prefix, 3)
            .unwrap_err()
            .code,
        "incomplete_response"
    );
    let result = decode_parts(Protocol::AnthropicMessages, &wire, 1).unwrap();
    assert_eq!(result.usage.unwrap().output_tokens, Some(5));
    let mismatched = wire.replace("event: message_stop", "event: content_block_stop");
    assert_eq!(
        decode_parts(Protocol::AnthropicMessages, &mismatched, 7)
            .unwrap_err()
            .code,
        "invalid_response"
    );
}

#[test]
fn request_mapping_never_includes_tools_reasoning_or_remote_storage() {
    for protocol in [
        Protocol::OllamaNative,
        Protocol::OpenaiChat,
        Protocol::OpenaiResponses,
        Protocol::AnthropicMessages,
    ] {
        let request = request(protocol.clone());
        let body = request_body(&request).unwrap();
        assert!(body.get("tools").is_none());
        assert!(body.get("thinking").is_none());
        assert!(body.get("previous_response_id").is_none());
        match protocol {
            Protocol::AnthropicMessages => {
                assert_eq!(body["system"], request.system);
                assert_eq!(body["messages"][0]["content"][0]["type"], "text");
                assert_eq!(body["max_tokens"], 128);
            }
            Protocol::OpenaiResponses => {
                assert_eq!(body["store"], false);
                assert_eq!(body["instructions"], request.system);
                assert_eq!(body["input"][0]["role"], "user");
            }
            Protocol::OpenaiChat => {
                assert_eq!(body["store"], false);
                assert_eq!(body["messages"][0]["role"], "system");
            }
            Protocol::OllamaNative => assert_eq!(body["options"]["num_predict"], 128),
        }
    }
    let mut illegal = request(Protocol::OpenaiChat);
    illegal.messages[0].role = "tool".into();
    assert!(request_body(&illegal).is_err());
    illegal.messages[0].role = "user".into();
    illegal.messages[0].content = "x".repeat(MAX_INPUT_BYTES);
    assert_eq!(request_body(&illegal).unwrap_err().code, "input_too_large");
}

#[test]
fn all_protocols_preserve_the_minimum_output_limit() {
    for protocol in [
        Protocol::OllamaNative,
        Protocol::OpenaiChat,
        Protocol::OpenaiResponses,
        Protocol::AnthropicMessages,
    ] {
        let mut request = request(protocol.clone());
        request.max_output_tokens = 32;
        let body = request_body(&request).unwrap();
        let limit = match protocol {
            Protocol::OllamaNative => &body["options"]["num_predict"],
            Protocol::OpenaiChat | Protocol::AnthropicMessages => &body["max_tokens"],
            Protocol::OpenaiResponses => &body["max_output_tokens"],
        };
        assert_eq!(limit, 32, "{protocol:?}");
    }
}

#[test]
fn ordinary_chat_never_forces_response_schema_for_any_protocol() {
    for protocol in [
        Protocol::OllamaNative,
        Protocol::OpenaiChat,
        Protocol::OpenaiResponses,
        Protocol::AnthropicMessages,
    ] {
        let request = request(protocol);
        let body = request_body(&request).unwrap();
        for key in [
            "format",
            "response_format",
            "text",
            "output_config",
            "tools",
        ] {
            assert!(
                body.get(key).is_none(),
                "ordinary chat must not inject {key}"
            );
        }
    }
}

#[test]
fn authentication_is_single_header_and_sensitive() {
    for protocol in [
        Protocol::OllamaNative,
        Protocol::OpenaiChat,
        Protocol::OpenaiResponses,
        Protocol::AnthropicMessages,
    ] {
        let mut connection = profile(protocol.clone());
        connection.auth_kind = AuthKind::ApiKey;
        transport::validate_profile(&connection).unwrap();
        let values = headers(&connection, Some("synthetic-key")).unwrap();
        if protocol == Protocol::AnthropicMessages {
            assert_eq!(values["anthropic-version"], "2023-06-01");
        } else {
            assert!(!values.contains_key("anthropic-version"));
        }
        assert_eq!(values["x-api-key"], "synthetic-key");
        assert!(values["x-api-key"].is_sensitive());
        assert!(!values.contains_key(AUTHORIZATION));
        assert!(headers(&connection, Some("synthetic\r\nInjected: yes")).is_err());
        connection.auth_kind = AuthKind::Bearer;
        let values = headers(&connection, Some("synthetic-key")).unwrap();
        assert!(values.contains_key(AUTHORIZATION));
        assert!(!values.contains_key("x-api-key"));
    }
}

#[test]
fn explicit_token_parameter_custom_auth_and_workspace_are_typed() {
    let mut req = request(Protocol::OpenaiChat);
    req.profile.chat_token_limit_parameter = "max_completion_tokens".into();
    let body = request_body(&req).unwrap();
    assert_eq!(body["max_completion_tokens"], 128);
    assert!(body.get("max_tokens").is_none());
    req.profile.api_base_url = "https://api.openai.com/v1".into();
    req.profile.chat_token_limit_parameter = "max_tokens".into();
    let body = request_body(&req).unwrap();
    assert_eq!(body["max_tokens"], 128);
    assert!(body.get("max_completion_tokens").is_none());
    let mut connection = profile(Protocol::AnthropicMessages);
    connection.auth_kind = AuthKind::CustomHeader;
    connection.auth_header_name = Some("X-Custom-Token".into());
    connection.anthropic_workspace_id = Some("wrkspc_fixture-123".into());
    transport::validate_profile(&connection).unwrap();
    let values = headers(&connection, Some("synthetic-only")).unwrap();
    assert_eq!(values["x-custom-token"], "synthetic-only");
    assert!(values["x-custom-token"].is_sensitive());
    assert_eq!(values["anthropic-workspace-id"], "wrkspc_fixture-123");
    assert!(!values.contains_key(AUTHORIZATION));
    assert!(!values.contains_key("x-api-key"));
    for name in [
        "Host",
        "aUtHoRiZaTiOn",
        "Proxy-Authorization",
        "Content-Length",
        "Transfer-Encoding",
        "Cookie",
        "anthropic-version",
        "anthropic-workspace-id",
        "X-Forwarded-Host",
        "x-api-key",
        "Invalid\r\nHeader",
    ] {
        connection.auth_header_name = Some(name.into());
        assert!(transport::validate_profile(&connection).is_err(), "{name}");
    }
    connection.auth_header_name = Some("api-key".into());
    connection.anthropic_workspace_id = Some("wrkspc_fixture\r\nInjected: yes".into());
    assert!(transport::validate_profile(&connection).is_err());
}

#[test]
fn remote_proxy_basic_auth_requires_tls_and_loopback_http_remains_available() {
    let mut connection = profile(Protocol::OpenaiChat);
    connection.api_base_url = "https://1.1.1.1/v1".into();
    connection.network_policy = NetworkPolicy::Public;
    let credential = ProxyCredential {
        username: "synthetic-user".into(),
        password: "synthetic-password".into(),
    };
    for raw in [
        "http://proxy.example.test:8080",
        "http://192.168.1.2:8080",
        "http://1.1.1.1:8080",
    ] {
        connection.proxy_url = Some(raw.into());
        assert_eq!(
            transport::validate_proxy_auth(&connection, &credential)
                .unwrap_err()
                .code,
            "insecure_proxy_auth"
        );
    }
    for raw in [
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://[::1]:8080",
        "https://proxy.example.test:8443",
    ] {
        connection.proxy_url = Some(raw.into());
        transport::validate_proxy_auth(&connection, &credential).unwrap();
    }
}

#[test]
fn malformed_tool_and_out_of_order_blocks_are_rejected() {
    let (callback, _) = sink();
    let mut decoder = Decoder::new(Protocol::OpenaiChat);
    let body = json!({"choices":[{"delta":{"tool_calls":{"name":"unexpected"},"content":"do not accept"},"finish_reason":"stop"}]});
    assert_eq!(
        decoder.chat(&body, true, &callback).unwrap_err().code,
        "unsupported_tool"
    );
    let wire = anthropic().replace("\"index\":0", "\"index\":8");
    assert_eq!(
        decode_parts(Protocol::AnthropicMessages, &wire, 1)
            .unwrap_err()
            .code,
        "invalid_response"
    );
}

#[test]
fn framing_scans_large_unterminated_lines_once() {
    let mut framing = Framing::new(false);
    for _ in 0..16384 {
        assert!(framing.push(b"x").unwrap().is_empty());
        assert_eq!(framing.scanned, framing.buffer.len());
    }
    assert!(framing.push(b"\r").unwrap().is_empty());
    assert_eq!(framing.scanned + 1, framing.buffer.len());
    assert!(framing.push(b"\n").unwrap().is_empty());
    assert!(framing.buffer.is_empty());
}

#[test]
fn framing_rejects_invalid_utf8_and_byte_overflow_and_accepts_multiline_sse() {
    let mut framing = Framing::new(false);
    assert!(framing.push(b"data: \xff\n\n").is_err());
    let mut framing = Framing::new(false);
    assert_eq!(
        framing
            .push(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
            .err()
            .unwrap()
            .code,
        "response_too_large"
    );
    let mut framing = Framing::new(false);
    let events = framing
        .push(b": ping\r\ndata: {\r\ndata: \"choices\":[]\r\ndata: }\r\n\r\n")
        .unwrap();
    assert_eq!(events.len(), 1);
    assert!(serde_json::from_str::<Value>(&events[0].data).is_ok());
}

fn fake_server(
    responses: Vec<(u16, String, String)>,
) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        for (status, content_type, body) in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "Expected request was not sent"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let mut expected = None;
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if expected.is_none()
                    && let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n")
                {
                    let head = String::from_utf8_lossy(&request[..end]);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    expected = Some(end + 4 + length);
                }
                if expected.is_some_and(|length| request.len() >= length) {
                    break;
                }
                assert!(request.len() < 65536);
            }
            tx.send(String::from_utf8(request).unwrap()).unwrap();
            let extra = if status == 302 {
                "Location: http://169.254.169.254/latest/meta-data\r\n"
            } else {
                ""
            };
            let header = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            for chunk in body.as_bytes().chunks(3) {
                if stream.write_all(chunk).is_err() {
                    break;
                }
            }
        }
    });
    (format!("http://{address}"), rx, handle)
}

#[tokio::test]
async fn fake_http_services_receive_protocol_specific_requests_and_preserved_prefix() {
    for (protocol, wire, path, content_type) in [
        (
            Protocol::OllamaNative,
            ollama(),
            "api/chat",
            "application/x-ndjson",
        ),
        (
            Protocol::OpenaiChat,
            chat(),
            "chat/completions",
            "text/event-stream",
        ),
        (
            Protocol::OpenaiResponses,
            responses(),
            "responses",
            "text/event-stream",
        ),
        (
            Protocol::AnthropicMessages,
            anthropic(),
            "messages",
            "text/event-stream",
        ),
    ] {
        let (address, received, server) = fake_server(vec![(200, content_type.into(), wire)]);
        let mut request = request(protocol.clone());
        request.profile.api_base_url = format!("{address}/company/api");
        if matches!(protocol, Protocol::AnthropicMessages) {
            request.profile.auth_kind = AuthKind::ApiKey;
            request.api_key = Some("synthetic-not-a-real-key".into());
        }
        let (callback, _) = sink();
        let completion = generate(request, Arc::new(AtomicBool::new(false)), callback)
            .await
            .unwrap();
        assert_eq!(completion.text, "你好 🌿");
        let wire = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(wire.starts_with(&format!("POST /company/api/{path} HTTP/1.1")));
        if matches!(protocol, Protocol::AnthropicMessages) {
            assert!(wire.contains("x-api-key: synthetic-not-a-real-key"));
            assert!(wire.contains("anthropic-version: 2023-06-01"));
        }
        let payload: Value = serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(payload["model"], "synthetic-model");
        server.join().unwrap();
    }
}

#[tokio::test]
async fn openai_compatible_api_key_auth_reaches_discovery_and_generation_without_bearer() {
    for (protocol, response) in [
        (Protocol::OpenaiChat, chat()),
        (Protocol::OpenaiResponses, responses()),
    ] {
        let (address, received, server) = fake_server(vec![
            (
                200,
                "application/json".into(),
                json!({"data":[{"id":"synthetic-model"}]}).to_string(),
            ),
            (200, "text/event-stream".into(), response),
        ]);
        let mut connection = profile(protocol.clone());
        connection.api_base_url = format!("{address}/gateway/v1");
        connection.auth_kind = AuthKind::ApiKey;
        let models = list_models(
            connection.clone(),
            Some("synthetic-gateway-key".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(models[0].id, "synthetic-model");
        let mut req = request(protocol);
        req.profile = connection;
        req.api_key = Some("synthetic-gateway-key".into());
        let (callback, _) = sink();
        assert_eq!(
            generate(req, Arc::new(AtomicBool::new(false)), callback)
                .await
                .unwrap()
                .text,
            "你好 🌿"
        );
        for _ in 0..2 {
            let wire = received.recv_timeout(Duration::from_secs(1)).unwrap();
            let (head, body) = wire.split_once("\r\n\r\n").unwrap();
            let head = head.to_ascii_lowercase();
            assert_eq!(
                head.lines()
                    .filter(|line| *line == "x-api-key: synthetic-gateway-key")
                    .count(),
                1
            );
            assert!(!head.lines().any(|line| line.starts_with("authorization:")));
            assert!(!head.contains("anthropic-version:"));
            assert!(!body.contains("synthetic-gateway-key"));
        }
        server.join().unwrap();
    }
}

#[tokio::test]
async fn anthropic_directory_paginates_without_following_server_urls() {
    let(address,received,server)=fake_server(vec![(200,"application/json".into(),json!({"data":[{"id":"first","display_name":"First"}],"has_more":true,"last_id":"first"}).to_string()),(200,"application/json".into(),json!({"data":[{"id":"second","display_name":"Second"}],"has_more":false}).to_string())]);
    let mut connection = profile(Protocol::AnthropicMessages);
    connection.api_base_url = format!("{address}/custom/v1");
    let models = list_models(connection, None, None).await.unwrap();
    assert_eq!(models.len(), 2);
    assert!(
        received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("GET /custom/v1/models?limit=100 ")
    );
    assert!(
        received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("GET /custom/v1/models?after_id=first&limit=100 ")
    );
    server.join().unwrap();
}

#[tokio::test]
async fn ollama_remote_metadata_never_becomes_a_local_inference_claim() {
    let body=json!({"models":[{"model":"unverified-model","name":"Unverified"},{"model":"remote-a","remote_host":"https://cloud.example.test"},{"model":"remote-b","remote_model":"cloud-target"}]}).to_string();
    let (address, received, server) = fake_server(vec![(200, "application/json".into(), body)]);
    let mut connection = profile(Protocol::OllamaNative);
    connection.api_base_url = address;
    let models = list_models(connection, None, None).await.unwrap();
    assert_eq!(models[0].processing_location, "unknown");
    assert_eq!(models[1].processing_location, "remote");
    assert_eq!(models[2].processing_location, "remote");
    assert!(
        received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("GET /api/tags ")
    );
    server.join().unwrap();
}

#[tokio::test]
async fn redirect_and_rate_limit_fail_without_retry_or_error_body_echo() {
    for (status, code) in [
        (302, "redirect_blocked"),
        (429, "rate_limited"),
        (503, "service_unavailable"),
    ] {
        let (address, received, server) = fake_server(vec![(
            status,
            "application/json".into(),
            "SECRET ECHO MUST NOT APPEAR".into(),
        )]);
        let mut request = request(Protocol::OpenaiChat);
        request.profile.api_base_url = address;
        let (callback, _) = sink();
        let error = generate(request, Arc::new(AtomicBool::new(false)), callback)
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
        assert!(!error.message.contains("SECRET"));
        assert!(received.recv_timeout(Duration::from_secs(1)).is_ok());
        server.join().unwrap();
        assert!(received.try_recv().is_err());
    }
}

#[tokio::test]
async fn loopback_bypasses_even_explicit_unreachable_proxy() {
    let (address, _received, server) =
        fake_server(vec![(200, "application/x-ndjson".into(), ollama())]);
    let mut request = request(Protocol::OllamaNative);
    request.profile.api_base_url = address;
    request.profile.proxy_url = Some("http://127.0.0.1:1".into());
    let (callback, _) = sink();
    assert!(
        generate(request, Arc::new(AtomicBool::new(false)), callback)
            .await
            .is_ok()
    );
    server.join().unwrap();
}

#[tokio::test]
async fn explicit_proxy_resolves_model_host_and_authentication_never_contains_model_key() {
    // The reserved .invalid hostname cannot resolve locally. The fake proxy
    // terminates CONNECT without contacting another host or receiving model data.
    let (proxy, received, server) = fake_server(vec![(
        502,
        "text/plain".into(),
        "synthetic proxy error".into(),
    )]);
    let mut req = request(Protocol::OpenaiChat);
    req.profile.api_base_url = "https://model-fixture.invalid/v1".into();
    req.profile.network_policy = NetworkPolicy::Public;
    req.profile.proxy_url = Some(proxy);
    req.profile.auth_kind = AuthKind::Bearer;
    req.api_key = Some("SYNTHETIC-MODEL-KEY".into());
    req.proxy_credentials = Some(ProxyCredential {
        username: "fixture".into(),
        password: "synthetic".into(),
    });
    let (callback, _) = sink();
    assert!(
        generate(req, Arc::new(AtomicBool::new(false)), callback)
            .await
            .is_err()
    );
    let connect = received.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(connect.starts_with("CONNECT model-fixture.invalid:443 HTTP/1.1"));
    assert!(
        connect
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic ")
    );
    assert!(!connect.contains("SYNTHETIC-MODEL-KEY"));
    assert!(!connect.contains("Reply with one greeting"));
    server.join().unwrap();
}

#[tokio::test]
async fn model_discovery_uses_proxy_dns_and_forbidden_literal_targets_stay_blocked() {
    let (proxy, received, server) = fake_server(vec![(
        502,
        "text/plain".into(),
        "synthetic proxy error".into(),
    )]);
    let mut connection = profile(Protocol::OpenaiChat);
    connection.api_base_url = "https://directory-fixture.invalid/v1".into();
    connection.network_policy = NetworkPolicy::Public;
    connection.proxy_url = Some(proxy);
    let error = list_models(connection.clone(), None, None)
        .await
        .unwrap_err();
    assert_ne!(error.code, "dns_failed");
    assert!(
        received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("CONNECT directory-fixture.invalid:443 HTTP/1.1")
    );
    server.join().unwrap();

    // Proxy DNS does not permit explicitly unsafe destinations. Validation must
    // fail before trying even an unavailable proxy, for discovery and inference.
    connection.proxy_url = Some("http://127.0.0.1:1".into());
    for target in ["https://169.254.169.254", "https://[::ffff:127.0.0.1]"] {
        connection.api_base_url = target.into();
        assert_eq!(
            list_models(connection.clone(), None, None)
                .await
                .unwrap_err()
                .code,
            "invalid_endpoint"
        );
        let mut req = request(Protocol::OpenaiChat);
        req.profile = connection.clone();
        let (callback, _) = sink();
        assert_eq!(
            generate(req, Arc::new(AtomicBool::new(false)), callback)
                .await
                .unwrap_err()
                .code,
            "invalid_endpoint"
        );
    }
}

#[tokio::test]
async fn cancellation_closes_a_real_silent_http_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (sent, received) = tokio::sync::oneshot::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut buffer = [0u8; 4096];
        assert!(stream.read(&mut buffer).unwrap() > 0);
        sent.send(()).unwrap();
        // Never send headers or tokens. A cancellation must still complete promptly.
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                _ => {}
            }
        }
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut req = request(Protocol::OllamaNative);
    req.profile.api_base_url = endpoint;
    let (callback, _) = sink();
    let task_cancel = cancelled.clone();
    let task = tokio::spawn(generate(req, task_cancel, callback));
    tokio::time::timeout(Duration::from_secs(2), received)
        .await
        .unwrap()
        .unwrap();
    cancelled.store(true, std::sync::atomic::Ordering::Release);
    let result = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().code, "cancelled");
    server.join().unwrap();
}

#[path = "providers_tool_tests.rs"]
mod tool_tests;
