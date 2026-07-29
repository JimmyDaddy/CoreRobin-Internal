import { describe, expect, it } from "vitest";

import { defaultAppSettings } from "./settings";
import {
  createSettingsTransferDocument,
  parseSettingsTransferDocument,
  serializeSettingsTransferDocument,
} from "./settingsTransfer";

describe("settings transfer", () => {
  it("exports only preferences and application watch rules", () => {
    const settings = defaultAppSettings("en");
    settings.applicationWatchRules = [{
      id: "watch-1",
      applicationName: "Example",
      applicationId: "bundle:com.example.app",
      metric: "cpu",
      threshold: 80,
      durationSeconds: 30,
      enabled: true,
    }];
    const serialized = serializeSettingsTransferDocument(
      createSettingsTransferDocument(settings, new Date(0)),
    );
    expect(serialized).toContain('"preferences"');
    expect(serialized).toContain('"applicationWatchRules"');
    expect(serialized).not.toContain("connectionHistoryEntries");
    expect(serialized).not.toContain("filePaths");
  });

  it("previews changed settings before applying", () => {
    const current = defaultAppSettings("en");
    const imported = { ...current, reduceMotion: true };
    const preview = parseSettingsTransferDocument(JSON.stringify({
      format: "core-robin-preferences",
      schemaVersion: 1,
      exportedAt: new Date(0).toISOString(),
      preferences: imported,
    }), current);
    expect(preview.changedKeys).toEqual(["reduceMotion"]);
  });

  it("rejects unrelated JSON", () => {
    expect(() => parseSettingsTransferDocument("{}", defaultAppSettings()))
      .toThrow("settings_transfer_invalid");
  });

  it("rejects a branded document without a valid preferences payload", () => {
    expect(() => parseSettingsTransferDocument(JSON.stringify({
      format: "core-robin-preferences",
      schemaVersion: 1,
      exportedAt: new Date(0).toISOString(),
      preferences: {},
    }), defaultAppSettings())).toThrow("settings_transfer_invalid");
  });
});
