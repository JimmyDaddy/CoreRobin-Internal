#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use crate::private_storage;
    use crate::toolbox_storage::{
        DEFAULT_LANGUAGE, DEFAULT_RETENTION_DAYS, MAX_HISTORY_ENTRIES, MAX_HISTORY_PAGE,
        POLICY_FILE_NAME, RecordCompletionOutcome, STATE_FILE_NAME, ToolboxCompletionRecord,
        ToolboxNotificationStatus, ToolboxPolicy, ToolboxPolicyConfigureRequest, ToolboxStorage,
        ToolboxStorageError, ToolboxSystemTool, ToolboxTerminalStatus,
    };

    const NOW: u64 = 1_800_000_000_000;
    const DAY: u64 = 86_400_000;

    fn enabled_storage(root: &Path) -> ToolboxStorage {
        let mut storage = ToolboxStorage::open(root.to_path_buf()).expect("storage opens");
        storage
            .configure_policy(policy_request(0, true, true, DEFAULT_RETENTION_DAYS))
            .expect("history policy applies");
        storage
    }

    fn policy_request(
        expected_policy_revision: u64,
        global_history_enabled: bool,
        toolbox_history_enabled: bool,
        retention_days: u8,
    ) -> ToolboxPolicyConfigureRequest {
        ToolboxPolicyConfigureRequest {
            expected_policy_revision,
            global_history_enabled,
            toolbox_history_enabled,
            retention_days,
            notifications_enabled: true,
            language: DEFAULT_LANGUAGE.to_owned(),
        }
    }

    fn record(id: &str, completed_at_ms: u64) -> ToolboxCompletionRecord {
        ToolboxCompletionRecord {
            record_id: id.to_owned(),
            tool: ToolboxSystemTool::NetworkAddresses,
            started_at_ms: completed_at_ms.saturating_sub(10),
            completed_at_ms,
            terminal_status: ToolboxTerminalStatus::Completed,
            notification_status: ToolboxNotificationStatus::Unavailable,
        }
    }

    fn list_all(storage: &mut ToolboxStorage) -> Vec<ToolboxCompletionRecord> {
        let mut cursor = None;
        let mut records = Vec::new();
        loop {
            let page = storage
                .list_history(MAX_HISTORY_PAGE, cursor.as_deref(), NOW)
                .expect("history page loads");
            records.extend(page.records);
            cursor = page.next_cursor;
            if cursor.is_none() {
                return records;
            }
        }
    }

    #[test]
    fn corrupted_policy_and_state_fall_back_to_safe_defaults() {
        let root = tempfile::tempdir().expect("tempdir");
        private_storage::write_atomic(&root.path().join(POLICY_FILE_NAME), b"not-json")
            .expect("fixture policy writes");
        private_storage::write_atomic(&root.path().join(STATE_FILE_NAME), b"{\"schemaVersion\":1")
            .expect("fixture state writes");

        let storage = ToolboxStorage::open(root.path().to_path_buf()).expect("storage opens");
        assert_eq!(storage.policy(), &ToolboxPolicy::default());
        assert_eq!(storage.reset_epoch(), 0);
        assert_eq!(storage.history_revision(), 0);
        assert!(storage.active_activity_ids().is_empty());
    }

    #[test]
    fn policy_write_failure_keeps_old_policy_and_revision() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = ToolboxStorage::open(root.path().to_path_buf()).expect("storage opens");
        let policy_path = root.path().join(POLICY_FILE_NAME);
        fs::create_dir(&policy_path).expect("policy blocker creates");

        let error = storage
            .configure_policy(policy_request(0, true, true, DEFAULT_RETENTION_DAYS))
            .expect_err("directory target must reject atomic policy write");
        assert_eq!(error, ToolboxStorageError::Io);
        assert_eq!(storage.policy(), &ToolboxPolicy::default());
        assert!(policy_path.is_dir());

        fs::remove_dir(&policy_path).expect("policy blocker removes");
        let policy = storage
            .configure_policy(policy_request(0, true, true, DEFAULT_RETENTION_DAYS))
            .expect("policy write succeeds after blocker removal");
        assert_eq!(policy.policy_revision, 1);
        assert!(policy.history_enabled());
    }

    #[test]
    fn policy_rejects_unknown_language_and_out_of_range_retention() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = ToolboxStorage::open(root.path().to_path_buf()).expect("storage opens");

        let mut request = policy_request(0, true, true, 0);
        assert_eq!(
            storage
                .configure_policy(request.clone())
                .expect_err("zero days rejects"),
            ToolboxStorageError::InvalidRetentionDays
        );
        request.retention_days = 8;
        assert_eq!(
            storage
                .configure_policy(request.clone())
                .expect_err("eight days rejects"),
            ToolboxStorageError::InvalidRetentionDays
        );
        request.retention_days = DEFAULT_RETENTION_DAYS;
        request.language = "it".to_owned();
        assert_eq!(
            storage
                .configure_policy(request)
                .expect_err("unknown language rejects"),
            ToolboxStorageError::UnsupportedLanguage
        );
        assert_eq!(storage.policy(), &ToolboxPolicy::default());
    }

    #[test]
    fn history_switch_retention_and_expiry_behave_independently() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = enabled_storage(root.path());

        storage
            .record_completion(0, record("old", NOW - (2 * DAY)), NOW)
            .expect("old record writes while seven-day retention is active");
        storage
            .record_completion(0, record("current", NOW), NOW)
            .expect("current record writes");

        storage
            .configure_policy(policy_request(1, false, false, DEFAULT_RETENTION_DAYS))
            .expect("history can be disabled");
        let skipped = storage
            .record_completion(0, record("disabled", NOW), NOW)
            .expect("disabled history is a successful no-op");
        assert!(matches!(
            skipped,
            RecordCompletionOutcome::SkippedBecauseDisabled { .. }
        ));
        assert_eq!(
            list_all(&mut storage).len(),
            2,
            "disabling does not delete old history"
        );

        storage
            .configure_policy(policy_request(2, true, true, 1))
            .expect("one-day retention applies");
        let records = list_all(&mut storage);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_id, "current");
    }

    #[test]
    fn history_is_capped_and_pages_are_limited_to_fifty() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = enabled_storage(root.path());
        for index in 0..(MAX_HISTORY_ENTRIES + 1) {
            storage
                .record_completion(
                    0,
                    record(&format!("record-{index:03}"), NOW - index as u64),
                    NOW,
                )
                .expect("bounded record writes");
        }

        let first = storage
            .list_history(999, None, NOW)
            .expect("first bounded page loads");
        assert_eq!(first.records.len(), MAX_HISTORY_PAGE);
        assert!(first.next_cursor.is_some());
        let all = list_all(&mut storage);
        assert_eq!(all.len(), MAX_HISTORY_ENTRIES);
        assert!(!all.iter().any(|item| item.record_id == "record-100"));
    }

    #[test]
    fn policy_and_history_survive_a_provider_reopen() {
        let root = tempfile::tempdir().expect("tempdir");
        {
            let mut storage = enabled_storage(root.path());
            storage
                .record_completion(0, record("persisted", NOW), NOW)
                .expect("record writes");
        }

        let mut reopened = ToolboxStorage::open(root.path().to_path_buf()).expect("reopens");
        assert_eq!(reopened.policy().policy_revision, 1);
        assert!(reopened.policy().history_enabled());
        assert_eq!(list_all(&mut reopened)[0].record_id, "persisted");
    }

    #[test]
    fn cursor_is_bound_to_history_revision_and_clear_invalidates_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = enabled_storage(root.path());
        for index in 0..3 {
            storage
                .record_completion(0, record(&format!("record-{index}"), NOW - index), NOW)
                .expect("record writes");
        }

        let first = storage
            .list_history(2, None, NOW)
            .expect("first page loads");
        let cursor = first.next_cursor.clone().expect("second page cursor");
        let second = storage
            .list_history(2, Some(&cursor), NOW)
            .expect("second page loads");
        assert_eq!(second.records.len(), 1);
        assert_eq!(second.history_revision, first.history_revision);

        storage
            .clear_history(Some(first.history_revision))
            .expect("history clears");
        let error = storage
            .list_history(2, Some(&cursor), NOW)
            .expect_err("cleared history must reject an old cursor");
        assert!(matches!(
            error,
            ToolboxStorageError::HistoryRevisionConflict { .. }
        ));
    }

    #[test]
    fn clear_history_preserves_policy_epoch_and_active_activity() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = enabled_storage(root.path());
        storage
            .replace_active_activity_ids(0, vec!["activity-opaque-1".to_owned()])
            .expect("activity marker writes");
        storage
            .record_completion(0, record("record-1", NOW), NOW)
            .expect("record writes");
        let policy_before = storage.policy().clone();
        let epoch_before = storage.reset_epoch();
        let revision_before = storage.history_revision();

        storage
            .clear_history(Some(revision_before))
            .expect("history clears");
        assert_eq!(storage.policy(), &policy_before);
        assert_eq!(storage.reset_epoch(), epoch_before);
        assert_eq!(storage.active_activity_ids(), &["activity-opaque-1"]);
        assert!(list_all(&mut storage).is_empty());
    }

    #[test]
    fn reset_requires_current_epoch_clears_all_and_restores_defaults() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut storage = enabled_storage(root.path());
        storage
            .replace_active_activity_ids(0, vec!["activity-opaque-1".to_owned()])
            .expect("activity marker writes");
        storage
            .record_completion(0, record("record-1", NOW), NOW)
            .expect("record writes");

        let stale = storage
            .clear_all_after_stop(1, 2)
            .expect_err("stale reset epoch must be rejected");
        assert!(matches!(
            stale,
            ToolboxStorageError::ResetEpochMismatch { .. }
        ));
        assert_eq!(storage.policy().policy_revision, 1);
        assert_eq!(storage.active_activity_ids(), &["activity-opaque-1"]);

        let snapshot = storage
            .clear_all_after_stop(0, 1)
            .expect("clear all succeeds after service stop");
        assert_eq!(snapshot.reset_epoch, 1);
        assert_eq!(snapshot.policy, ToolboxPolicy::default());
        assert!(snapshot.active_activity_ids.is_empty());
        assert!(list_all(&mut storage).is_empty());
        assert!(
            storage.check_reset_epoch(1).is_ok(),
            "new epoch is accepted"
        );
        assert!(matches!(
            private_storage::read_limited(&root.path().join(POLICY_FILE_NAME), 256 * 1024)
                .expect("policy file can be checked"),
            None
        ));

        let stale_record = storage.record_completion(0, record("late", NOW), NOW);
        assert!(matches!(
            stale_record,
            Err(ToolboxStorageError::ResetEpochMismatch { .. })
        ));
    }

    #[test]
    fn completion_serialization_contains_only_minimal_allowed_fields() {
        let json = serde_json::to_value(record("opaque-id", NOW)).expect("record serializes");
        let object = json.as_object().expect("record is an object");
        assert_eq!(object.len(), 6);
        for forbidden in ["title", "path", "pid", "hash", "input", "commandLine"] {
            assert!(
                !object.contains_key(forbidden),
                "forbidden field: {forbidden}"
            );
        }
    }
}
