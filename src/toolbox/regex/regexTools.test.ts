import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeRegex, runRegexInWorker, type RegexAnalysis } from "./regexTools";

class FakeRegexWorker {
  onmessage: ((event: MessageEvent<{ ok: boolean; value?: unknown; analysis?: RegexAnalysis; code?: string; error?: string }>) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(message: { pattern: string; flags: string; text: string; replacement: string }): void {
    const ast = { id: 1, kind: "root" as const, label: "正则表达式", children: message.pattern.includes("(") ? [{ id: 2, kind: "group" as const, label: "(", children: [] }] : [] };
    try {
      const expression = new RegExp(message.pattern, message.flags.includes("g") ? message.flags : `${message.flags}g`);
      const matches: Array<{ index: number; text: string; groups: Record<string, string | undefined> }> = [];
      let match: RegExpExecArray | null;
      const unicode = message.flags.includes("u") || message.flags.includes("v");
      while ((match = expression.exec(message.text)) !== null && matches.length < 1_000) {
        matches.push({ index: match.index, text: match[0], groups: { ...(match.groups ?? {}) } });
        if (match[0] === "") expression.lastIndex = advanceStringIndex(message.text, expression.lastIndex, unicode);
      }
      this.onmessage?.({ data: { ok: true, value: { matches, replacement: message.text.replace(new RegExp(message.pattern, message.flags), message.replacement) }, analysis: { supported: true, syntaxError: null, ast, warnings: [] } } } as MessageEvent);
    } catch (error) {
      const syntaxError = error instanceof Error ? error.message : "正则语法无效。";
      this.onmessage?.({ data: { ok: false, code: "invalid_regex", error: syntaxError, analysis: { supported: false, syntaxError, ast, warnings: [] } } } as MessageEvent);
    }
  }

  terminate(): void {}
}

function advanceStringIndex(value: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  const second = value.charCodeAt(index + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("regex toolbox", () => {
  it("populates the accessible structure from the isolated parser", async () => {
    vi.stubGlobal("Worker", FakeRegexWorker);
    const analysis = analyzeRegex("(?<name>a+)|(b*)", "u");
    await runRegexInWorker("(?<name>a+)|(b*)", "u", "a");
    expect(analysis.supported).toBe(true);
    expect(analysis.ast.children.some((node) => node.kind === "group")).toBe(true);
  });

  it("runs matches with zero-length progress and text replacement", async () => {
    vi.stubGlobal("Worker", FakeRegexWorker);
    const result = await runRegexInWorker("^|$", "g", "ab", "_");
    expect(result.matches.length).toBe(2);
    expect(result.replacement).toBe("_ab_");
  });

  it("preserves invalid-regex errors from the isolated parser", async () => {
    vi.stubGlobal("Worker", FakeRegexWorker);
    const analysis = analyzeRegex("(");
    await expect(runRegexInWorker("(", "", "a")).rejects.toMatchObject({ code: "invalid_regex" });
    expect(analysis).toMatchObject({ supported: false, syntaxError: expect.any(String) });
  });

  it("fails safely without running regex on the main thread", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(runRegexInWorker("(a+)+$", "", "aaaaaaaa")).rejects.toMatchObject({ code: "regex_worker_unavailable" });
  });
});
