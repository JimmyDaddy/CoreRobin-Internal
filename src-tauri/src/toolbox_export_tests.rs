use super::*;

#[test]
fn saves_a_copy_and_never_overwrites_existing_files() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("copy.txt");
    let request = TextExportRequest {
        path: target.to_string_lossy().into(),
        content: "first".into(),
    };
    write_text_copy(request.clone()).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"first");
    assert_eq!(
        write_text_copy(TextExportRequest {
            content: "second".into(),
            ..request
        })
        .unwrap_err()
        .code,
        "target_exists"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"first");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn a_target_created_during_export_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("race.bin");
    let result = write_reader_copy(
        &target,
        &mut Cursor::new(b"new"),
        3,
        &AtomicBool::new(false),
        || {
            std::fs::write(&target, b"concurrent user data").unwrap();
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().code, "target_exists");
    assert_eq!(std::fs::read(&target).unwrap(), b"concurrent user data");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn cancellation_and_failed_validation_leave_no_output() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("copy.bin");
    let cancel = AtomicBool::new(false);
    let result = write_reader_copy(&target, &mut Cursor::new(b"new"), 3, &cancel, || {
        cancel.store(true, Ordering::Release);
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(!target.exists());
    let result = write_reader_copy(
        &target,
        &mut Cursor::new(b"new"),
        3,
        &AtomicBool::new(false),
        || Err(changed()),
    );
    assert_eq!(result.unwrap_err().code, "target_changed");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn refuses_truncated_or_oversized_prepared_output() {
    let dir = tempfile::tempdir().unwrap();
    for expected in [2, 4] {
        let target = dir.path().join("copy.bin");
        assert_eq!(
            write_reader_copy(
                &target,
                &mut Cursor::new(b"new"),
                expected,
                &AtomicBool::new(false),
                || Ok(())
            )
            .unwrap_err()
            .code,
            "output_changed"
        );
        assert!(!target.exists());
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn rejects_dangling_links_and_changed_parent_identity() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("chosen");
    std::fs::create_dir(&parent).unwrap();
    let target = parent.join("copy.bin");
    std::os::unix::fs::symlink("does-not-exist", &target).unwrap();
    assert_eq!(
        write_reader_copy(
            &target,
            &mut Cursor::new(b"new"),
            3,
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap_err()
        .code,
        "target_exists"
    );
    std::fs::remove_file(&target).unwrap();
    let moved = dir.path().join("moved");
    let result = write_reader_copy(
        &target,
        &mut Cursor::new(b"new"),
        3,
        &AtomicBool::new(false),
        || {
            std::fs::rename(&parent, &moved).unwrap();
            std::fs::create_dir(&parent).unwrap();
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().code, "target_changed");
    assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 0);
}
