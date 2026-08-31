import { describe, expect, it } from "vitest";

import { analyzeJson } from "./jsonTools";
import { ToolboxInputError } from "./toolboxErrors";

describe("lossless JSON toolbox", () => {
  it("keeps number text, order, and duplicate-key diagnostics", () => {
    const result = analyzeJson('{"big":9007199254740993,"big":1,"nested":[true,null]}', 2);
    expect(result.formatted).toContain("9007199254740993");
    expect(result.formatted.indexOf('"big"')).toBeLessThan(result.formatted.indexOf('"nested"'));
    expect(result.duplicateKeys).toEqual(["big"]);
  });

  it("reports strict JSON syntax locations and rejects JSON5", () => {
    expect(() => analyzeJson("{foo: 1}")).toThrow(ToolboxInputError);
    expect(() => analyzeJson("{\n  \"foo\": 1,\n}")).toThrow(ToolboxInputError);
  });
});
