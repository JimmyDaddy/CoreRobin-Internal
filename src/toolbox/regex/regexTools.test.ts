import { describe, expect, it } from "vitest";
import { analyzeRegex, runRegexInWorker } from "./regexTools";

describe("regex toolbox", () => {
  it("diagnoses syntax and produces an accessible structure", () => {
    const result = analyzeRegex("(?<name>a+)|(b*)", "u");
    expect(result.supported).toBe(true);
    expect(result.ast.children.some((node) => node.kind === "group")).toBe(true);
    expect(result.ast.children.some((node) => node.kind === "alternation")).toBe(true);
  });

  it("runs matches with zero-length progress and text replacement", async () => {
    const result = await runRegexInWorker("^|$", "g", "ab", "_");
    expect(result.matches.length).toBe(2);
    expect(result.replacement).toBe("_ab_");
  });
});
