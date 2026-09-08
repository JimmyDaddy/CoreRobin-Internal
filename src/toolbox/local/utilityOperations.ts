import { analyzeJson, assertTextLimit } from "./jsonTools";
import { analyzeUrl, convertTime, decodeBase64, decodeUrlComponent, encodeBase64, encodeUrlComponent, generateUuidV4, hashText } from "./encodingTools";
import { formatColor, parseColor } from "../color/colorTools";
import { analyzeRegex, runRegexInWorker } from "../regex/regexTools";
import { ToolboxInputError } from "./toolboxErrors";

export const UTILITY_OPERATIONS = ["json_format", "json_compact", "url_encode", "url_decode", "url_inspect", "base64_encode", "base64_decode", "base64url_encode", "base64url_decode", "time_seconds", "time_milliseconds", "uuid_v4", "text_sha256", "regex", "color"] as const;
export type UtilityOperation = typeof UTILITY_OPERATIONS[number];
export interface UtilityArguments { operation: UtilityOperation; input: string; pattern?: string | null; flags?: string | null; replacement?: string | null; count?: number | null; indent?: 2 | 4 | null }
export type UtilityToolId = "json" | "url" | "base64" | "time" | "uuid" | "text-sha256" | "regex" | "color";
export interface UtilityOutcome { toolId: UtilityToolId; fields: Record<string, unknown>; output: string }
const operationTool: Record<UtilityOperation, UtilityToolId> = {
  json_format: "json", json_compact: "json", url_encode: "url", url_decode: "url", url_inspect: "url",
  base64_encode: "base64", base64_decode: "base64", base64url_encode: "base64", base64url_decode: "base64",
  time_seconds: "time", time_milliseconds: "time", uuid_v4: "uuid", text_sha256: "text-sha256", regex: "regex", color: "color",
};
export function utilityToolId(args: UtilityArguments): UtilityToolId {
  if (!UTILITY_OPERATIONS.includes(args.operation)) throw new ToolboxInputError("invalid_tool_arguments", "Unknown local utility.");
  return operationTool[args.operation];
}
export async function executeTextUtility(args: UtilityArguments): Promise<UtilityOutcome> {
  const toolId = utilityToolId(args);
  if (typeof args.input !== "string" || Object.keys(args).some((key) => !["operation", "input", "pattern", "flags", "replacement", "count", "indent"].includes(key))) throw new ToolboxInputError("invalid_tool_arguments", "Invalid utility input.");
  assertTextLimit(args.input, 4096);
  if (args.pattern != null) assertTextLimit(args.pattern, 256);
  if (args.flags != null) assertTextLimit(args.flags, 8);
  if (args.replacement != null) assertTextLimit(args.replacement, 1024);
  let output = "";
  let fields: Record<string, unknown> = { input: args.input, error: "" };
  switch (toolId) {
    case "json": {
      if (args.indent != null && args.indent !== 2 && args.indent !== 4) throw new ToolboxInputError("invalid_tool_arguments", "Invalid indentation.");
      const value = analyzeJson(args.input, args.indent ?? 2);
      output = args.operation === "json_compact" ? value.compact : value.formatted;
      fields = { ...fields, indent: args.indent ?? 2, duplicates: value.duplicateKeys, output };
      break;
    }
    case "url": {
      const mode = args.operation === "url_encode" ? "encode" : args.operation === "url_decode" ? "decode" : "inspect";
      output = mode === "encode" ? encodeUrlComponent(args.input) : mode === "decode" ? decodeUrlComponent(args.input) : JSON.stringify(analyzeUrl(args.input), null, 2);
      fields = { ...fields, mode, output }; break;
    }
    case "base64": {
      const urlSafe = args.operation.startsWith("base64url"); const decode = args.operation.endsWith("decode");
      output = decode ? decodeBase64(args.input, urlSafe) : encodeBase64(args.input, urlSafe);
      fields = { ...fields, urlSafe, decode, output }; break;
    }
    case "time": {
      const unit = args.operation === "time_seconds" ? "seconds" : "milliseconds";
      output = JSON.stringify(convertTime(args.input, unit), null, 2); fields = { ...fields, unit, output }; break;
    }
    case "uuid": output = generateUuidV4(args.count ?? 1).join("\n"); fields = { count: String(args.count ?? 1), output, error: "" }; break;
    case "text-sha256": output = await hashText(args.input); fields = { ...fields, output, expectedDigest: "" }; break;
    case "regex": {
      if (typeof args.pattern !== "string") throw new ToolboxInputError("invalid_tool_arguments", "A regex pattern is required.");
      const pattern = args.pattern, flags = args.flags ?? "gu", replacement = args.replacement ?? "";
      const analysis = analyzeRegex(pattern, flags);
      output = JSON.stringify(await runRegexInWorker(pattern, flags, args.input, replacement), null, 2);
      fields = { pattern, flags, replacement, sample: args.input, analysis, result: output, error: "" }; break;
    }
    case "color": {
      const formatted = formatColor(parseColor(args.input));
      output = Object.entries(formatted).map(([key, value]) => `${key}: ${value}`).join("\n"); fields = { ...fields, output: formatted }; break;
    }
  }
  return { toolId, fields, output };
}
export function utilityExcerpt(output: string): { output: string; truncated: boolean } {
  let excerpt = output;
  // Bound the serialized IPC receipt too, including escaped control characters.
  while (new TextEncoder().encode(JSON.stringify(excerpt)).byteLength > 5000) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
  if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
  return { output: excerpt, truncated: excerpt.length < output.length };
}
