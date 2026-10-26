/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplicationImpact } from "../diagnosis";
import i18n from "../i18n";
import { getMockSnapshot } from "../mockData";
import { DeviceWellbeing } from "./DeviceWellbeing";

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("DeviceWellbeing sleep actions", () => {
  it("keeps raw reasons visible for intentional tasks and allows undo", () => {
    const snapshot = getMockSnapshot();
    snapshot.sensors.sleep = { available: true, sampledAtMs: 1, blockers: [sleepBlocker(41, "Video Encoder")] };
    const toggle = vi.fn();
    render(<DeviceWellbeing sensors={snapshot.sensors} applications={[application()]} expectedSleepNames={new Set(["Video Encoder"])} onToggleExpectedSleep={toggle} />);
    fireEvent.click(screen.getByText("查看保持唤醒的任务"));
    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("阻止空闲休眠")).toBeTruthy();
    expect(screen.getByText("按计划保持唤醒")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /点击撤销/ }));
    expect(toggle).toHaveBeenCalledWith("Video Encoder");
  });
  it("opens the exact application process behind a sleep blocker", () => {
    const snapshot = getMockSnapshot();
    snapshot.sensors.sleep = {
      available: true,
      sampledAtMs: 1,
      blockers: [{
        pid: 41,
        processName: "Video Encoder",
        reason: "Encoding",
        kind: "idle_sleep",
        durationSeconds: 780,
      }],
    };
    const onInspectSleepBlocker = vi.fn();
    render(
      <DeviceWellbeing
        sensors={snapshot.sensors}
        applications={[application()]}
        onInspectSleepBlocker={onInspectSleepBlocker}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Video Encoder/ }));

    expect(onInspectSleepBlocker).toHaveBeenCalledWith("41:encoder");
  });

  it("keeps every sleep blocker actionable without stacking the card vertically", () => {
    const snapshot = getMockSnapshot();
    snapshot.sensors.sleep = {
      available: true,
      sampledAtMs: 1,
      blockers: [
        sleepBlocker(41, "Video Encoder"),
        sleepBlocker(42, "ChatGPT"),
        sleepBlocker(43, "File Sync"),
      ],
    };
    const onInspectSleepBlocker = vi.fn();
    const { container } = render(
      <DeviceWellbeing
        sensors={snapshot.sensors}
        applications={[
          application(41, "Video Encoder", "encoder"),
          application(42, "ChatGPT", "chatgpt"),
          application(43, "File Sync", "sync"),
        ]}
        onInspectSleepBlocker={onInspectSleepBlocker}
      />,
    );

    expect(
      container.querySelectorAll(".device-wellbeing__sleep-actions button"),
    ).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: /ChatGPT/ }));

    expect(onInspectSleepBlocker).toHaveBeenCalledWith("42:chatgpt");
  });
});

function sleepBlocker(pid: number, processName: string) {
  return {
    pid,
    processName,
    reason: "Active task",
    kind: "idle_sleep" as const,
    durationSeconds: 780,
  };
}

function application(
  pid = 41,
  name = "Video Encoder",
  birthToken = "encoder",
): ApplicationImpact {
  return {
    id: `user:${birthToken}`,
    name,
    processCount: 1,
    cpuPercent: 32,
    memoryBytes: 128 * 1_024 ** 2,
    diskBytesPerSecond: 0,
    systemComponent: false,
    representativeIdentity: `${pid}:${birthToken}`,
    actionIdentity: `${pid}:${birthToken}`,
    memberIdentities: [`${pid}:${birthToken}`],
    iconProcess: {
      pid,
      snapshotStartTime: 1,
      snapshotBirthToken: birthToken,
    },
  };
}
