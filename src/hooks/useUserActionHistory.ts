import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HistoryRetentionDays } from "../historyStore";
import { isDesktopRuntime } from "../api";
import {
  clearUserActionHistoryStorage,
  completeUserActionRecord,
  createUserActionRecord,
  loadUserActionHistory,
  mergeUserActionRecords,
  recoverInterruptedUserActions,
  redactUserActionTargetNames,
  saveUserActionHistory,
  serializeUserActionHistory,
  parseUserActionHistory,
  type CompleteUserActionInput,
  type StartUserActionInput,
  type UserActionRecord,
} from "../userActionHistory";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

export function useUserActionHistory(
  persistenceEnabled: boolean,
  retentionDays: HistoryRetentionDays,
  targetNamesEnabled: boolean,
) {
  const persistenceEnabledRef = useRef(persistenceEnabled);
  const targetNamesEnabledRef = useRef(targetNamesEnabled);
  const [sessionRecords, setSessionRecords] = useState<UserActionRecord[]>([]);
  const desktop = isDesktopRuntime();
  const loadRecovered = () => {
    const loaded = loadUserActionHistory();
    const recovered = recoverInterruptedUserActions(loaded);
    if (!desktop && recovered.some((record, index) => record !== loaded[index])) {
      saveUserActionHistory(recovered);
    }
    return recovered;
  };
  const storage = useNativeHistoryStorage<UserActionRecord[]>({
    category: "user-actions",
    enabled: persistenceEnabled,
    initialValue: loadRecovered,
    parse: (payload) => recoverInterruptedUserActions(
      parseUserActionHistory(payload),
    ),
    serialize: serializeUserActionHistory,
    clearLegacy: clearUserActionHistoryStorage,
  });
  const storedRecords = storage.value;
  const setStoredRecords = storage.setValue;

  persistenceEnabledRef.current = persistenceEnabled;
  targetNamesEnabledRef.current = targetNamesEnabled;

  const start = useCallback((input: StartUserActionInput): string => {
    const record = createUserActionRecord(input);
    setSessionRecords((current) => [...current, record]);
    if (persistenceEnabledRef.current) {
      setStoredRecords((current) => {
        const persistentRecord = targetNamesEnabledRef.current
          ? record
          : { ...record, targetName: null };
        const next = mergeUserActionRecords(
          current,
          [persistentRecord],
          Date.now(),
          retentionDays,
        );
        if (!desktop) saveUserActionHistory(next);
        return next;
      });
    }
    return record.id;
  }, [retentionDays]);

  const complete = useCallback((
    id: string,
    input: CompleteUserActionInput,
  ) => {
    const completedAtMs = Date.now();
    setSessionRecords((current) => current.map((record) =>
      record.id === id
        ? completeUserActionRecord(record, input, completedAtMs)
        : record));
    setStoredRecords((current) => {
      let found = false;
      const next = current.map((record) => {
        if (record.id !== id) return record;
        found = true;
        return completeUserActionRecord(record, input, completedAtMs);
      });
      if (!found) return current;
      if (!desktop) saveUserActionHistory(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (targetNamesEnabled) return;
    setStoredRecords((current) => {
      if (current.length === 0) return current;
      const next = redactUserActionTargetNames(current);
      if (!desktop) saveUserActionHistory(next);
      return next;
    });
  }, [targetNamesEnabled]);

  useEffect(() => {
    setStoredRecords((current) => {
      if (current.length === 0) return current;
      const next = mergeUserActionRecords(current, [], Date.now(), retentionDays);
      if (!desktop) saveUserActionHistory(next);
      return next;
    });
    setSessionRecords((current) =>
      mergeUserActionRecords([], current, Date.now(), retentionDays));
  }, [retentionDays]);

  const records = useMemo(
    () => mergeUserActionRecords(
      storedRecords,
      sessionRecords,
      Date.now(),
      retentionDays,
    ).reverse(),
    [retentionDays, sessionRecords, storedRecords],
  );

  const clearSaved = useCallback(() => {
    void storage.clear().catch(() => undefined);
  }, [storage]);

  return {
    records,
    storedRecords,
    start,
    complete,
    clearSaved,
    storageStatus: storage.storageStatus,
  };
}
