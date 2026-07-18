import { describe, expect, it, vi } from "vitest";

import {
  APP_SETTINGS_STORAGE_KEY,
  defaultAppSettings,
  loadAppSettings,
  parseAppSettings,
  saveAppSettings,
  systemSamplingPreset,
} from "./settings";

describe("application settings", () => {
  it("maps readable sampling presets while preserving advanced intervals", () => {
    expect(systemSamplingPreset(5_000)).toBe("lowPower");
    expect(systemSamplingPreset(1_000)).toBe("balanced");
    expect(systemSamplingPreset(500)).toBe("realtime");
    expect(systemSamplingPreset(2_000)).toBe("custom");
  });
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
          experienceMode: "professional",
          systemSampleIntervalMs: 2_000,
          connectionRefreshIntervalMs: 10_000,
          usageThresholds: [40, 70, 90],
          defaultProcessView: "tree",
          historyPersistenceEnabled: false,
          historyApplicationNamesEnabled: true,
          historyRetentionDays: 30,
          networkConnectionHistoryEnabled: true,
          networkConnectionHistoryRetentionDays: 7,
          applicationWatchRules: [{
            id: "browser-cpu",
            applicationName: "Browser",
            metric: "cpu",
            threshold: 80,
            durationSeconds: 30,
            enabled: true,
          }],
          desktopNotificationsEnabled: true,
          mutedNotificationResources: ["cpu"],
          interfaceScale: "large",
          reduceMotion: true,
          showDockIcon: true,
          launchAtLogin: true,
          companionAlwaysOnTop: true,
          companionShowOnStartup: true,
        }),
      ),
    ).toEqual({
      version: 1,
      language: "en",
      experienceMode: "professional",
      systemSampleIntervalMs: 2_000,
      connectionRefreshIntervalMs: 10_000,
      usageThresholds: [40, 70, 90],
      defaultProcessView: "tree",
      historyPersistenceEnabled: false,
      historyApplicationNamesEnabled: true,
      historyRetentionDays: 30,
      networkConnectionHistoryEnabled: true,
      networkConnectionHistoryRetentionDays: 7,
      applicationWatchRules: [{
        id: "browser-cpu",
        applicationName: "Browser",
        metric: "cpu",
        threshold: 80,
        durationSeconds: 30,
        enabled: true,
      }],
      desktopNotificationsEnabled: true,
      mutedNotificationResources: ["cpu"],
      interfaceScale: "large",
      reduceMotion: true,
      showDockIcon: true,
      launchAtLogin: true,
      companionAlwaysOnTop: true,
      companionShowOnStartup: true,
    });

    expect(
      parseAppSettings(
        JSON.stringify({
          version: 1,
          language: "it",
          experienceMode: "expert",
          systemSampleIntervalMs: 42,
          connectionRefreshIntervalMs: 42,
          usageThresholds: [90, 70, 40],
          defaultProcessView: "graph",
        }),
        "en",
      ),
    ).toEqual(defaultAppSettings("en"));
  });

  it("migrates existing version 1 preferences to simple mode", () => {
    const legacy = {
      ...defaultAppSettings("en"),
      experienceMode: undefined,
    };
    expect(parseAppSettings(JSON.stringify(legacy), "en").experienceMode).toBe(
      "simple",
    );
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
