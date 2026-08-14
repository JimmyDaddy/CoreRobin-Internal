use std::fs;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tempfile::tempdir;

static WORKER_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn cleanup_scan_worker_streams_progress_and_writes_a_result() {
    let _worker_guard = WORKER_TEST_LOCK.lock().unwrap();
    let fixture = tempdir().unwrap();
    let scan_root = fixture.path().join("scan-root");
    fs::create_dir_all(scan_root.join("nested")).unwrap();
    fs::create_dir_all(scan_root.join("second")).unwrap();
    fs::write(scan_root.join("nested").join("one.bin"), vec![1_u8; 4_096]).unwrap();
    fs::write(
        scan_root.join("second").join("three.bin"),
        vec![3_u8; 2_048],
    )
    .unwrap();
    fs::write(scan_root.join("two.bin"), vec![2_u8; 8_192]).unwrap();

    let private = fixture.path().join("private");
    fs::create_dir_all(&private).unwrap();
    let request_path = private.join("request.json");
    let result_path = private.join("cleanup-test.result.json");
    let index_path = private.join("cleanup-scan-index-v1.sqlite");
    let exclusions_path = private.join("exclusions.json");
    fs::write(&exclusions_path, b"[]").unwrap();
    fs::write(
        &request_path,
        serde_json::to_vec(&serde_json::json!({
            "operation": "scan",
            "request": {
                "profile": "complete",
                "targetKind": "folder",
                "targetPath": scan_root,
            },
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_core-robin"))
        .arg("--cleanup-scan-worker")
        .arg(&request_path)
        .arg(&result_path)
        .arg(&index_path)
        .arg(&exclusions_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let parent_control = child.stdin.take().unwrap();
    let output = child.wait_with_output().unwrap();
    drop(parent_control);

    assert!(
        output.status.success(),
        "worker stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events = String::from_utf8(output.stdout).unwrap();
    assert!(events.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("kind").cloned())
            == Some(Value::String("completed".to_owned()))
    }));

    let result: Value = serde_json::from_slice(&fs::read(result_path).unwrap()).unwrap();
    assert_eq!(result["scanId"], "cleanup-test");
    assert_eq!(result["profile"], "complete");
    assert_eq!(result["indexed"], true);
    assert_eq!(result["targetKind"], "folder");
    assert_eq!(
        result["targetPath"],
        scan_root.canonicalize().unwrap().to_string_lossy().as_ref()
    );
    assert!(result["scannedEntryCount"].as_u64().unwrap() >= 2);
    assert!(
        result["root"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["name"] == "nested"),
        "the native index should retain the scanned directory tree"
    );
    assert!(index_path.is_file());
}

#[test]
fn cleanup_scan_worker_exits_when_its_parent_control_pipe_closes() {
    let _worker_guard = WORKER_TEST_LOCK.lock().unwrap();
    let fixture = tempdir().unwrap();
    let private = fixture.path().join("private");
    fs::create_dir_all(&private).unwrap();
    let request_path = private.join("request.json");
    let result_path = private.join("blocked-worker.result.json");
    let index_path = private.join("cleanup-scan-index-v1.sqlite");
    let exclusions_path = private.join("exclusions.json");
    fs::write(&exclusions_path, b"[]").unwrap();
    fs::write(
        &request_path,
        serde_json::to_vec(&serde_json::json!({
            "operation": "scan",
            "request": {
                "profile": "complete",
                "targetKind": "folder",
                "targetPath": fixture.path(),
            },
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_core-robin"))
        .arg("--cleanup-scan-worker")
        .arg(&request_path)
        .arg(&result_path)
        .arg(&index_path)
        .arg(&exclusions_path)
        .env("CORE_ROBIN_TEST_BLOCK_CLEANUP_WORKER_MS", "30000")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdin.take());

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cleanup worker survived after the parent control pipe closed"
        );
        thread::sleep(Duration::from_millis(25));
    }
}
