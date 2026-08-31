import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const script = resolve(repositoryRoot, "scripts/verify-web-bundle.mjs");
const budgets = JSON.parse(await readFile(resolve(repositoryRoot, "scripts/web-bundle-budgets.json"), "utf8"));
let distRoot;

beforeEach(async () => {
  distRoot = await mkdtemp(join(tmpdir(), "corerobin-web-bundle-"));
  await mkdir(join(distRoot, ".vite"));
  await mkdir(join(distRoot, "assets/workers"), { recursive: true });
  const manifest = {
    shared: { file: "assets/shared.js" },
    lazy: { file: "assets/lazy.js" },
  };
  await writeFile(join(distRoot, "assets/shared.js"), "/* shared */");
  await writeFile(join(distRoot, "assets/lazy.js"), "/* lazy */");
  for (const entry of Object.keys(budgets.entries)) {
    const file = `assets/${entry}.js`;
    manifest[entry] = { file, isEntry: true, imports: ["shared"], dynamicImports: ["lazy"] };
    await writeFile(join(distRoot, entry), `<script type="module" src="/${file}"></script>`);
    await writeFile(join(distRoot, file), "/* entry */");
  }
  await writeFile(join(distRoot, ".vite/manifest.json"), JSON.stringify(manifest));
});

afterEach(async () => {
  if (distRoot) await rm(distRoot, { recursive: true, force: true });
});

function verify() {
  return execFileSync(process.execPath, [script, distRoot], { encoding: "utf8", stdio: "pipe" });
}

describe("production WebView bundle verification", () => {
  it("counts unlisted workers and styles once, without adding them to initial entry budgets", async () => {
    await writeFile(join(distRoot, "assets/workers/standalone.js"), "/* worker */");
    await writeFile(join(distRoot, "assets/workers/standalone.css"), ":root{}");
    await writeFile(join(distRoot, "assets/workers/ignored.js.map"), "not javascript");
    const output = verify();
    const report = JSON.parse(output.slice(0, output.lastIndexOf("}") + 1));
    expect(report.totals).toEqual({
      javascriptBytes: 4 * "/* entry */".length + "/* shared */".length + "/* lazy */".length + "/* worker */".length,
      cssBytes: ":root{}".length,
    });
    for (const entry of Object.keys(budgets.entries)) {
      expect(report.entries[entry]).toMatchObject({
        javascriptBytes: "/* entry */".length + "/* shared */".length,
        cssBytes: 0,
        initialFiles: 2,
      });
    }
  });

  it.each([
    ["js", "javascriptBytes"],
    ["css", "cssBytes"],
  ])("rejects unlisted %s output exceeding the total budget", async (extension, metric) => {
    await writeFile(join(distRoot, `assets/workers/oversized.${extension}`), Buffer.alloc(budgets.totals[metric] + 1));
    expect(verify).toThrow(new RegExp(`all production chunks ${metric}.*over its ${budgets.totals[metric]} byte budget`));
  });

  it("still enforces the separate initial entry budget", async () => {
    await writeFile(join(distRoot, "assets/index.html.js"), Buffer.alloc(budgets.entries["index.html"].javascriptBytes + 1));
    expect(verify).toThrow(/index.html javascriptBytes.*over its 510000 byte budget/);
  });

  it("accounts for lazy C2PA JavaScript and WASM separately from the general total", async () => {
    const c2pa = "assets/c2pa-reader.js";
    const wasm = "assets/c2pa-reader.wasm";
    const manifest = JSON.parse(await readFile(join(distRoot, ".vite/manifest.json"), "utf8"));
    manifest.c2pa = { file: c2pa, src: "node_modules/.pnpm/@contentauth/c2pa-web/dist/index.js", assets: [wasm] };
    await writeFile(join(distRoot, c2pa), "/* c2pa */");
    await writeFile(join(distRoot, wasm), "wasm");
    await writeFile(join(distRoot, ".vite/manifest.json"), JSON.stringify(manifest));

    const output = verify();
    const report = JSON.parse(output.slice(0, output.lastIndexOf("}") + 1));
    expect(report.c2pa).toEqual({ javascriptBytes: "/* c2pa */".length, wasmBytes: "wasm".length });
    expect(report.totals.javascriptBytes).toBe(4 * "/* entry */".length + "/* shared */".length + "/* lazy */".length);
  });

  it("rejects an oversized lazy C2PA asset", async () => {
    const c2pa = "assets/c2pa-reader.js";
    const manifest = JSON.parse(await readFile(join(distRoot, ".vite/manifest.json"), "utf8"));
    manifest.c2pa = { file: c2pa, src: "node_modules/.pnpm/@contentauth/c2pa-web/dist/index.js" };
    await writeFile(join(distRoot, c2pa), Buffer.alloc(budgets.c2pa.javascriptBytes + 1));
    await writeFile(join(distRoot, ".vite/manifest.json"), JSON.stringify(manifest));
    expect(verify).toThrow(new RegExp(`C2PA lazy assets javascriptBytes.*over its ${budgets.c2pa.javascriptBytes} byte budget`));
  });

  it("still rejects missing manifest assets", async () => {
    await rm(join(distRoot, "assets/lazy.js"));
    expect(verify).toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === "win32")("rejects symlink outputs instead of omitting or following them", async () => {
    await symlink("../shared.js", join(distRoot, "assets/workers/linked.js"));
    expect(verify).toThrow(/Build output must not contain symbolic links/);
  });
});
