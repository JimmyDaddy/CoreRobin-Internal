import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeRegex, runRegexInWorker } from "./regexTools";

class FakeRegexWorker {
  onmessage: ((event: MessageEvent<{ ok: boolean; value?: unknown; error?: string }>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(message: { pattern: string; flags: string; text: string; replacement: string }): void {
    try {
      const expression = new RegExp(message.pattern, message.flags.includes("g") ? message.flags : `${message.flags}g`);
      const matches: Array<{ index: number; text: string; groups: Record<string, string | undefined> }> = [];
      let match: RegExpExecArray | null;
      while ((match = expression.exec(message.text)) !== null && matches.length < 1_000) {
        matches.push({ index: match.index, text: match[0], groups: { ...(match.groups ?? {}) } });
        if (match[0] === "") expression.lastIndex += 1;
      }
      this.onmessage?.({ data: { ok: true, value: { matches, replacement: message.text.replace(new RegExp(message.pattern, message.flags), message.replacement) } } } as MessageEvent);
    } catch (error) {
      this.onmessage?.({ data: { ok: false, error: error instanceof Error ? error.message : "正则执行失败。" } } as MessageEvent);
    }
  }
  terminate(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("regex toolbox", () => {
  it("diagnoses syntax and produces an accessible structure", () => {
    vi.stubGlobal("Worker", FakeRegexWorker);
    const result = analyzeRegex("(?<name>a+)|(b*)", "u");
    expect(result.supported).toBe(true);
    expect(result.ast.children.some((node) => node.kind === "group")).toBe(true);
    expect(result.ast.children.some((node) => node.kind === "alternation")).toBe(true);
  });

  it("runs matches with zero-length progress and text replacement", async () => {
    vi.stubGlobal("Worker", FakeRegexWorker);
    const result = await runRegexInWorker("^|$", "g", "ab", "_");
    expect(result.matches.length).toBe(2);
    expect(result.replacement).toBe("_ab_");
  });

  it("fails safely without running regex on the main thread", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(runRegexInWorker("(a+)+$", "", "aaaaaaaa")).rejects.toMatchObject({ code: "regex_worker_unavailable" });
  });
});
