import { describe, expect, it } from "vitest";

import { analyzeUrl, convertIsoTime, decodeBase64, encodeBase64 } from "./encodingTools";

describe("encoding toolbox", () => {
  it("keeps repeated URL query keys and plus signs literal", () => {
    expect(analyzeUrl("https://example.test/?a=1&a=two+words").query).toEqual([["a", "1"], ["a", "two+words"]]);
  });

  it("round trips Unicode in standard and URL-safe Base64", () => {
    const value = "CoreRobin 工具箱 ✓";
    expect(decodeBase64(encodeBase64(value))).toBe(value);
    expect(decodeBase64(encodeBase64(value, true), true)).toBe(value);
  });

  it("requires an explicit ISO timezone", () => {
    expect(() => convertIsoTime("2026-08-31T12:00:00")).toThrow();
    expect(convertIsoTime("2026-08-31T12:00:00+08:00").milliseconds).toBe("1788148800000");
  });
});
