use super::*;

fn ready() -> HelperSignal {
    HelperSignal::Ready(ReadySignal {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        request_id: "request-1".to_owned(),
        capability: HelperCapability::Available,
        effectiveness: HookEffectiveness::Confirmed,
    })
}

#[test]
fn frames_are_bounded_and_use_explicit_envelopes() {
    let frame = encode_signal(&ready()).expect("ready signal should encode");
    assert!(frame.len() < MAX_FRAME_BYTES);
    assert_eq!(decode_signal(&frame), Ok(ready()));
    assert!(matches!(
        decode_signal(br#"{"type":"heartbeat","payload":{},"extra":true}"#),
        Err(ProtocolError::InvalidEnvelope)
    ));
    assert!(matches!(
        decode_signal(br#"{"type":"heartbeat","payload":{"protocolVersion":"keyboard-cleaning-helper-v1","requestId":"request-1","sequence":1,"key":"A"}}"#),
        Err(ProtocolError::InvalidJson)
    ));
}

#[test]
fn protocol_has_no_key_or_text_payload_surface() {
    let command = HelperCommand::Start(StartCommand {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        request_id: "request-1".to_owned(),
        duration_seconds: 30,
        prepare_deadline_ms: 3_000,
        hard_deadline_ms: 180_000,
    });
    let command_json = String::from_utf8(encode_command(&command).unwrap()).unwrap();
    let signal_json = String::from_utf8(encode_signal(&ready()).unwrap()).unwrap();
    for json in [command_json, signal_json] {
        assert!(!json.contains("\"key\""));
        assert!(!json.contains("\"text\""));
        assert!(!json.contains("\"scan"));
        assert!(!json.contains("\"clipboard\""));
        assert!(!json.contains("\"input\""));
    }
}

#[test]
fn newline_and_oversized_frames_are_rejected() {
    assert_eq!(
        decode_signal(b"{}\n"),
        Err(ProtocolError::UnexpectedLineBreak)
    );
    let oversized = vec![b'a'; MAX_FRAME_BYTES + 1];
    assert_eq!(decode_signal(&oversized), Err(ProtocolError::FrameTooLarge));
}

#[test]
fn payload_unknown_fields_are_rejected_by_typed_deserialization() {
    let frame = br#"{"type":"heartbeat","payload":{"protocolVersion":"keyboard-cleaning-helper-v1","requestId":"request-1","sequence":1,"extra":false}}"#;
    assert_eq!(decode_signal(frame), Err(ProtocolError::InvalidJson));
}
