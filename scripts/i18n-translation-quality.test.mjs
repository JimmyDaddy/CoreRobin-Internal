import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const localeRoot = join(process.cwd(), "src", "i18n", "locales");
const namespaces = [
  "history",
  "settings",
  "storage",
  "applications",
  "startup",
];
const highVisibilityPrefixes = [
  "applicationImpact",
  "baseline",
  "applicationImpactHistory",
  "supportFlow",
  "health",
  "nativeUninstall",
  "impactComparison",
  "impactReceipt",
];
const allowedIdenticalValues = new Set([
  "CPU",
  "Flatpak",
  "Snap",
  "Windows Installer (MSI)",
]);

function flatten(value, prefix = "", result = {}) {
  Object.entries(value).forEach(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, path, result);
      return;
    }
    result[path] = String(child);
  });
  return result;
}

function loadNamespace(locale, namespace) {
  return flatten(
    JSON.parse(
      readFileSync(join(localeRoot, locale, `${namespace}.json`), "utf8"),
    ),
  );
}

function isHighVisibilityKey(key) {
  return highVisibilityPrefixes.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`),
  );
}

function isMeaningfulEnglishSentence(value) {
  return (
    value.length >= 12 &&
    /[A-Za-z].*\s+[A-Za-z]/.test(value) &&
    !allowedIdenticalValues.has(value)
  );
}

describe("translation quality", () => {
  it("does not silently copy high-visibility English feature text", () => {
    const locales = readdirSync(localeRoot)
      .filter((locale) => locale !== "en")
      .sort();
    const findings = [];

    locales.forEach((locale) => {
      namespaces.forEach((namespace) => {
        const english = loadNamespace("en", namespace);
        const translated = loadNamespace(locale, namespace);

        Object.entries(english).forEach(([key, value]) => {
          if (!isHighVisibilityKey(key)) {
            return;
          }
          if (!(key in translated)) {
            findings.push(`${locale}:${namespace}.${key} is missing`);
            return;
          }
          if (
            translated[key] === value &&
            isMeaningfulEnglishSentence(value)
          ) {
            findings.push(`${locale}:${namespace}.${key} still equals English`);
          }
        });
      });
    });

    expect(findings).toEqual([]);
  });

  it("does not reintroduce obsolete macOS-only uninstall claims", () => {
    const obsoleteClaims = [
      /first release supports macOS app bundles/i,
      /windows and linux will follow/i,
      /首版支持 macOS 应用包/i,
      /Windows 和 Linux 会.*开放/i,
    ];
    const findings = [];

    for (const locale of readdirSync(localeRoot).sort()) {
      const content = readFileSync(
        join(localeRoot, locale, "applications.json"),
        "utf8",
      );
      for (const claim of obsoleteClaims) {
        if (claim.test(content)) findings.push(`${locale}:${claim.source}`);
      }
    }

    expect(findings).toEqual([]);
  });
});
