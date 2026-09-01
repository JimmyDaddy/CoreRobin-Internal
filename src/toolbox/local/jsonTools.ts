import { ToolboxInputError } from "./toolboxErrors";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 128;
export const MAX_JSON_NODES = 200_000;

type JsonNode =
  | { kind: "object"; entries: Array<{ key: string; keyRaw: string; value: JsonNode }> }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "string" | "number" | "literal"; raw: string };

export interface JsonAnalysis {
  duplicateKeys: string[];
  depth: number;
  nodeCount: number;
  formatted: string;
  compact: string;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertTextLimit(value: string, maxBytes = MAX_TEXT_BYTES): void {
  if (utf8ByteLength(value) > maxBytes) {
    throw new ToolboxInputError("input_too_large", `输入不能超过 ${Math.floor(maxBytes / 1024)} KiB。`);
  }
}

export function analyzeJson(input: string, indent: 2 | 4 = 2): JsonAnalysis {
  assertTextLimit(input);
  const parser = new JsonParser(input);
  const root = parser.parse();
  return {
    duplicateKeys: parser.duplicateKeys,
    depth: parser.maxDepth,
    nodeCount: parser.nodeCount,
    formatted: renderJson(root, indent, 0),
    compact: renderJson(root, 0, 0),
  };
}

class JsonParser {
  private index = 0;
  readonly duplicateKeys: string[] = [];
  nodeCount = 0;
  maxDepth = 0;

  constructor(private readonly input: string) {}

  parse(): JsonNode {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.input.length) this.fail("JSON 后面存在多余内容。");
    return value;
  }

  private parseValue(depth = 0): JsonNode {
    this.skipWhitespace();
    this.reserveNode();
    const char = this.input[this.index];
    if (char === "{") return this.parseObject(depth + 1);
    if (char === "[") return this.parseArray(depth + 1);
    if (char === '"') return this.parseString("string");
    if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber();
    if (this.input.startsWith("true", this.index)) return this.parseLiteral("true");
    if (this.input.startsWith("false", this.index)) return this.parseLiteral("false");
    if (this.input.startsWith("null", this.index)) return this.parseLiteral("null");
    this.fail("这里不是有效的 JSON 值。");
  }

  private parseObject(depth: number): JsonNode {
    this.assertDepth(depth);
    this.index += 1;
    const entries: Array<{ key: string; keyRaw: string; value: JsonNode }> = [];
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.index] === "}") {
      this.index += 1;
      return { kind: "object", entries };
    }
    while (this.index < this.input.length) {
      this.skipWhitespace();
      if (this.input[this.index] !== '"') this.fail("对象键必须是双引号包裹的字符串。");
      const keyNode = this.parseString("string");
      const key = JSON.parse(keyNode.raw) as string;
      if (keys.has(key)) this.duplicateKeys.push(key);
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.index] !== ":") this.fail("对象键后缺少冒号。");
      this.index += 1;
      entries.push({ key, keyRaw: keyNode.raw, value: this.parseValue(depth) });
      this.skipWhitespace();
      if (this.input[this.index] === "}") {
        this.index += 1;
        return { kind: "object", entries };
      }
      if (this.input[this.index] !== ",") this.fail("对象成员之间缺少逗号。");
      this.index += 1;
      this.skipWhitespace();
      if (this.input[this.index] === "}") this.fail("对象不能以逗号结尾。");
    }
    this.fail("对象没有闭合。");
  }

  private parseArray(depth: number): JsonNode {
    this.assertDepth(depth);
    this.index += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.input[this.index] === "]") {
      this.index += 1;
      return { kind: "array", items };
    }
    while (this.index < this.input.length) {
      items.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.input[this.index] === "]") {
        this.index += 1;
        return { kind: "array", items };
      }
      if (this.input[this.index] !== ",") this.fail("数组成员之间缺少逗号。");
      this.index += 1;
      this.skipWhitespace();
      if (this.input[this.index] === "]") this.fail("数组不能以逗号结尾。");
    }
    this.fail("数组没有闭合。");
  }

  private parseString(kind: "string"): { kind: typeof kind; raw: string } {
    const start = this.index;
    this.index += 1;
    while (this.index < this.input.length) {
      const char = this.input[this.index];
      if (char === "\\") {
        this.index += 2;
        if (this.input[this.index - 1] === "u") this.index += 4;
        continue;
      }
      if (char === '"') {
        this.index += 1;
        const raw = this.input.slice(start, this.index);
        try { JSON.parse(raw); } catch { this.fail("字符串转义无效。", start); }
        return { kind, raw };
      }
      if (char < " ") this.fail("字符串不能包含未转义的控制字符。", this.index);
      this.index += 1;
    }
    this.fail("字符串没有闭合。", start);
  }

  private parseNumber(): JsonNode {
    const start = this.index;
    const match = this.input.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.fail("数字格式无效。", start);
    this.index += match[0].length;
    return { kind: "number", raw: match[0] };
  }

  private parseLiteral(literal: "true" | "false" | "null"): JsonNode {
    this.index += literal.length;
    return { kind: "literal", raw: literal };
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.input[this.index] ?? "")) this.index += 1;
  }

  private reserveNode(): void {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_JSON_NODES) this.fail("JSON 结构过大。", this.index);
  }

  private assertDepth(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      throw new ToolboxInputError("json_too_deep", `JSON 嵌套不能超过 ${MAX_JSON_DEPTH} 层。`);
    }
    this.maxDepth = Math.max(this.maxDepth, depth);
  }

  private fail(message: string, position = this.index): never {
    const before = this.input.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    throw new ToolboxInputError("invalid_json", message, line, column);
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function renderJson(node: JsonNode, indent: number, level: number): string {
  if (node.kind === "string" || node.kind === "number" || node.kind === "literal") return node.raw;
  const newline = indent > 0 ? "\n" : "";
  const pad = indent > 0 ? " ".repeat(indent * level) : "";
  const childPad = indent > 0 ? " ".repeat(indent * (level + 1)) : "";
  if (node.kind === "array") {
    if (node.items.length === 0) return "[]";
    return `[${newline}${childPad}${node.items.map((item) => renderJson(item, indent, level + 1)).join(indent > 0 ? `,${newline}${childPad}` : ",")}${newline}${pad}]`;
  }
  if (node.kind === "object") {
    if (node.entries.length === 0) return "{}";
    return `{${newline}${childPad}${node.entries.map((entry) => `${entry.keyRaw}:${indent > 0 ? " " : ""}${renderJson(entry.value, indent, level + 1)}`).join(indent > 0 ? `,${newline}${childPad}` : ",")}${newline}${pad}}`;
  }
  return node.raw;
}
