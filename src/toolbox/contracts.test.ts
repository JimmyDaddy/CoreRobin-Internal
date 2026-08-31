import { describe, expect, it } from "vitest";

import {
  TOOLBOX_CONTRACT_VERSION,
  acceptsRevision,
  isTerminalJobStatus,
  isTerminalSessionStatus,
} from "./contracts";
import { getToolDefinition, TOOL_DEFINITIONS, searchTools } from "./registry";

describe("toolbox contract", () => {
  it("freezes the complete tool id inventory without duplicate ids", () => {
    expect(TOOLBOX_CONTRACT_VERSION).toBe("toolbox-v1");
    expect(TOOL_DEFINITIONS).toHaveLength(35);
    expect(new Set(TOOL_DEFINITIONS.map((tool) => tool.id)).size).toBe(35);
  });

  it("matches only user-facing metadata, never a tool input", () => {
    expect(searchTools("BSDIFF").map((tool) => tool.id)).toContain("binary-patch-create");
    expect(searchTools("secret input that is not a title")).toHaveLength(0);
  });

  it("does not let a native helper label disable browser-local tools", () => {
    const staleNativeCapability = { state: "unavailable" as const, reason: "Native helper missing.", platform: "macOS" };
    expect(getToolDefinition("json", { json: staleNativeCapability }).capability.state).toBe("available");
    expect(getToolDefinition("ifconfig-parser", { "ifconfig-parser": staleNativeCapability }).capability.state).toBe("available");
    expect(getToolDefinition("keyboard-cleaning", { "keyboard-cleaning": staleNativeCapability }).capability).toEqual(staleNativeCapability);
  });

  it("rejects stale service revisions and identifies terminal states", () => {
    const snapshot = {
      serviceInstanceId: "one",
      revision: 4,
    };
    expect(acceptsRevision(snapshot as never, {
      revision: 3,
      serviceInstanceId: "one",
    } as never)).toBe(false);
    expect(acceptsRevision(snapshot as never, {
      revision: 5,
      serviceInstanceId: "two",
    } as never)).toBe(false);
    expect(acceptsRevision(snapshot as never, {
      revision: 4,
      serviceInstanceId: "one",
    } as never)).toBe(true);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalSessionStatus("ended")).toBe(true);
  });
});
