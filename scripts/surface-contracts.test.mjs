import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");

describe("desktop surface contracts", () => {
  it("keeps theme and language storage synchronization on every auxiliary entry", () => {
    const bootstrap = read("src/surfaces/bootstrapAuxiliarySurface.tsx");
    const splash = read("src/surfaces/splash.ts");
    for (const source of [bootstrap, splash]) {
      expect(source).toContain("APP_SETTINGS_STORAGE_KEY");
      expect(source).toContain("LANGUAGE_STORAGE_KEY");
      expect(source).toContain('window.addEventListener("storage"');
      expect(source).toContain("applyAppAppearance(loadAppAppearance())");
      expect(source).toContain("changeAuxiliaryLanguage(initialLanguage())");
    }
  });

  it("keeps the retained health-state schema and event aligned across Rust and TypeScript", () => {
    const frontend = read("src/healthState.ts");
    const backend = read("src-tauri/src/health_state.rs");
    const frontendVersion = frontend.match(/HEALTH_STATE_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
    const backendVersion = backend.match(/HEALTH_STATE_SCHEMA_VERSION:\s*u16\s*=\s*(\d+)/)?.[1];
    const frontendEvent = frontend.match(/HEALTH_STATE_EVENT\s*=\s*"([^"]+)"/)?.[1];
    const backendEvent = backend.match(/HEALTH_STATE_EVENT:\s*&str\s*=\s*"([^"]+)"/)?.[1];
    expect(frontendVersion).toBeTruthy();
    expect(frontendVersion).toBe(backendVersion);
    expect(frontendEvent).toBeTruthy();
    expect(frontendEvent).toBe(backendEvent);
  });

  it("allows only main to publish while tray and companion can read retained health state", () => {
    const main = JSON.parse(read("src-tauri/capabilities/default.json"));
    const tray = JSON.parse(read("src-tauri/capabilities/auxiliary-windows.json"));
    const companion = JSON.parse(read("src-tauri/capabilities/companion-position.json"));
    expect(main.permissions).toContain("allow-publish-health-state");
    for (const capability of [main, tray, companion]) {
      expect(capability.permissions).toContain("allow-get-health-state");
    }
    expect(tray.permissions).not.toContain("allow-publish-health-state");
    expect(companion.permissions).not.toContain("allow-publish-health-state");
  });
});
