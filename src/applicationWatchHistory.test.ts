/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import {
  APPLICATION_WATCH_HISTORY_STORAGE_KEY,
  createApplicationWatchHistoryEvent,
  loadApplicationWatchHistory,
  mergeApplicationWatchHistory,
} from "./applicationWatchHistory";
import type { ApplicationWatchRule } from "./settings";

const rule: ApplicationWatchRule = {
  id: "browser-cpu",
  applicationName: "Browser",
  metric: "cpu",
  threshold: 80,
  durationSeconds: 30,
  enabled: true,
};

beforeEach(() => window.localStorage.clear());

describe("application watch history", () => {
  it("redacts application names unless the user opted in", () => {
    expect(createApplicationWatchHistoryEvent(
      rule,
      "triggered",
      92,
      199_999_000,
      false,
    ).applicationName).toBeNull();
    expect(createApplicationWatchHistoryEvent(
      rule,
      "recovered",
      20,
      20_000,
      true,
    ).applicationName).toBe("Browser");
  });

  it("drops expired, future, duplicate, and malformed records", () => {
    const valid = createApplicationWatchHistoryEvent(
      rule,
      "triggered",
      92,
      199_999_000,
      true,
    );
    const merged = mergeApplicationWatchHistory(
      [
        valid,
        { ...valid, id: "expired", timestamp: 100_000_000 },
        { ...valid, id: "future", timestamp: 200_000_001 },
      ],
      [{ ...valid, value: 95 }],
      200_000_000,
      1,
    );
    expect(merged).toEqual([{ ...valid, value: 95 }]);

    window.localStorage.setItem(
      APPLICATION_WATCH_HISTORY_STORAGE_KEY,
      JSON.stringify([valid, { id: "invalid" }]),
    );
    expect(loadApplicationWatchHistory()).toEqual([valid]);
  });
});
