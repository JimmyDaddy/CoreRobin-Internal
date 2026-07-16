import { describe, expect, it } from "vitest";

import {
  completeUserActionRecord,
  createUserActionRecord,
  MAX_USER_ACTION_RECORDS,
  mergeUserActionRecords,
  parseUserActionHistory,
  recoverInterruptedUserActions,
  redactUserActionTargetNames,
} from "./userActionHistory";

describe("user action history", () => {
  it("creates and completes a typed action record", () => {
    const running = createUserActionRecord({
      kind: "cleanup_delete",
      targetCount: 3,
    }, 1_000);
    const completed = completeUserActionRecord(running, {
      status: "partial",
      verification: "verified",
      affectedBytes: 2_048,
      failedCount: 1,
    }, 2_000);

    expect(completed).toMatchObject({
      status: "partial",
      verification: "verified",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      targetCount: 3,
      affectedBytes: 2_048,
      failedCount: 1,
    });
  });

  it("rejects malformed payloads and impossible running states", () => {
    expect(parseUserActionHistory("not json")).toEqual([]);
    expect(parseUserActionHistory(JSON.stringify({
      version: 1,
      records: [{
        id: "broken",
        kind: "process_close",
        status: "running",
        verification: "verified",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
        targetName: null,
        targetCount: null,
        affectedBytes: null,
        failedCount: null,
      }],
    }))).toEqual([]);
  });

  it("deduplicates, expires, and caps records", () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = 40 * day;
    const records = Array.from({ length: MAX_USER_ACTION_RECORDS + 20 }, (_, index) =>
      completeUserActionRecord(
        createUserActionRecord({ kind: "process_close" }, now - day + index),
        { status: "succeeded", verification: "verified" },
        now - day + index + 1,
      ));
    const duplicate = { ...records[records.length - 1]!, affectedBytes: 42 };
    const expired = completeUserActionRecord(
      createUserActionRecord({ kind: "startup_disable" }, now - 8 * day),
      { status: "succeeded", verification: "verified" },
      now - 8 * day + 1,
    );

    const merged = mergeUserActionRecords(
      [expired, ...records],
      [duplicate],
      now,
      7,
    );
    expect(merged).toHaveLength(MAX_USER_ACTION_RECORDS);
    expect(merged[merged.length - 1]?.affectedBytes).toBe(42);
    expect(merged.some(({ id }) => id === expired.id)).toBe(false);
  });

  it("redacts persisted names and recovers interrupted actions", () => {
    const running = createUserActionRecord({
      kind: "process_restart",
      targetName: "Private App",
    }, 1_000);
    expect(redactUserActionTargetNames([running])[0]?.targetName).toBeNull();
    expect(recoverInterruptedUserActions([running], 2_000)[0]).toMatchObject({
      status: "interrupted",
      verification: "not_confirmed",
      completedAtMs: 2_000,
    });
  });
});
