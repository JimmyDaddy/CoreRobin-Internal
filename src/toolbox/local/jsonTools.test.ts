import { describe, expect, it } from "vitest";

import { analyzeJson, MAX_JSON_DEPTH, MAX_JSON_NODES } from "./jsonTools";
import { ToolboxInputError } from "./toolboxErrors";

function inputError(action: () => unknown): ToolboxInputError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolboxInputError);
    return error as ToolboxInputError;
  }
  throw new Error("Expected ToolboxInputError");
}

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

  it("rejects nesting beyond the limit while parsing, before recursive rendering", () => {
    const withinLimit = `${"[".repeat(MAX_JSON_DEPTH)}0${"]".repeat(MAX_JSON_DEPTH)}`;
    expect(analyzeJson(withinLimit).depth).toBe(MAX_JSON_DEPTH);

    const tooDeep = `${"[".repeat(MAX_JSON_DEPTH + 1)}0${"]".repeat(MAX_JSON_DEPTH + 1)}`;
    const error = inputError(() => analyzeJson(tooDeep));
    expect(error.code).toBe("json_too_deep");
    expect(error.message).toContain(`不能超过 ${MAX_JSON_DEPTH} 层`);
  });

  it("rejects excessive nodes during parsing instead of truncating the result", () => {
    const tooManyNodes = `[${"0,".repeat(MAX_JSON_NODES)}0]`;
    const error = inputError(() => analyzeJson(tooManyNodes));
    expect(error.code).toBe("invalid_json");
    expect(error.message).toContain("JSON 结构过大");
  });
});
