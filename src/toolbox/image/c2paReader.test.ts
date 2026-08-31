import { describe, expect, it } from "vitest";

import { summarizeManifestStore } from "./c2paReader";

describe("C2PA reader boundary", () => {
  it("separates local validation from trust and preserves the embedded store", () => {
    const store = {
      active_manifest: "urn:c2pa:active",
      manifests: {
        "urn:c2pa:active": { claim_generator: "fixture/1.0" },
      },
      validation_state: "Valid",
      validation_status: [{ code: "claim_signature.valid" }],
      validation_results: {
        activeManifest: {
          success: [{ code: "assertion.dataHash.match" }],
          informational: [],
          failure: [],
        },
      },
    } as never;

    const result = summarizeManifestStore("image/jpeg", store);

    expect(result).toMatchObject({
      source: "embedded-image",
      parse: { status: "parsed", manifests: 1, activeManifest: "urn:c2pa:active", claimGenerator: "fixture/1.0" },
      validation: { status: "valid", state: "Valid", codes: ["claim_signature.valid", "assertion.dataHash.match"] },
      trust: { status: "unknown", reason: "offline_trust_policy_not_configured" },
      externalNetworkAccessed: false,
      manifestStore: store,
    });
  });

  it("aggregates ingredient delta failures and keeps trust separate", () => {
    const result = summarizeManifestStore("image/png", {
      manifests: { active: { claim_generator: "fixture/1.0" } },
      active_manifest: "active",
      validation_state: "Valid",
      validation_status: [{ code: "claim.signature.checked" }],
      validation_results: {
        ingredientDeltas: [{
          ingredientAssertionURI: "self#jumbf=/c2pa/ingredient",
          validationDeltas: { success: [], informational: [], failure: [{ code: "ingredient.hash.mismatch" }] },
        }],
      },
    } as never);

    expect(result.validation).toEqual({ status: "invalid", state: "Valid", codes: ["claim.signature.checked", "ingredient.hash.mismatch"] });
    expect(result.trust.status).toBe("unknown");
    expect(result.externalNetworkAccessed).toBe(false);
  });
});
