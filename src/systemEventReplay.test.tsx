/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SystemEventReplay } from "./components/SystemEventReplay";
import i18n from "./i18n";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("system event replay", () => {
  it("correlates a completed action with the following resource samples", () => {
    const now = Date.now();
    const completedAtMs = now - 10 * 60_000;
    const action: UserActionRecord = {
      id: "action-1",
      kind: "process_close",
      status: "succeeded",
      verification: "verified",
      startedAtMs: completedAtMs - 1_000,
      completedAtMs,
      targetName: "Example",
      targetCount: 1,
      affectedBytes: null,
      failedCount: 0,
    };
    render(
      <SystemEventReplay
        points={[
          point(completedAtMs - 8 * 60_000, 80, 80),
          point(completedAtMs - 4 * 60_000, 70, 70),
          point(completedAtMs + 4 * 60_000, 10, 20),
          point(completedAtMs + 8 * 60_000, 10, 20),
        ]}
        applicationImpactPoints={[]}
        alerts={[]}
        watchEvents={[]}
        networkQualityPoints={[]}
        actions={[action]}
      />,
    );

    expect(screen.getByText(/操作后 15 分钟内系统压力有所下降/)).toBeTruthy();
  });
});

function point(
  timestamp: number,
  cpuPercent: number,
  memoryPercent: number,
): HistoryPoint {
  return {
    timestamp,
    cpuPercent,
    memoryPercent,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
  };
}
