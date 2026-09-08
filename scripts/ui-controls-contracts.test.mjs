import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const read = (path) => readFileSync(resolve(path), "utf8");
it("uses one token and button source for the main window and Robin", () => {
  expect(read("src/App.css")).toContain('@import "./styles/tokens.css"');
  expect(read("src/styles/surface-base.css")).toContain('@import "./tokens.css"');
  expect(read("src/App.tsx")).toContain('import "./styles/controls.css"');
  expect(read("src/components/Button.tsx")).toContain('import "../styles/controls.css"');
  expect(read("src/components/Select.tsx")).toContain('import "../styles/controls.css"');
  expect(read("src/styles/ai.css")).not.toMatch(/\.ai-(?:assistant|settings)\s+(?:\.button(?:\s|--|,)|input)/);
  expect(read("src/styles/controls.css")).toContain('input[type="checkbox"]:not([role="switch"])');
});
it("resolves all capability color tokens from the shared root", () => {
  const definitions = new Set([...read("src/styles/tokens.css").matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const colors = [...read("src/capabilities/capabilities.css").matchAll(/(?:^|[;{]\s*)color:\s*var\((--[\w-]+)\)/g)].map((match) => match[1]);
  expect(colors.length).toBeGreaterThan(10);
  for (const color of colors) expect(definitions.has(color), color).toBe(true);
});
it("routes product native selects through the shared primitive", () => {
  const files = readdirSync(resolve("src"), { recursive: true }).filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx") && file !== "components/Select.tsx");
  for (const file of files) expect(read(`src/${file}`), file).not.toMatch(/<select\b/);
});
