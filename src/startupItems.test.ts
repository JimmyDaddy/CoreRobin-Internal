import { describe, expect, it } from "vitest";

import {
  filterStartupItems,
  startupAdvice,
  startupImpactLevel,
  startupRuntimeApplication,
} from "./startupItems";
import type { ApplicationImpact } from "./diagnosis";
import type { StartupItem } from "./types";

function item(update: Partial<StartupItem> = {}): StartupItem {
  return {
    id: "third-party",
    name: "Cloud Sync",
    publisher: "Example",
    command: "/Applications/Cloud Sync.app",
    path: "~/Library/LaunchAgents/example.plist",
    source: "launch_agent",
    scope: "user",
    enabled: true,
    system: false,
    launchKind: "login",
    managementStatus: "available",
    ...update,
  };
}

describe("startup item guidance", () => {
  it("only recommends reviewing enabled third-party login items", () => {
    expect(startupAdvice(item())).toBe("review");
    expect(startupAdvice(item({ launchKind: "conditional" }))).toBe("normal");
    expect(startupAdvice(item({ system: true, scope: "system" }))).toBe("system");
    expect(startupAdvice(item({ enabled: false }))).toBe("disabled");
  });

  it("filters by advice, system ownership, and text", () => {
    const items = [item(), item({ id: "system", name: "Update Service", system: true, scope: "system" })];
    expect(filterStartupItems(items, "review", "")).toHaveLength(1);
    expect(filterStartupItems(items, "system", "update")).toMatchObject([{ id: "system" }]);
  });

  it("matches a running application and explains its current background impact", () => {
    const applications: ApplicationImpact[] = [{
      id: "tester:cloud-sync",
      name: "Cloud Sync",
      processCount: 2,
      cpuPercent: 42,
      memoryBytes: 2 * 1_024 ** 3,
      diskBytesPerSecond: 0,
      systemComponent: false,
      representativeIdentity: "1:test",
      actionIdentity: "1:test",
      memberIdentities: ["1:test"],
      iconProcess: { pid: 1, snapshotStartTime: 1, snapshotBirthToken: "test" },
    }];
    const running = startupRuntimeApplication(item(), applications);
    expect(running?.name).toBe("Cloud Sync");
    expect(startupImpactLevel(item(), running, 16 * 1_024 ** 3)).toBe("moderate");
    expect(startupImpactLevel(item({ enabled: false }), running, 16 * 1_024 ** 3)).toBe("none");
  });
});
