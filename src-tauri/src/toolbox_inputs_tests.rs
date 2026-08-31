use super::*;

fn registered(tool: &str) -> (ToolboxInputs, FileJobKey) {
    let store = ToolboxInputs::default();
    let key = FileJobKey {
        job_id: "job".into(),
        generation: 3,
        reset_epoch: 1,
    };
    store
        .register(key.clone(), "session".into(), tool.into())
        .unwrap();
    (store, key)
}

#[test]
fn reads_bounded_ranges_and_rejects_cross_generation_or_role() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input.bin");
    std::fs::write(&path, b"abcdef").unwrap();
    let (store, key) = registered("binary-patch-create");
    let tokens = store
        .prepare(&key, InputRole::Input, std::slice::from_ref(&path))
        .unwrap();
    let token = &tokens[0];
    assert_eq!(token.byte_length, 6);
    assert_eq!(store.read(&key, &token.token, 2, 3).unwrap(), b"cde");
    assert_eq!(
        store
            .read(&key, &token.token, 0, FILE_CHUNK_BYTES + 1)
            .unwrap_err()
            .code,
        "invalid_range"
    );
    let stale = FileJobKey {
        generation: 2,
        ..key.clone()
    };
    assert_eq!(
        store.read(&stale, &token.token, 0, 1).unwrap_err().code,
        "stale_job"
    );
    assert_eq!(
        store
            .prepare(&key, InputRole::Logo, &[path])
            .unwrap_err()
            .code,
        "invalid_input_role"
    );
    assert!(
        !serde_json::to_string(token)
            .unwrap()
            .contains(&dir.path().to_string_lossy().to_string())
    );
}

#[test]
fn replacement_and_in_place_changes_invalidate_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input.bin");
    std::fs::write(&path, b"abcdef").unwrap();
    let (store, key) = registered("binary-patch-create");
    let token = store
        .prepare(&key, InputRole::Input, std::slice::from_ref(&path))
        .unwrap()
        .remove(0);
    let replacement = dir.path().join("replacement");
    std::fs::write(&replacement, b"ghijkl").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        store.read(&key, &token.token, 0, 6).unwrap_err().code,
        "file_changed"
    );
    store.release(&key, &[token.token]).unwrap();
    let token = store
        .prepare(&key, InputRole::Input, std::slice::from_ref(&path))
        .unwrap()
        .remove(0);
    std::fs::write(&path, b"changed size").unwrap();
    assert_eq!(store.revalidate_all(&key).unwrap_err().code, "file_changed");
    assert_eq!(
        store.read(&key, &token.token, 0, 1).unwrap_err().code,
        "file_changed"
    );
}

#[test]
fn cancel_does_not_claim_release_while_io_is_in_flight() {
    let (store, key) = registered("binary-patch-create");
    let guard = Operation::acquire(store.job(&key).unwrap()).unwrap();
    assert!(!store.cancel(&key.job_id));
    assert_eq!(store.job(&key).err().unwrap().code, "cancelled");
    drop(guard);
    assert!(store.cancel(&key.job_id));
    assert!(store.cancel(&key.job_id));
    assert_eq!(store.job(&key).err().unwrap().code, "job_not_found");
}

#[test]
fn selection_is_counted_until_dialog_returns_and_late_paths_are_discarded() {
    let (store, key) = registered("binary-patch-create");
    let result = store.select(&key, InputRole::Input, || {
        assert!(!store.cancel(&key.job_id));
        Ok(Vec::new())
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(store.cancel(&key.job_id));
}

#[test]
fn serializes_file_operations_and_checks_role_before_selection() {
    let (store, key) = registered("binary-patch-create");
    let guard = Operation::acquire(store.job(&key).unwrap()).unwrap();
    assert_eq!(
        Operation::acquire(store.job(&key).unwrap())
            .err()
            .unwrap()
            .code,
        "input_busy"
    );
    drop(guard);
    assert_eq!(
        store
            .select(&key, InputRole::Logo, || panic!(
                "invalid role must not open a dialog"
            ))
            .unwrap_err()
            .code,
        "invalid_input_role"
    );
}

#[test]
fn validates_per_role_and_combined_batch_budgets_before_registration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.bin");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(17 * MIB)
        .unwrap();
    let (store, key) = registered("binary-patch-create");
    assert_eq!(
        store
            .prepare(&key, InputRole::Input, std::slice::from_ref(&path))
            .unwrap_err()
            .code,
        "input_too_large"
    );
    let (store, key) = registered("image-batch-watermark");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(12 * MIB)
        .unwrap();
    assert_eq!(
        store
            .prepare(&key, InputRole::Input, &vec![path; 7])
            .unwrap_err()
            .code,
        "input_too_large"
    );
    assert_eq!(store.retained_bytes(&key.job_id), 0);
}

#[test]
fn rejects_directory_and_unselected_or_released_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key) = registered("binary-patch-create");
    assert_eq!(
        store
            .prepare(&key, InputRole::Input, &[dir.path().to_path_buf()])
            .unwrap_err()
            .code,
        "file_not_regular"
    );
    assert_eq!(
        store.read(&key, "not-selected", 0, 1).unwrap_err().code,
        "invalid_token"
    );
    let path = dir.path().join("empty");
    std::fs::write(&path, []).unwrap();
    let token = store
        .prepare(&key, InputRole::Input, &[path])
        .unwrap()
        .remove(0);
    assert_eq!(
        store.read(&key, &token.token, 0, 1).unwrap(),
        Vec::<u8>::new()
    );
    store.release(&key, std::slice::from_ref(&token.token)).unwrap();
    assert_eq!(
        store.read(&key, &token.token, 0, 1).unwrap_err().code,
        "invalid_token"
    );
}

#[cfg(unix)]
#[test]
fn rejects_links_and_special_files_without_following_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let link = dir.path().join("link");
    std::fs::write(&path, b"data").unwrap();
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let (store, key) = registered("binary-patch-create");
    assert_eq!(
        store
            .prepare(&key, InputRole::Input, &[link])
            .unwrap_err()
            .code,
        "file_not_regular"
    );
    assert_eq!(
        store
            .prepare(&key, InputRole::Input, &[PathBuf::from("/dev/null")])
            .unwrap_err()
            .code,
        "file_not_regular"
    );
}
