import { ToolboxInputError } from "../local/toolboxErrors";
import { utf8ByteLength } from "../local/jsonTools";

const MAX_PATTERN_BYTES = 16 * 1024;
const MAX_SAMPLE_BYTES = 256 * 1024;
const MAX_MATCHES = 1_000;

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

export function analyzeRegex(pattern: string, flags = ""): RegexAnalysis {
  if (utf8ByteLength(pattern) > MAX_PATTERN_BYTES) throw new ToolboxInputError("regex_too_large", "正则表达式不能超过 16 KiB。 ");
  let syntaxError: string | null = null;
  try { new RegExp(pattern, flags); } catch (error) { syntaxError = error instanceof Error ? error.message : "正则语法无效。"; }
  const warnings: string[] = [];
  if (/\([^?]*\+[^)]*\)[+*{]/.test(pattern) || /\([^?]*\*[^)]*\)[+*{]/.test(pattern)) warnings.push("检测到嵌套重复，可能带来回溯开销；这不是 ReDoS 安全证明。 ");
  if (/(?:^|[^\\])(?:\^|\$)?\([^)]*\|[^)]*\)/.test(pattern)) warnings.push("分支结构已标记；图形解释语法关系，不代表引擎逐步回溯轨迹。 ");
  return { supported: syntaxError === null, syntaxError, ast: buildRegexAst(pattern), warnings };
}

export async function runRegexInWorker(pattern: string, flags: string, text: string, replacement = ""): Promise<{ matches: RegexMatch[]; replacement: string }> {
  if (utf8ByteLength(text) > MAX_SAMPLE_BYTES) throw new ToolboxInputError("regex_text_too_large", "测试文本不能超过 256 KiB。 ");
  const analysis = analyzeRegex(pattern, flags);
  if (!analysis.supported) throw new ToolboxInputError("invalid_regex", analysis.syntaxError ?? "正则语法无效。 ");
  if (typeof Worker === "undefined") return runRegexLocally(pattern, flags, text, replacement);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./regex.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const timeout = window.setTimeout(() => {
      worker.terminate();
      settled = true;
      reject(new ToolboxInputError("regex_timeout", "正则执行超过 2 秒，已停止。 "));
    }, 2_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker.terminate();
      callback();
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value?: { matches: RegexMatch[]; replacement: string }; error?: string }>) => {
      if (event.data.ok && event.data.value) finish(() => resolve(event.data.value!));
      else finish(() => reject(new ToolboxInputError("regex_failed", event.data.error ?? "正则执行失败。 ")));
    };
    worker.onerror = () => finish(() => reject(new ToolboxInputError("regex_failed", "正则执行线程不可用。 ")));
    worker.postMessage({ pattern, flags, text, replacement });
  });
}

function runRegexLocally(pattern: string, flags: string, text: string, replacement: string): { matches: RegexMatch[]; replacement: string } {
  const expression = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  const matches: RegexMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    matches.push({ index: match.index, text: match[0], groups: { ...(match.groups ?? {}) } });
    if (matches.length >= MAX_MATCHES) break;
    if (match[0] === "") expression.lastIndex += 1;
  }
  return { matches, replacement: text.replace(new RegExp(pattern, flags), replacement) };
}

function buildRegexAst(pattern: string): RegexNode {
  let nextId = 1;
  const root: RegexNode = { id: nextId++, kind: "root", label: "正则表达式", children: [] };
  const stack: RegexNode[] = [root];
  for (let index = 0; index < pattern.length && nextId <= 2_001; index += 1) {
    const char = pattern[index];
    const parent = stack[stack.length - 1];
    if (char === "\\") {
      const node = { id: nextId++, kind: "escape" as const, label: pattern.slice(index, index + 2), children: [] };
      parent.children.push(node);
      index += 1;
    } else if (char === "(") {
      const node = { id: nextId++, kind: "group" as const, label: pattern.slice(index, pattern[index + 1] === "?" ? index + 4 : index + 1), children: [] };
      parent.children.push(node);
      stack.push(node);
    } else if (char === ")") {
      if (stack.length > 1) stack.pop();
    } else if (char === "[") {
      const end = findClosing(pattern, index, "]");
      const node = { id: nextId++, kind: "character-class" as const, label: pattern.slice(index, end + 1), children: [] };
      parent.children.push(node);
      if (end > index) index = end;
    } else if (char === "|") {
      parent.children.push({ id: nextId++, kind: "alternation", label: "分支 |", children: [] });
    } else if (char === "*" || char === "+" || char === "?" || char === "{") {
      const node = { id: nextId++, kind: "quantifier" as const, label: readQuantifier(pattern, index), children: [] };
      parent.children.push(node);
      if (char === "{") {
        const end = findClosing(pattern, index, "}");
        if (end > index) index = end;
      }
    } else {
      parent.children.push({ id: nextId++, kind: "literal", label: char, children: [] });
    }
  }
  return root;
}

function findClosing(value: string, start: number, closing: string): number {
  for (let index = start + 1; index < value.length; index += 1) if (value[index] === closing && value[index - 1] !== "\\") return index;
  return start;
}

function readQuantifier(value: string, start: number): string {
  if (value[start] !== "{") return value[start];
  const end = findClosing(value, start, "}");
  return end > start ? value.slice(start, end + 1) : value[start];
}
