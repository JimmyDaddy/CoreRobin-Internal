use super::*;
use crate::toolbox_inputs::InputRole;

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, ToolboxInputs, FileJobKey, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    let inputs = ToolboxInputs::default();
    let key = FileJobKey {
        job_id: "hash-job".into(),
        generation: 2,
        reset_epoch: 3,
    };
    inputs
        .register(key.clone(), "session".into(), "file-sha256".into())
        .unwrap();
    let token = inputs
        .prepare(&key, InputRole::Input, &[path])
        .unwrap()
        .remove(0)
        .token;
    (dir, inputs, key, token)
}

#[test]
fn hashes_empty_and_multi_chunk_inputs_without_exposing_file_contents() {
    for bytes in [
        Vec::new(),
        b"abc".to_vec(),
        vec![0x5a; FILE_CHUNK_BYTES * 2 + 17],
    ] {
        let (_dir, inputs, key, token) = fixture(&bytes);
        let reader = inputs.reader(&key, &token).unwrap();
        let mut events = Vec::new();
        let result = hash_reader(reader, "request", &AtomicBool::new(false), |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        let expected = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(result.digest, expected);
        assert_eq!(result.bytes_read, bytes.len() as u64);
        assert_eq!(result.path_hint, "fixture.bin");
        assert_eq!(result.generation, 2);
        assert_eq!(result.reset_epoch, 3);
        assert_eq!(events.last().unwrap().phase, "completed");
    }
}

#[test]
fn cancellation_stays_unconfirmed_while_the_native_reader_is_owned() {
    let (_dir, inputs, key, token) = fixture(b"content");
    let reader = inputs.reader(&key, &token).unwrap();
    assert!(!inputs.cancel(&key.job_id));
    let result = hash_reader(reader, "request", &AtomicBool::new(false), |_| {
        panic!("no successful progress")
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(inputs.cancel(&key.job_id));
}

#[test]
fn changed_inputs_and_disconnected_consumers_never_return_success() {
    let (dir, inputs, key, token) = fixture(b"before");
    let reader = inputs.reader(&key, &token).unwrap();
    std::fs::write(dir.path().join("fixture.bin"), b"after").unwrap();
    assert_eq!(
        hash_reader(reader, "request", &AtomicBool::new(false), |_| Ok(()))
            .unwrap_err()
            .code,
        "file_changed"
    );
    let (_dir, inputs, key, token) = fixture(b"test");
    let result = hash_reader(
        inputs.reader(&key, &token).unwrap(),
        "request",
        &AtomicBool::new(false),
        |_| Err(CommandError::new("interrupted", "consumer closed")),
    );
    assert_eq!(result.unwrap_err().code, "interrupted");
}

#[test]
fn hash_request_accepts_only_native_token_and_explicit_owner_identity() {
    assert!(
        serde_json::from_value::<FileHashRequest>(
            serde_json::json!({ "requestId": "r", "path": "/private/unselected" })
        )
        .is_err()
    );
    assert!(serde_json::from_value::<FileHashRequest>(serde_json::json!({ "requestId": "r", "job": { "jobId": "j", "generation": 1, "resetEpoch": 0 }, "token": "t", "path": "/private/unselected" })).is_err());
}
