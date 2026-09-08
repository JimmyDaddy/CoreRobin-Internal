import { readFileSync, readdirSync } from "node:fs";

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

  it("keeps chat conversations isolated from credentials and system commands", () => {
    const main = JSON.parse(read("src-tauri/capabilities/default.json"));
    const chat = JSON.parse(read("src-tauri/capabilities/robin-chat.json"));
    const companion = JSON.parse(read("src-tauri/capabilities/companion-position.json"));
    expect(main.windows).not.toContain("robin-chat");
    expect(chat.windows).toEqual(["robin-chat"]);
    for (const permission of ["allow-ai-get-session", "allow-ai-prepare", "allow-ai-start", "allow-ai-cancel", "allow-ai-resolve-tool-confirmation", "allow-ai-run-capability-action", "allow-ai-save-draft"]) {
      expect(chat.permissions).toContain(permission);
      expect(companion.permissions).not.toContain(permission);
    }
    const forbidden = /credential|save-connection|delete-connection|update-settings|test-model|list-models|snapshot|process-action|cleanup|toolbox|health-state/;
    expect(chat.permissions.filter((permission) => forbidden.test(permission))).toEqual([]);
    expect(companion.permissions).toContain("allow-toggle-ai-chat-window");
    const entry = read("src/surfaces/robin-chat.tsx");
    expect(entry).not.toMatch(/from ["']\.\.\/App["']/);
    expect(entry).toContain("LANGUAGE_STORAGE_KEY");
    expect(entry).toContain("APP_SETTINGS_STORAGE_KEY");
  });

  it("grants AI configuration and source cleanup only to the main local window across all capabilities", () => {
    const configuration = new Set([
      "allow-ai-open-help", "allow-ai-update-settings", "allow-ai-save-connection",
      "allow-ai-delete-connection", "allow-ai-set-credential", "allow-ai-delete-credential",
      "allow-ai-set-proxy-credential", "allow-ai-delete-proxy-credential",
      "allow-ai-list-models", "allow-ai-test-model", "allow-ai-clear-conversations",
      "allow-ai-clear-all-data", "allow-ai-invalidate-source", "allow-ai-finish-source-clear",
      "allow-ai-chat-get-navigation", "allow-ai-chat-ack-navigation",
      "allow-ai-pending-utility-requests", "allow-ai-claim-utility-request", "allow-ai-complete-utility-request",
    ]);
    const chatCommands = new Set([
      "allow-ai-get-state", "allow-ai-create-session", "allow-ai-list-sessions",
      "allow-ai-get-session", "allow-ai-set-session-context", "allow-ai-rename-session",
      "allow-ai-delete-session", "allow-ai-save-draft", "allow-ai-select-session-model",
      "allow-ai-prepare", "allow-ai-start", "allow-ai-cancel", "allow-ai-resolve-tool-confirmation", "allow-ai-run-capability-action",
      "allow-ai-chat-continue-in-main",
    ]);
    const seenConfiguration = new Set();
    for (const name of readdirSync("src-tauri/capabilities").filter((name) => name.endsWith(".json"))) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${name}`));
      const aiPermissions = capability.permissions
        .map((permission) => typeof permission === "string" ? permission : permission.identifier)
        .filter((permission) => permission.startsWith("allow-ai-"));
      if (!aiPermissions.length) continue;
      // A second capability must not silently grant a narrow window the same
      // commands that the primary chat manifest intentionally excludes.
      expect(capability.remote).toBeUndefined();
      expect(capability.local).not.toBe(false);
      expect(capability.webviews ?? []).toEqual([]);
      for (const permission of aiPermissions) {
        if (configuration.has(permission)) {
          expect(capability.windows).toEqual(["main"]);
          seenConfiguration.add(permission);
        } else {
          expect(chatCommands.has(permission), permission).toBe(true);
          expect(capability.windows.every((label) => label === "main" || label === "robin-chat")).toBe(true);
        }
      }
    }
    expect(seenConfiguration).toEqual(configuration);
  });
});
