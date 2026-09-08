import { describe, expect, it } from "vitest";
import { apiBaseSuggestion, generationEndpointLabel } from "./presets";

describe("API base preview", () => {
  it("keeps custom prefixes and only suggests splitting the selected protocol", () => {
    expect(
      apiBaseSuggestion(
        "https://example.com/company/v1/messages/",
        "anthropic_messages",
      ),
    ).toBe("https://example.com/company/v1");
    expect(
      apiBaseSuggestion("http://127.0.0.1:11434/api/chat", "ollama_native"),
    ).toBe("http://127.0.0.1:11434");
    expect(
      apiBaseSuggestion("https://example.com/v1/messages", "openai_responses"),
    ).toBeNull();
    expect(
      generationEndpointLabel("https://example.com/company", "openai_chat"),
    ).toBe("https://example.com/company/chat/completions");
  });
  it("does not echo credentials, query secrets or unsafe URL schemes in suggestions", () => {
    for (const url of [
      "https://me:secret@example.com/messages",
      "https://example.com/messages?key=secret",
      "javascript:alert(1)",
    ]) {
      expect(apiBaseSuggestion(url, "anthropic_messages")).toBeNull();
      expect(generationEndpointLabel(url, "anthropic_messages")).toBe("");
    }
  });
});
