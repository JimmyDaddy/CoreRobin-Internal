import type { AiProtocol } from "./types";

export const AI_PRESETS = [
  {
    id: "ollama",
    name: "Ollama",
    protocol: "ollama_native",
    baseUrl: "http://127.0.0.1:11434",
    authMode: "none",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai_chat",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "api_key",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai_chat",
    baseUrl: "https://api.deepseek.com",
    authMode: "bearer",
  },
  {
    id: "bailian",
    name: "Alibaba Cloud Model Studio",
    protocol: "openai_chat",
    baseUrl: "",
    authMode: "bearer",
  },
  {
    id: "custom",
    name: "",
    protocol: "openai_chat",
    baseUrl: "",
    authMode: "bearer",
  },
] as const;

export const AI_PROTOCOLS = [
  { value: "ollama_native", label: "Ollama" },
  { value: "openai_chat", label: "OpenAI Chat Completions" },
  { value: "openai_responses", label: "OpenAI Responses" },
  { value: "anthropic_messages", label: "Anthropic Messages" },
] as const;

export function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

const generationPaths: Record<AiProtocol, string> = {
  ollama_native: "/api/chat",
  openai_chat: "/chat/completions",
  openai_responses: "/responses",
  anthropic_messages: "/messages",
};
function safeApiUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}
export function apiBaseSuggestion(
  raw: string,
  protocol: AiProtocol,
): string | null {
  const url = safeApiUrl(raw);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = generationPaths[protocol];
  if (!path.endsWith(suffix)) return null;
  url.pathname = path.slice(0, -suffix.length) || "/";
  return url.toString().replace(/\/$/, "");
}
export function generationEndpointLabel(
  raw: string,
  protocol: AiProtocol,
): string {
  const url = safeApiUrl(raw);
  if (!url) return "";
  url.pathname = url.pathname.replace(/\/+$/, "") + generationPaths[protocol];
  return url.toString();
}
