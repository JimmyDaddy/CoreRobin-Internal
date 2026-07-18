import { describe, expect, it } from "vitest";

import { evaluateApplicationWatchRules } from "./applicationWatchRules";
import type { ApplicationImpact } from "./diagnosis";
import type { ApplicationWatchRule } from "./settings";

describe("application watch rules", () => {
  it("triggers only after the configured sustained duration", () => {
    const rule: ApplicationWatchRule = { id: "one", applicationName: "Browser", metric: "cpu", threshold: 80, durationSeconds: 10, enabled: true };
    const application = { name: "Browser", cpuPercent: 90 } as ApplicationImpact;
    const first = evaluateApplicationWatchRules(new Map(), [rule], [application], 1_000);
    const second = evaluateApplicationWatchRules(first.states, [rule], [application], 11_000);
    expect(first.events).toHaveLength(0);
    expect(second.events).toHaveLength(1);
  });
});
