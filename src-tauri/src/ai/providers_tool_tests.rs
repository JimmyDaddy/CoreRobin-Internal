// Protocol fixtures exercise real framing, finalization and continuation bodies.
use super::super::super::types::{ProviderToolTurn, ToolResult};
use super::*;

fn decode(protocol: Protocol, wire: &str, chunk: usize) -> Result<ProviderCompletion, AiError> {
    let mut framing = Framing::new(protocol == Protocol::OllamaNative);
    let mut decoder = Decoder::new(protocol);
    decoder.tools.enabled = true;
    let (callback, captured) = sink();
    for part in wire.as_bytes().chunks(chunk) {
        for event in framing.push(part)? {
            decoder.event(&event, &callback)?;
        }
    }
    for event in framing.end()? {
        decoder.event(&event, &callback)?;
    }
    let result = decoder.finish()?;
    assert_eq!(result.text, *captured.lock().unwrap());
    assert!(!result.text.contains("PRIVATE"));
    assert!(!format!("{result:?}").contains("PRIVATE"));
    assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE"));
    Ok(result)
}
fn fixtures() -> Vec<(Protocol, Value, String)> {
    let chat_message = json!({"role":"assistant","content":"Checking.","reasoning_content":"PRIVATE","tool_calls":[{"type":"function","id":"c1","function":{"name":"get_device_status","arguments":"{}"}}]});
    let chat_full =
        json!({"choices":[{"index":0,"message":chat_message,"finish_reason":"tool_calls"}]});
    let chat_stream=[json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"Checking.","reasoning_content":"PRIVATE","tool_calls":[{"index":0,"type":"function","id":"c1","function":{"name":"get_device_status","arguments":"{"}}]},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})].iter().map(|v|format!("data: {v}\n\n")).collect::<String>()+"data: [DONE]\n\n";
    let ollama_message = json!({"role":"assistant","content":"Checking.","thinking":"PRIVATE","tool_calls":[{"function":{"name":"get_device_status","arguments":{}}}]});
    let ollama_full = json!({"message":ollama_message,"done":true,"done_reason":"stop"});
    let ollama_stream = format!(
        "{}\n{}\n",
        json!({"message":ollama_message,"done":false}),
        json!({"message":{"content":""},"done":true,"done_reason":"stop"})
    );
    let responses_full = json!({"status":"completed","output":[{"type":"reasoning","id":"r1","encrypted_content":"PRIVATE"},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Checking."}]},{"type":"function_call","id":"fc1","call_id":"c1","name":"get_device_status","arguments":"{}","status":"completed"}]});
    let responses_stream = sse(&[
        json!({"type":"response.output_item.added","item":{"type":"function_call"}}),
        json!({"type":"response.function_call_arguments.delta","delta":"{"}),
        json!({"type":"response.completed","response":responses_full}),
    ]);
    let anthropic_full = json!({"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"PRIVATE","signature":"PRIVATE_SIGNATURE"},{"type":"text","text":"Checking."},{"type":"tool_use","id":"c1","name":"get_device_status","input":{}}],"stop_reason":"tool_use"});
    let anthropic_stream = sse(&[
        json!({"type":"message_start","message":{"role":"assistant"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"PRIVATE"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"PRIVATE_SIGNATURE"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":"Checking."}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"c1","name":"get_device_status","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        json!({"type":"message_stop"}),
    ]);
    vec![
        (Protocol::OpenaiChat, chat_full, chat_stream),
        (Protocol::OllamaNative, ollama_full, ollama_stream),
        (Protocol::OpenaiResponses, responses_full, responses_stream),
        (
            Protocol::AnthropicMessages,
            anthropic_full,
            anthropic_stream,
        ),
    ]
}
#[test]
fn four_tool_protocols_survive_fragmentation_and_round_trip_private_continuation() {
    for (protocol, full, wire) in fixtures() {
        for chunk in 1..=17 {
            let completion = decode(protocol.clone(), &wire, chunk).unwrap();
            assert_eq!(completion.tool_calls.len(), 1);
            assert_eq!(completion.tool_calls[0].arguments, json!({}));
            assert_eq!(completion.text, "Checking.");
            let mut next = request(protocol.clone());
            next.tools = super::super::super::tools::definitions();
            next.tool_turns.push(ProviderToolTurn {
                assistant: completion.continuation.clone(),
                results: vec![ToolResult {
                    call: completion.tool_calls[0].clone(),
                    output: r#"{"cpuPercent":12}"#.into(),
                    is_error: false,
                }],
            });
            let body = request_body(&next).unwrap();
            assert!(body.to_string().contains("PRIVATE"));
            assert!(body.to_string().contains("cpuPercent"));
            let field = if protocol == Protocol::OpenaiResponses {
                "input"
            } else {
                "messages"
            };
            let last = body[field].as_array().unwrap().last().unwrap();
            match protocol {
                Protocol::OpenaiChat => assert_eq!(last["tool_call_id"], "c1"),
                Protocol::OllamaNative => assert_eq!(last["tool_name"], "get_device_status"),
                Protocol::OpenaiResponses => {
                    assert_eq!(last["call_id"], "c1");
                    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
                    assert_eq!(body["store"], false);
                }
                Protocol::AnthropicMessages => assert_eq!(last["content"][0]["tool_use_id"], "c1"),
            }
        }
        let mut decoder = Decoder::new(protocol.clone());
        decoder.tools.enabled = true;
        let (callback, _) = sink();
        decoder.parse_full(&full, &callback).unwrap();
        let full_completion = decoder.finish().unwrap();
        assert_eq!(full_completion.tool_calls.len(), 1);
        assert_eq!(
            full_completion.continuation,
            decode(protocol, &wire, 3).unwrap().continuation
        );
    }
}
#[test]
fn ollama_preserves_nested_json_text_across_stream_framing_and_utility_ipc() {
    let input = "{\"n\":7,\"label\":\"中文\\nline\",\"quoted\":\"\\\"value\\\"\"}";
    let arguments = json!({"operation":"json_format","input":input,"indent":2});
    let wire = format!(
        "{}\n{}\n",
        json!({"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"run_local_utility","arguments":arguments}}]},"done":false}),
        json!({"message":{"content":""},"done":true,"done_reason":"stop"})
    );
    for chunk in 1..=32 {
        let completion = decode(Protocol::OllamaNative, &wire, chunk).unwrap();
        assert_eq!(completion.tool_calls.len(), 1);
        assert_eq!(completion.tool_calls[0].arguments, arguments);
        let claimed: crate::local_utility_bridge::UtilityArgs =
            serde_json::from_value(completion.tool_calls[0].arguments.clone()).unwrap();
        let ipc = serde_json::to_value(claimed).unwrap();
        assert_eq!(ipc["input"], input);
        let parsed: Value = serde_json::from_str(ipc["input"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["n"], 7);
        assert_eq!(parsed["label"], "中文\nline");
        assert_eq!(parsed["quoted"], "\"value\"");
    }
}
#[test]
fn malformed_truncated_mismatched_and_post_terminal_calls_never_finalize() {
    for (protocol, mut full, wire) in fixtures() {
        let lines = match protocol {
            Protocol::OpenaiChat => wire.rfind("data: [DONE]").unwrap(),
            Protocol::OllamaNative => wire.trim_end().rfind('\n').unwrap() + 1,
            Protocol::OpenaiResponses => 0,
            Protocol::AnthropicMessages => wire.rfind("event: message_stop").unwrap(),
        };
        assert!(decode(protocol.clone(), &wire[..lines], 3).is_err());
        match protocol {
            Protocol::OpenaiChat => {
                full["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = json!("{")
            }
            Protocol::OllamaNative => {
                full["message"]["tool_calls"][0]["function"]["arguments"] = json!([1])
            }
            Protocol::OpenaiResponses => full["output"][2]["arguments"] = json!("[]"),
            Protocol::AnthropicMessages => full["content"][2]["input"] = json!([1]),
        }
        let mut decoder = Decoder::new(protocol);
        decoder.tools.enabled = true;
        let (callback, _) = sink();
        assert!(
            decoder
                .parse_full(&full, &callback)
                .and_then(|_| decoder.finish())
                .is_err()
        );
    }
    for reason in ["stop", "tool_use", "length"] {
        let (_, mut full, _) = fixtures().remove(0);
        full["choices"][0]["finish_reason"] = json!(reason);
        let mut decoder = Decoder::new(Protocol::OpenaiChat);
        decoder.tools.enabled = true;
        let (callback, _) = sink();
        assert!(decoder.parse_full(&full, &callback).is_err());
    }
    let (_, _, wire) = fixtures().remove(0);
    let late = wire.replace(
        "data: [DONE]",
        &format!(
            "data: {}\n\ndata: [DONE]",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" "}}]}}]})
        ),
    );
    assert!(decode(Protocol::OpenaiChat, &late, 3).is_err());
}

#[test]
fn oversized_calls_and_private_continuation_fail_before_execution() {
    let (_, mut full, _) = fixtures().remove(1);
    let call = full["message"]["tool_calls"][0].clone();
    full["message"]["tool_calls"] = json!(vec![call; 9]);
    let mut decoder = Decoder::new(Protocol::OllamaNative);
    decoder.tools.enabled = true;
    let (callback, _) = sink();
    assert!(decoder.parse_full(&full, &callback).is_err());
    let (_, mut full, _) = fixtures().remove(0);
    full["choices"][0]["message"]["reasoning_content"] = json!("p".repeat(256 * 1024 + 1));
    let mut decoder = Decoder::new(Protocol::OpenaiChat);
    decoder.tools.enabled = true;
    assert!(decoder.parse_full(&full, &callback).is_err());
}
