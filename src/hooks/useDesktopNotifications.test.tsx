/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_NOTIFICATION_LOG_KEY,
} from "../desktopNotifications";
import type { ResourceAlertEvent } from "../resourceAlerts";
import { useDesktopNotifications } from "./useDesktopNotifications";

const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
  onAction: vi.fn(async () => ({ unregister: vi.fn() })),
}));

vi.mock("@tauri-apps/plugin-notification", () => notification);
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, isDesktopRuntime: () => true };
});

beforeEach(() => {
  window.localStorage.clear();
  notification.sendNotification.mockReset();
  notification.isPermissionGranted.mockClear();
});

describe("useDesktopNotifications", () => {
  it("charges the daily budget only after the notification API accepts delivery", async () => {
    const first = alertEvent("memory:first", 100);
    const second = alertEvent("memory:second", 200);
    const { result, rerender } = renderHook(
      ({ events }) => useDesktopNotifications(
        events,
        true,
        "zh-CN",
        [],
        () => undefined,
      ),
      { initialProps: { events: [] as ResourceAlertEvent[] } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    notification.sendNotification.mockImplementationOnce(() => {
      throw new Error("system rejected notification");
    });
    rerender({ events: [first] });

    await waitFor(() =>
      expect(result.current.delivery?.status).toBe("failed")
    );
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATION_LOG_KEY)).toBeNull();

    notification.sendNotification.mockImplementation(() => undefined);
    rerender({ events: [first, second] });

    await waitFor(() =>
      expect(result.current.delivery?.status).toBe("sent")
    );
    expect(JSON.parse(
      window.localStorage.getItem(DESKTOP_NOTIFICATION_LOG_KEY) ?? "[]",
    )).toHaveLength(1);

    await act(async () => {
      expect(await result.current.sendTest()).toBe(true);
    });
    expect(result.current.delivery?.kind).toBe("test");
  });
});

function alertEvent(id: string, timestamp: number): ResourceAlertEvent {
  return {
    id,
    timestamp,
    resource: "memory",
    kind: "triggered",
    severity: "high",
    valuePercent: 88,
    thresholdPercent: 65,
    startedAtMs: timestamp - 60_000,
    durationMs: 60_000,
  };
}
