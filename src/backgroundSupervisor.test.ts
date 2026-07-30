import { describe, expect, it } from "vitest";

import { buildBackgroundSupervisorConfig } from "./backgroundSupervisor";
import { defaultAppSettings } from "./settings";

describe("background supervisor configuration", () => {
  it("sends only local rule identities, thresholds, and localized notification copy", () => {
    const settings = defaultAppSettings("zh-CN");
    settings.desktopNotificationsEnabled = true;
    settings.applicationWatchRules = [{
      id: "rule-1",
      applicationName: "Example",
      applicationId: "com.example.app",
      metric: "cpu",
      threshold: 80,
      durationSeconds: 30,
      enabled: true,
    }];

    const config = buildBackgroundSupervisorConfig(
      settings,
      "ready",
      (key) => `translated:${key}`,
    );

    expect(config.notificationPermissionGranted).toBe(true);
    expect(config.applicationWatchRules).toEqual(settings.applicationWatchRules);
    expect(config.copies.cpu.triggered.title).toBe(
      "translated:notifications:triggered.cpu.title",
    );
    expect(JSON.stringify(config)).not.toContain("command");
    expect(JSON.stringify(config)).not.toContain("path");
  });
});
