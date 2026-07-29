import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const vendoredManifest = readFileSync("src-tauri/vendor/glib/Cargo.toml", "utf8");
const variantIterator = readFileSync(
  "src-tauri/vendor/glib/src/variant_iter.rs",
  "utf8",
);
const provenance = readFileSync(
  "src-tauri/vendor/glib/COREROBIN-SECURITY-BACKPORT.md",
  "utf8",
);

describe("dependency security backports", () => {
  it("keeps the audited glib 0.18 compatibility fix active", () => {
    expect(manifest).toContain('glib = { path = "vendor/glib" }');
    expect(vendoredManifest).toContain('version = "0.18.6"');
    expect(variantIterator).toContain(
      "let mut p: *mut libc::c_char = std::ptr::null_mut();",
    );
    expect(variantIterator).toContain("&mut p,");
    expect(provenance).toContain("ea720152f28e293ef4362ee844ee5cc499f32d2a");
    expect(provenance).toContain("RUSTSEC-2024-0429");
  });
});
