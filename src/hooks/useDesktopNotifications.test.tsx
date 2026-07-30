/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResourceAlertEvent } from "../resourceAlerts";
import { useDesktopNotifications } from "./useDesktopNotifications";

const eventBridge = vi.hoisted(() => ({
  listener: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
}));
const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
  onAction: vi.fn(async () => ({ unregister: vi.fn() })),
}));

vi.mock("@tauri-apps/plugin-notification", () => notification);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (
    _event: string,
    listener: (event: { payload: unknown }) => void,
  ) => {
    eventBridge.listener = listener;
    return eventBridge.unlisten;
  }),
}));
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, isDesktopRuntime: () => true };
});

beforeEach(() => {
  window.localStorage.clear();
  notification.sendNotification.mockReset();
  notification.isPermissionGranted.mockClear();
  eventBridge.listener = null;
  eventBridge.unlisten.mockReset();
});

describe("useDesktopNotifications", () => {
  it("uses native supervisor deliveries on desktop without duplicating resource notifications", async () => {
    const first = alertEvent("memory:first", 100);
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
    rerender({ events: [first] });
    expect(notification.sendNotification).not.toHaveBeenCalled();
    act(() => {
      eventBridge.listener?.({
        payload: {
          kind: "resource",
          status: "sent",
          attemptedAtMs: 500,
        },
      });
    });
    expect(result.current.delivery).toEqual({
      kind: "resource",
      status: "sent",
      attemptedAtMs: 500,
    });

    notification.sendNotification.mockImplementation(() => undefined);
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
