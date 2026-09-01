import { describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import { createC2paAbortError, inspectEmbeddedC2pa, summarizeManifestStore } from "./c2paReader";

const { fromBlob, isSupportedReaderFormat } = vi.hoisted(() => ({
  fromBlob: vi.fn(),
  isSupportedReaderFormat: vi.fn(() => true),
}));
vi.mock("@contentauth/c2pa-web", () => ({
  isSupportedReaderFormat,
  createC2pa: async () => ({
    reader: { fromBlob },
    dispose: vi.fn(),
  }),
}));

vi.mock("@contentauth/c2pa-web/resources/c2pa.wasm?url", () => ({ default: "/c2pa.wasm" }));

describe("C2PA reader boundary", () => {
  it("keeps cancellation user-facing and localized", () => {
    const error = createC2paAbortError();

    expect(error).toMatchObject({ name: "AbortError", message: i18n.t("toolbox:image.errors.c2paInspectionCancelled") });
  });

  it("localizes unsupported formats and absent manifests without changing their status codes", async () => {
    isSupportedReaderFormat.mockReturnValueOnce(false);
    const unsupported = await inspectEmbeddedC2pa(new Blob(["image"]), "image/avif", new AbortController().signal);
    fromBlob.mockResolvedValueOnce(null);
    const notFound = await inspectEmbeddedC2pa(new Blob(["image"]), "image/jpeg", new AbortController().signal);

    expect(unsupported).toMatchObject({ parse: { status: "unsupported" }, note: i18n.t("toolbox:c2paNotes.unsupportedFormat" as never) });
    expect(notFound).toMatchObject({ parse: { status: "not_found" }, note: i18n.t("toolbox:c2paNotes.notFound" as never) });
  });

  it("replaces C2PA parser details with the stable localized malformed result", async () => {
    fromBlob.mockRejectedValueOnce(new Error("internal parser detail"));
    const result = await inspectEmbeddedC2pa(new Blob(["image"], { type: "image/jpeg" }), "image/jpeg", new AbortController().signal);

    expect(result).toMatchObject({ parse: { status: "malformed" }, note: i18n.t("toolbox:image.errors.c2paMalformed") });
    expect(result.note).not.toContain("internal parser detail");
  });

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
      note: i18n.t("toolbox:c2paNotes.validationValid" as never),
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
    expect(result.note).toBe(i18n.t("toolbox:c2paNotes.validationInvalid" as never));
    expect(result.trust.status).toBe("unknown");
    expect(result.externalNetworkAccessed).toBe(false);
  });
});
