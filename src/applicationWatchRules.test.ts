import { describe, expect, it } from "vitest";

import {
  applicationWatchSamplingIntervalMs,
  evaluateApplicationWatchRules,
} from "./applicationWatchRules";
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
    expect(second.events[0]?.kind).toBe("triggered");

    const recovered = evaluateApplicationWatchRules(
      second.states,
      [rule],
      [{ ...application, cpuPercent: 20 }],
      16_000,
    );
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0]?.kind).toBe("recovered");
    expect(recovered.states.get(rule.id)?.active).toBe(false);
  });

  it("uses an adaptive hidden sampling interval only while a rule is enabled", () => {
    const rule: ApplicationWatchRule = {
      id: "one",
      applicationName: "Browser",
      metric: "cpu",
      threshold: 80,
      durationSeconds: 10,
      enabled: true,
    };
    expect(applicationWatchSamplingIntervalMs([rule])).toBe(5_000);
    expect(applicationWatchSamplingIntervalMs([
      { ...rule, durationSeconds: 300 },
    ])).toBe(10_000);
    expect(applicationWatchSamplingIntervalMs([
      { ...rule, enabled: false },
    ])).toBeNull();
  });
});
