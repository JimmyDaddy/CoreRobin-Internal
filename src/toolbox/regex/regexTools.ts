import { ToolboxInputError } from "../local/toolboxErrors";
import { utf8ByteLength } from "../local/jsonTools";

const MAX_PATTERN_BYTES = 16 * 1024;
const MAX_SAMPLE_BYTES = 256 * 1024;

export interface RegexNode {
  id: number;
  kind: "root" | "group" | "alternation" | "character-class" | "quantifier" | "literal" | "escape";
  label: string;
  children: RegexNode[];
}

export interface RegexAnalysis {
  supported: boolean;
  syntaxError: string | null;
  ast: RegexNode;
  warnings: string[];
}

export interface RegexMatch {
  index: number;
  text: string;
  groups: Record<string, string | undefined>;
}

interface RegexWorkerResponse {
  ok: boolean;
  value?: { matches: RegexMatch[]; replacement: string };
  analysis?: RegexAnalysis;
  code?: string;
  error?: string;
}

const pendingAnalyses = new Map<string, Set<RegexAnalysis>>();

/**
 * Prepares a view model for the synchronous toolbox surface. The actual parse,
 * syntax check, and AST construction happen in the terminable Worker started by
 * runRegexInWorker; completing that operation updates this object in place.
 */
export function analyzeRegex(pattern: string, flags = ""): RegexAnalysis {
  if (utf8ByteLength(pattern) > MAX_PATTERN_BYTES) throw new ToolboxInputError("regex_too_large", "正则表达式不能超过 16 KiB。 ");
  const analysis: RegexAnalysis = {
    supported: true,
    syntaxError: null,
    ast: { id: 1, kind: "root", label: "正则表达式", children: [] },
    warnings: [],
  };
  const key = analysisKey(pattern, flags);
  const waiting = pendingAnalyses.get(key) ?? new Set<RegexAnalysis>();
  waiting.add(analysis);
  pendingAnalyses.set(key, waiting);
  return analysis;
}

export async function runRegexInWorker(pattern: string, flags: string, text: string, replacement = ""): Promise<{ matches: RegexMatch[]; replacement: string }> {
  try {
    assertRegexWorkerAvailable();
    if (utf8ByteLength(text) > MAX_SAMPLE_BYTES) throw new ToolboxInputError("regex_text_too_large", "测试文本不能超过 256 KiB。 ");
  } catch (error) {
    discardPendingAnalysis(pattern, flags);
    throw error;
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./regex.worker.ts", import.meta.url), { type: "module" });
    } catch {
      discardPendingAnalysis(pattern, flags);
      reject(new ToolboxInputError("regex_worker_unavailable", "正则执行 Worker 无法启动，已安全禁用正则执行。 "));
      return;
    }

    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      discardPendingAnalysis(pattern, flags);
      reject(new ToolboxInputError("regex_timeout", "正则执行超过 2 秒，已停止。 "));
    }, 2_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.terminate();
      callback();
    };

    worker.onmessage = (event: MessageEvent<RegexWorkerResponse>) => {
      const response = event.data;
      if (response.analysis) settlePendingAnalysis(pattern, flags, response.analysis);
      else discardPendingAnalysis(pattern, flags);
      if (response.ok && response.value) finish(() => resolve(response.value!));
      else finish(() => reject(new ToolboxInputError(response.code ?? "regex_failed", response.error ?? "正则执行失败。 ")));
    };
    worker.onerror = () => finish(() => {
      discardPendingAnalysis(pattern, flags);
      reject(new ToolboxInputError("regex_failed", "正则执行线程不可用。 "));
    });
    worker.postMessage({ pattern, flags, text, replacement });
  });
}

function assertRegexWorkerAvailable(): void {
  if (typeof Worker !== "function") throw new ToolboxInputError("regex_worker_unavailable", "当前 WebView 不支持隔离正则 Worker，已安全禁用正则执行。 ");
}

function analysisKey(pattern: string, flags: string): string {
  return `${flags.length}:${flags}${pattern}`;
}

function settlePendingAnalysis(pattern: string, flags: string, next: RegexAnalysis): void {
  const key = analysisKey(pattern, flags);
  const waiting = pendingAnalyses.get(key);
  pendingAnalyses.delete(key);
  for (const analysis of waiting ?? []) {
    analysis.supported = next.supported;
    analysis.syntaxError = next.syntaxError;
    analysis.ast = next.ast;
    analysis.warnings = next.warnings;
  }
}

function discardPendingAnalysis(pattern: string, flags: string): void {
  pendingAnalyses.delete(analysisKey(pattern, flags));
}
