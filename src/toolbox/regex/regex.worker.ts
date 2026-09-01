const MAX_AST_NODES = 2_000;
const MAX_AST_DEPTH = 64;
const MAX_MATCHES = 1_000;

type RegexNodeKind = "root" | "group" | "alternation" | "character-class" | "quantifier" | "literal" | "escape";

interface WorkerRegexNode {
  id: number;
  kind: RegexNodeKind;
  label: string;
  children: WorkerRegexNode[];
}

interface WorkerAnalysis {
  supported: boolean;
  syntaxError: string | null;
  ast: WorkerRegexNode;
  warnings: string[];
}

interface WorkerMatch {
  index: number;
  text: string;
  groups: Record<string, string | undefined>;
}

interface WorkerRequest {
  pattern: string;
  flags: string;
  text: string;
  replacement: string;
}

class RegexWorkerError extends Error {
  constructor(readonly code: "regex_ast_too_large" | "regex_ast_too_deep", message: string) {
    super(message);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { pattern, flags, text, replacement } = event.data;
  let ast: WorkerRegexNode;
  let warnings: string[];
  try {
    ast = buildRegexAst(pattern);
    warnings = collectWarnings(pattern);
  } catch (error) {
    postFailure(error);
    return;
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "正则语法无效。";
    self.postMessage({ ok: false, code: "invalid_regex", error: message, analysis: { supported: false, syntaxError: message, ast, warnings } satisfies WorkerAnalysis });
    return;
  }

  try {
    const matches: WorkerMatch[] = [];
    let match: RegExpExecArray | null;
    const unicode = flags.includes("u") || flags.includes("v");
    while ((match = expression.exec(text)) !== null && matches.length < MAX_MATCHES) {
      matches.push({ index: match.index, text: match[0], groups: { ...(match.groups ?? {}) } });
      if (match[0] === "") expression.lastIndex = advanceStringIndex(text, expression.lastIndex, unicode);
    }
    self.postMessage({ ok: true, value: { matches, replacement: text.replace(new RegExp(pattern, flags), replacement) }, analysis: { supported: true, syntaxError: null, ast, warnings } satisfies WorkerAnalysis });
  } catch (error) {
    postFailure(error);
  }
};

function postFailure(error: unknown): void {
  if (error instanceof RegexWorkerError) {
    self.postMessage({ ok: false, code: error.code, error: error.message });
    return;
  }
  self.postMessage({ ok: false, error: error instanceof Error ? error.message : "正则执行失败。" });
}

function buildRegexAst(pattern: string): WorkerRegexNode {
  let nextId = 1;
  const root: WorkerRegexNode = { id: nextId++, kind: "root", label: "正则表达式", children: [] };
  const stack: WorkerRegexNode[] = [root];
  const createNode = (kind: Exclude<RegexNodeKind, "root">, label: string): WorkerRegexNode => {
    if (nextId > MAX_AST_NODES) throw new RegexWorkerError("regex_ast_too_large", "正则结构超过 2000 个节点，无法安全解析。 ");
    return { id: nextId++, kind, label, children: [] };
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const parent = stack[stack.length - 1];
    if (char === "\\") {
      parent.children.push(createNode("escape", pattern.slice(index, index + 2)));
      index += 1;
    } else if (char === "(") {
      if (stack.length - 1 >= MAX_AST_DEPTH) throw new RegexWorkerError("regex_ast_too_deep", "正则结构嵌套超过 64 层，无法安全解析。 ");
      const node = createNode("group", pattern.slice(index, pattern[index + 1] === "?" ? index + 4 : index + 1));
      parent.children.push(node);
      stack.push(node);
    } else if (char === ")") {
      if (stack.length > 1) stack.pop();
    } else if (char === "[") {
      const end = findClosing(pattern, index, "]");
      parent.children.push(createNode("character-class", pattern.slice(index, end + 1)));
      if (end > index) index = end;
    } else if (char === "|") {
      parent.children.push(createNode("alternation", "分支 |"));
    } else if (char === "*" || char === "+" || char === "?" || char === "{") {
      parent.children.push(createNode("quantifier", readQuantifier(pattern, index)));
      if (char === "{") {
        const end = findClosing(pattern, index, "}");
        if (end > index) index = end;
      }
    } else {
      parent.children.push(createNode("literal", char));
    }
  }
  return root;
}

function collectWarnings(pattern: string): string[] {
  const warnings: string[] = [];
  if (/\([^?]*\+[^)]*\)[+*{]/.test(pattern) || /\([^?]*\*[^)]*\)[+*{]/.test(pattern)) warnings.push("检测到嵌套重复，可能带来回溯开销；这不是 ReDoS 安全证明。 ");
  if (/(?:^|[^\\])(?:\^|\$)?\([^)]*\|[^)]*\)/.test(pattern)) warnings.push("分支结构已标记；图形解释语法关系，不代表引擎逐步回溯轨迹。 ");
  return warnings;
}

function advanceStringIndex(value: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  const second = value.charCodeAt(index + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
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

export {};
