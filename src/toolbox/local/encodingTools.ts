import { ToolboxInputError } from "./toolboxErrors";
import { assertTextLimit } from "./jsonTools";

export interface UrlAnalysis {
  href: string;
  protocol: string;
  username: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  query: Array<[string, string]>;
}

export function encodeUrlComponent(value: string): string {
  assertTextLimit(value);
  return encodeURIComponent(value);
}

export function decodeUrlComponent(value: string): string {
  assertTextLimit(value);
  try { return decodeURIComponent(value); } catch { throw new ToolboxInputError("invalid_percent_encoding", "URL 百分号编码无效。 "); }
}

export function analyzeUrl(value: string): UrlAnalysis {
  assertTextLimit(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolboxInputError("invalid_url", "请输入完整 URL；工具不会打开或访问它。 "); }
  const query: Array<[string, string]> = [];
  if (url.search.length > 1) {
    for (const part of url.search.slice(1).split("&")) {
      const separator = part.indexOf("=");
      const rawKey = separator < 0 ? part : part.slice(0, separator);
      const rawValue = separator < 0 ? "" : part.slice(separator + 1);
      query.push([decodeUrlComponent(rawKey), decodeUrlComponent(rawValue)]);
    }
  }
  return { href: url.href, protocol: url.protocol, username: url.username, hostname: url.hostname, port: url.port, pathname: url.pathname, hash: url.hash, query };
}

export function encodeBase64(value: string, urlSafe = false): string {
  assertTextLimit(value);
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const encoded = btoa(binary);
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export function decodeBase64(value: string, urlSafe = false): string {
  assertTextLimit(value);
  const normalized = urlSafe ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) {
    throw new ToolboxInputError("invalid_base64", "Base64 字符或 padding 无效。 ");
  }
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw new ToolboxInputError("invalid_utf8", "Base64 内容不是有效 UTF-8 文本。 "); }
}

export function convertUnixTime(value: string, unit: "seconds" | "milliseconds"): { utc: string; local: string; epochMilliseconds: number } {
  if (!/^-?\d+(?:\.\d+)?$/.test(value.trim())) throw new ToolboxInputError("invalid_timestamp", "Unix 时间必须是数字，并且单位需要显式选择。 ");
  const numeric = Number(value);
  const epochMilliseconds = unit === "seconds" ? numeric * 1000 : numeric;
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < -8.64e15 || epochMilliseconds > 8.64e15) throw new ToolboxInputError("timestamp_out_of_range", "Unix 时间超出安全范围。 ");
  const date = new Date(epochMilliseconds);
  return { utc: date.toISOString(), local: date.toLocaleString(), epochMilliseconds };
}

export function convertIsoTime(value: string): { seconds: string; milliseconds: string; utc: string; local: string } {
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value.trim())) throw new ToolboxInputError("timezone_required", "ISO 时间必须明确包含时区。 ");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ToolboxInputError("invalid_iso", "ISO 时间格式无效。 ");
  return { seconds: String(Math.floor(date.getTime() / 1000)), milliseconds: String(date.getTime()), utc: date.toISOString(), local: date.toLocaleString() };
}

export function generateUuidV4(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new ToolboxInputError("invalid_count", "UUID 数量必须是 1 到 100。 ");
  return Array.from({ length: count }, () => crypto.randomUUID());
}
