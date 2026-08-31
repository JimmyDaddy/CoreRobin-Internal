import { describe, expect, it } from "vitest";
import { createTextRecipe, inspectLocalManifest, parseRecipeDocument } from "./imageTools";

describe("image toolbox contracts", () => {
  it("creates and validates a portable Recipe document", () => {
    const recipe = createTextRecipe("CoreRobin", "#ffffff", 0.8);
    const parsed = parseRecipeDocument(JSON.stringify(recipe));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.layers).toHaveLength(1);
  });

  it("does not treat a local manifest as trusted", () => {
    const result = inspectLocalManifest(JSON.stringify({ manifests: { abc: {} }, claim_generator: "local" }));
    expect(result.manifests).toBe(1);
    expect(result.trust).toBe("unknown");
    expect(result.networkAccessed).toBe(false);
  });
});
