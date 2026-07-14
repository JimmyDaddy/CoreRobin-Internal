import { describe, expect, it, vi } from "vitest";

import {
  APP_SETTINGS_STORAGE_KEY,
  defaultAppSettings,
  loadAppSettings,
  parseAppSettings,
  saveAppSettings,
} from "./settings";

describe("application settings", () => {
  it("uses language-aware defaults for missing and unsupported settings", () => {
    expect(parseAppSettings(null, "en")).toEqual(defaultAppSettings("en"));
    expect(parseAppSettings("{", "en")).toEqual(defaultAppSettings("en"));
    expect(parseAppSettings(JSON.stringify({ version: 2 }), "en")).toEqual(
      defaultAppSettings("en"),
    );
  });

  it("keeps valid preferences and rejects unsupported values", () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 1,
          language: "en",
          systemSampleIntervalMs: 2_000,
          connectionRefreshIntervalMs: 10_000,
          usageThresholds: [40, 70, 90],
          defaultProcessView: "tree",
          historyPersistenceEnabled: false,
          historyRetentionDays: 30,
        }),
      ),
    ).toEqual({
      version: 1,
      language: "en",
      systemSampleIntervalMs: 2_000,
      connectionRefreshIntervalMs: 10_000,
      usageThresholds: [40, 70, 90],
      defaultProcessView: "tree",
      historyPersistenceEnabled: false,
      historyRetentionDays: 30,
    });

    expect(
      parseAppSettings(
        JSON.stringify({
          version: 1,
          language: "fr",
          systemSampleIntervalMs: 42,
          connectionRefreshIntervalMs: 42,
          usageThresholds: [90, 70, 40],
          defaultProcessView: "graph",
        }),
        "en",
      ),
    ).toEqual(defaultAppSettings("en"));
  });

  it("sanitizes persisted settings and survives blocked storage", () => {
    let stored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === APP_SETTINGS_STORAGE_KEY ? stored : null,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });

    try {
      saveAppSettings({
        ...defaultAppSettings("en"),
        systemSampleIntervalMs: 42,
      });
      expect(loadAppSettings("en")).toEqual(defaultAppSettings("en"));

      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => {
            throw new Error("storage blocked");
          },
          setItem: () => {
            throw new Error("storage blocked");
          },
        },
      });
      expect(loadAppSettings("en")).toEqual(defaultAppSettings("en"));
      expect(() => saveAppSettings(defaultAppSettings("en"))).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
