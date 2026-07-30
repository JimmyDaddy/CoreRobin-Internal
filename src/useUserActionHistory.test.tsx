/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUserActionHistory } from "./hooks/useUserActionHistory";
import {
  parseUserActionHistory,
  USER_ACTION_HISTORY_STORAGE_KEY,
} from "./userActionHistory";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useUserActionHistory", () => {
  it("keeps the session label while persisting a redacted completed record", () => {
    const { result } = renderHook(() => useUserActionHistory(true, 7, false));
    let id = "";
    act(() => {
      id = result.current.start({
        kind: "process_close",
        targetName: "Private App",
        targetCount: 1,
      });
    });
    act(() => {
      result.current.complete(id, {
        status: "succeeded",
        verification: "verified",
        targetCount: 1,
      });
    });

    expect(result.current.records[0]).toMatchObject({
      targetName: "Private App",
      status: "succeeded",
    });
    const stored = parseUserActionHistory(
      window.localStorage.getItem(USER_ACTION_HISTORY_STORAGE_KEY),
    );
    expect(stored[0]).toMatchObject({
      targetName: null,
      status: "succeeded",
    });
  });

  it("does not write new records when persistent history is disabled", () => {
    const { result } = renderHook(() => useUserActionHistory(false, 7, true));
    act(() => {
      result.current.start({ kind: "cleanup_delete", targetCount: 2 });
    });

    expect(result.current.records).toHaveLength(1);
    expect(window.localStorage.getItem(USER_ACTION_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("confirms the installed version after the application restarts", () => {
    const { result } = renderHook(() => useUserActionHistory(true, 7, true));
    let id = "";
    act(() => {
      id = result.current.start({
        kind: "application_update",
        targetName: "CoreRobin v2.0.0",
      });
      result.current.complete(id, {
        status: "succeeded",
        verification: "verified",
        outcome: {
          updateDownloaded: true,
          updateInstalled: true,
          updateRestarted: false,
        },
      });
    });
    act(() => {
      result.current.confirmLatestApplicationUpdate("2.0.0");
    });

    expect(result.current.records[0]?.outcome).toMatchObject({
      updateDownloaded: true,
      updateInstalled: true,
      updateRestarted: true,
      confirmedVersion: "2.0.0",
    });
  });
});
