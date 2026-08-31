import { describe, expect, it } from "vitest";
import { inspectPatchSafely, makePatchBundle, manifestJson, sha256Hex } from "./binaryPatchTools";

describe("binary patch toolbox boundaries", () => {
  it("hashes bytes and keeps signing payload as data rather than a signature", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("recognizes malformed patch data without treating it as trusted", async () => {
    const inspection = await inspectPatchSafely(new Uint8Array([69, 78, 68, 83, 76, 69, 89]));
    expect(inspection.valid).toBe(false);
    expect(inspection.issue).toBe("TRUNCATED_HEADER");
  });

  it("creates a data-only bundle with no network behavior", () => {
    const target = { bytes: 3, sha256: "c".repeat(64) };
    const bundle = makePatchBundle(target, target);
    expect(bundle.patches).toHaveLength(0);
    expect(manifestJson({ version: 1, format: "ENDSLEY/BSDIFF43", baseline: { bytes: 1, sha256: "a".repeat(64) }, patch: { bytes: 2, sha256: "b".repeat(64) }, target: { bytes: 3, sha256: "c".repeat(64) } })).not.toContain("signature");
  });
});
