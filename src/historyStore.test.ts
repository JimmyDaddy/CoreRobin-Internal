import { describe, expect, it, vi } from "vitest";

import {
  PERSISTENT_HISTORY_BUCKET_MS,
  PERSISTENT_HISTORY_STORAGE_KEY,
  clearPersistentHistoryStorage,
  loadPersistentHistory,
  mergePersistentHistory,
  parsePersistentHistory,
  savePersistentHistory,
} from "./historyStore";
import type { HistoryPoint } from "./types";

function point(timestamp: number, cpuPercent = 10): HistoryPoint {
  return {
    timestamp,
    cpuPercent,
    memoryPercent: 50,
    diskReadBytesPerSecond: 100,
    diskWriteBytesPerSecond: 50,
    networkReceivedBytesPerSecond: 200,
    networkTransmittedBytesPerSecond: 75,
  };
}

describe("persistent resource history", () => {
  it("keeps the latest valid point in each five-minute bucket", () => {
    const now = 10 * PERSISTENT_HISTORY_BUCKET_MS;
    const merged = mergePersistentHistory(
      [point(now - PERSISTENT_HISTORY_BUCKET_MS - 10_000, 20)],
      [point(now - 20_000, 30), point(now - 10_000, 40)],
      now,
      1,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]?.cpuPercent).toBe(40);
  });

  it("drops expired, future, malformed, and unsupported data", () => {
    const now = 40 * 24 * 60 * 60 * 1_000;
    const merged = mergePersistentHistory(
      [point(now - 2 * 24 * 60 * 60 * 1_000), point(now + 1)],
      [point(now - 1_000)],
      now,
      1,
    );
    expect(merged).toEqual([point(now - 1_000)]);

    expect(parsePersistentHistory("{")).toEqual([]);
    expect(parsePersistentHistory(JSON.stringify({ version: 2, points: [] }))).toEqual([]);
    expect(
      parsePersistentHistory(
        JSON.stringify({ version: 1, points: [point(now), { timestamp: now }] }),
      ),
    ).toEqual([point(now)]);
  });

  it("persists, loads, and clears safely", () => {
    let stored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === PERSISTENT_HISTORY_STORAGE_KEY ? stored : null,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
        removeItem: () => {
          stored = null;
        },
      },
    });

    try {
      const saved = [point(PERSISTENT_HISTORY_BUCKET_MS)];
      savePersistentHistory(saved);
      expect(loadPersistentHistory()).toEqual(saved);
      clearPersistentHistoryStorage();
      expect(loadPersistentHistory()).toEqual([]);

      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => { throw new Error("blocked"); },
          setItem: () => { throw new Error("blocked"); },
          removeItem: () => { throw new Error("blocked"); },
        },
      });
      expect(loadPersistentHistory()).toEqual([]);
      expect(() => savePersistentHistory(saved)).not.toThrow();
      expect(() => clearPersistentHistoryStorage()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
