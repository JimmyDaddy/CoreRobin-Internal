import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HistoryRetentionDays } from "../historyStore";
import {
  clearUserActionHistoryStorage,
  completeUserActionRecord,
  createUserActionRecord,
  loadUserActionHistory,
  mergeUserActionRecords,
  recoverInterruptedUserActions,
  redactUserActionTargetNames,
  saveUserActionHistory,
  type CompleteUserActionInput,
  type StartUserActionInput,
  type UserActionRecord,
} from "../userActionHistory";

export function useUserActionHistory(
  persistenceEnabled: boolean,
  retentionDays: HistoryRetentionDays,
  targetNamesEnabled: boolean,
) {
  const persistenceEnabledRef = useRef(persistenceEnabled);
  const targetNamesEnabledRef = useRef(targetNamesEnabled);
  const [sessionRecords, setSessionRecords] = useState<UserActionRecord[]>([]);
  const [storedRecords, setStoredRecords] = useState<UserActionRecord[]>(() => {
    const loaded = loadUserActionHistory();
    const recovered = recoverInterruptedUserActions(loaded);
    if (recovered.some((record, index) => record !== loaded[index])) {
      saveUserActionHistory(recovered);
    }
    return recovered;
  });

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
        saveUserActionHistory(next);
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
      saveUserActionHistory(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (targetNamesEnabled) return;
    setStoredRecords((current) => {
      if (current.length === 0) return current;
      const next = redactUserActionTargetNames(current);
      saveUserActionHistory(next);
      return next;
    });
  }, [targetNamesEnabled]);

  useEffect(() => {
    setStoredRecords((current) => {
      if (current.length === 0) return current;
      const next = mergeUserActionRecords(current, [], Date.now(), retentionDays);
      saveUserActionHistory(next);
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
    clearUserActionHistoryStorage();
    setStoredRecords([]);
  }, []);

  return { records, storedRecords, start, complete, clearSaved };
}
