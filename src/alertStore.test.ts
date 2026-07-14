import { describe, expect, it, vi } from "vitest";

import {
  RESOURCE_ALERT_STORAGE_KEY,
  clearResourceAlertStorage,
  loadResourceAlertEvents,
  mergeResourceAlertEvents,
  parseResourceAlertEvents,
  saveResourceAlertEvents,
} from "./alertStore";
import type { ResourceAlertEvent } from "./resourceAlerts";

function event(
  timestamp: number,
  id = `cpu:triggered:${timestamp}`,
  resource: ResourceAlertEvent["resource"] = "cpu",
): ResourceAlertEvent {
  return {
    id,
    timestamp,
    resource,
    kind: "triggered",
    severity: "high",
    valuePercent: 75,
    thresholdPercent: 65,
    startedAtMs: timestamp - 10,
    durationMs: 10,
  };
}

describe("resource alert event storage", () => {
  it("merges, sorts, deduplicates, and applies history retention", () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const recent = event(now - 1_000);
    const replacement = { ...recent, valuePercent: 82 };
    const result = mergeResourceAlertEvents(
      [event(now - 2 * 24 * 60 * 60 * 1_000), recent],
      [replacement, event(now - 500, `memory:triggered:${now - 500}`, "memory")],
      now,
      1,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.valuePercent).toBe(82);
    expect(result[1]?.resource).toBe("memory");
    expect(result[1]?.id).toContain("memory");
  });

  it("rejects malformed and unsupported payloads", () => {
    const valid = event(1_000);
    expect(parseResourceAlertEvents("{")).toEqual([]);
    expect(
      parseResourceAlertEvents(JSON.stringify({ version: 2, events: [valid] })),
    ).toEqual([]);
    expect(
      parseResourceAlertEvents(
        JSON.stringify({ version: 1, events: [valid, { ...valid, resource: "gpu" }] }),
      ),
    ).toEqual([valid]);
  });

  it("persists, loads, and clears safely", () => {
    let stored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === RESOURCE_ALERT_STORAGE_KEY ? stored : null,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
        removeItem: () => {
          stored = null;
        },
      },
    });

    try {
      const saved = [event(1_000)];
      saveResourceAlertEvents(saved);
      expect(loadResourceAlertEvents()).toEqual(saved);
      clearResourceAlertStorage();
      expect(loadResourceAlertEvents()).toEqual([]);

      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => { throw new Error("blocked"); },
          setItem: () => { throw new Error("blocked"); },
          removeItem: () => { throw new Error("blocked"); },
        },
      });
      expect(loadResourceAlertEvents()).toEqual([]);
      expect(() => saveResourceAlertEvents(saved)).not.toThrow();
      expect(() => clearResourceAlertStorage()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
