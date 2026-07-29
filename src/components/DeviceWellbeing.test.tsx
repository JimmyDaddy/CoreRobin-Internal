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
});

function application(): ApplicationImpact {
  return {
    id: "user:video-encoder",
    name: "Video Encoder",
    processCount: 1,
    cpuPercent: 32,
    memoryBytes: 128 * 1_024 ** 2,
    diskBytesPerSecond: 0,
    systemComponent: false,
    representativeIdentity: "41:encoder",
    actionIdentity: "41:encoder",
    memberIdentities: ["41:encoder"],
    iconProcess: {
      pid: 41,
      snapshotStartTime: 1,
      snapshotBirthToken: "encoder",
    },
  };
}
