import { expect, test } from "@playwright/test";

interface ScanFrame { at: number; arcs: number[][]; images: number; pieOuter: number; pieSignature: number; scales: number[][] }
type ScanWindow = Window & { scanFrames: ScanFrame[] };

// Observe actual Canvas calls: DOM animation state missed the original mismatch.
async function frames(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as ScanWindow).scanFrames.filter((frame) => frame.images > 0));
}
async function head(page: import("@playwright/test").Page) {
  await expect.poll(async () => (await frames(page)).at(-1)?.arcs.filter((arc) => arc[2] === 2).length).toBe(2);
  const frame = (await frames(page)).at(-1)!;
  const [x, y] = frame.arcs.find((arc) => arc[2] === 2)!;
  return { at: frame.at, angle: Math.atan2(y - 210, x - 210) };
}
function expectContinuous(before: { at: number; angle: number }, after: { at: number; angle: number }) {
  const error = after.angle - before.angle - (after.at - before.at) / 3200 * Math.PI * 2;
  expect(Math.abs(Math.atan2(Math.sin(error), Math.cos(error)))).toBeLessThan(.2);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.addInitScript(() => {
    const probe = window as unknown as ScanWindow;
    probe.scanFrames = [];
    let frame: ScanFrame | null = null;
    const geometry = new WeakMap<HTMLCanvasElement, number>();
    const signatures = new WeakMap<HTMLCanvasElement, number>();
    const prototype = CanvasRenderingContext2D.prototype;
    const clear = prototype.clearRect;
    prototype.clearRect = function (...args) {
      if (this.canvas.matches(".cleanup-map__sunburst")) {
        frame = { at: performance.now(), arcs: [], images: 0, pieOuter: 0, pieSignature: 0, scales: [] };
        probe.scanFrames.push(frame);
        if (probe.scanFrames.length > 360) probe.scanFrames.shift();
      }
      geometry.set(this.canvas, 0);
      signatures.set(this.canvas, 0);
      return clear.apply(this, args);
    };
    const arc = prototype.arc;
    prototype.arc = function (...args) {
      if (frame && this.canvas.matches(".cleanup-map__sunburst")) frame.arcs.push(args.slice(0, 5) as number[]);
      geometry.set(this.canvas, Math.max(geometry.get(this.canvas) ?? 0, args[2]));
      signatures.set(this.canvas, (signatures.get(this.canvas) ?? 0) + (args[3] * 13 + args[4]) * args[2]);
      return arc.apply(this, args);
    };
    const image = prototype.drawImage;
    prototype.drawImage = function (...args: Parameters<typeof image>) {
      if (frame && this.canvas.matches(".cleanup-map__sunburst")) {
        frame.images += 1;
        frame.pieOuter = geometry.get(args[0] as HTMLCanvasElement) ?? 0;
        frame.pieSignature = signatures.get(args[0] as HTMLCanvasElement) ?? 0;
      }
      return image.apply(this, args);
    };
    const scale = prototype.scale;
    prototype.scale = function (...args) {
      if (frame && this.canvas.matches(".cleanup-map__sunburst")) frame.scales.push(args);
      return scale.apply(this, args);
    };
  });
  await page.goto("/visual-regression.html?scenario=cleanup-scan-motion&language=en");
});

test("one canvas clock survives long scans, data updates and resumes; motion preferences stop all frames", async ({ page }) => {
  const scene = page.locator(".cleanup-map__scan-stage");
  await expect(scene).toHaveAttribute("data-running", "true");
  const before = await head(page);
  await page.waitForTimeout(6800);
  expectContinuous(before, await head(page));
  await page.getByRole("button", { name: "New batch", exact: true }).click();
  expectContinuous(before, await head(page));
  for (const label of ["Pause", "Slow folder"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(scene).toHaveAttribute("data-running", "false");
    await page.waitForTimeout(100);
    const count = (await frames(page)).length;
    await page.waitForTimeout(250);
    expect((await frames(page)).length).toBe(count);
  }
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(scene).toHaveAttribute("data-running", "true");
  await head(page);
  for (const appPreference of [false, true]) {
    if (appPreference) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => { document.documentElement.dataset.reduceMotion = "true"; });
    } else await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(scene).toHaveAttribute("data-running", "false");
    await page.waitForTimeout(100);
    const count = (await frames(page)).length;
    await page.waitForTimeout(250);
    expect((await frames(page)).length).toBe(count);
  }
});

test("every painted frame keeps the two heads coaxial with a cached unscaled pie through rapid navigation and resizing", async ({ page }) => {
  const canvas = page.locator("canvas.cleanup-map__sunburst");
  await head(page);
  for (const width of [1040, 1440, 1920, 1040]) {
    await page.setViewportSize({ width, height: 900 });
    for (let depth = 0; depth < 4; depth += 1) {
      const box = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: box.width / 2 + 1, y: box.width / 2 - 65 * box.width / 420 } });
      await page.waitForTimeout(60);
    }
    await page.getByRole("button", { name: "New batch", exact: true }).click();
    const center = page.locator(".cleanup-map__center-control");
    for (let depth = 0; depth < 4; depth += 1) if (await center.isEnabled()) await center.click();
    await page.waitForTimeout(120);
  }
  const painted = (await frames(page)).filter((frame) => frame.arcs.some((arc) => arc[2] === 2));
  expect(painted.length).toBeGreaterThan(15);
  for (const frame of painted) {
    const heads = frame.arcs.filter((arc) => arc[2] === 2);
    expect(heads).toHaveLength(2);
    const angles = heads.map(([x, y]) => Math.atan2(y - 210, x - 210));
    expect(angles[0]).toBeCloseTo(angles[1], 8);
    const halo = Math.hypot(heads[1][0] - 210, heads[1][1] - 210);
    expect(halo).toBeGreaterThan(frame.pieOuter);
    expect(halo - Math.max(85, frame.pieOuter)).toBeLessThanOrEqual(7.01);
    expect(frame.scales).toHaveLength(0);
    expect(frame.images).toBe(1);
    // The 640-sector chart is cached: only the small effect is drawn each frame.
    expect(frame.arcs.length).toBeLessThan(100);
  }
  expect(new Set(painted.map((frame) => frame.pieOuter)).size).toBeGreaterThan(1);
  await page.screenshot({ path: test.info().outputPath("coherent-scan.png"), fullPage: true });
});

test("live discoveries share the original canvas and wait while the user is browsing", async ({ page }) => {
  const canvas = page.locator("canvas.cleanup-map__sunburst");
  await canvas.evaluate((e) => e.setAttribute("data-original-canvas", "true"));
  await page.locator(".cleanup-map__scan-stage").hover();
  const before = await page.locator(".cleanup-map__center-control strong").innerText();
  const signature = (await frames(page)).at(-1)!.pieSignature;
  await page.getByRole("button", { name: "New batch", exact: true }).evaluate((e) => (e as HTMLButtonElement).click());
  await expect(page.getByRole("button", { name: "Update map", exact: true })).toBeVisible();
  await expect(page.locator(".cleanup-map__scan-stage")).toHaveAttribute("data-running", "true");
  await expect(page.locator(".cleanup-map__center-control strong")).toHaveText(before);
  await page.locator("#cleanup-title").hover();
  await expect(page.locator(".cleanup-map__center-control strong")).not.toHaveText(before);
  await expect(canvas).toHaveAttribute("data-original-canvas", "true");
  await expect.poll(async () => (await frames(page)).at(-1)!.pieSignature).not.toBe(signature);
  await page.screenshot({ path: test.info().outputPath("live-scan.png"), fullPage: true });
});

test("scrolling the map under a stationary pointer keeps the existing scan clock running", async ({ page }) => {
  // The desktop scrolls its content pane; the standalone harness clips its document.
  await page.locator(".visual-harness").evaluate((element) => {
    element.style.display = "block";
    element.style.height = "100vh";
    element.style.overflowY = "auto";
  });
  const scene = page.locator(".cleanup-map__scan-stage");
  const before = (await scene.boundingBox())!;
  const pointerY = Math.min(before.y - 16, 680);
  await page.mouse.move(before.x + before.width / 2, pointerY);
  await expect(scene).toHaveAttribute("data-quiet", "false");
  const clock = await head(page);
  await page.mouse.wheel(0, Math.max(180, before.y - pointerY + 40));
  await expect.poll(async () => (await scene.boundingBox())!.y).toBeLessThan(before.y);
  // Refresh Chromium's post-scroll hit test without changing the pointer position.
  await page.mouse.move(before.x + before.width / 2, pointerY);
  await expect(scene).toHaveAttribute("data-quiet", "true");
  await expect(scene).toHaveAttribute("data-running", "true");
  await page.waitForTimeout(350);
  const after = await head(page);
  expect(after.at).toBeGreaterThan(clock.at + 300);
  expectContinuous(clock, after);
});

test("pointer navigation preserves the canvas clock instead of leaving it paused or restarting", async ({ page }) => {
  const clock = await head(page);
  const canvas = page.locator("canvas.cleanup-map__sunburst");
  const width = (await canvas.boundingBox())!.width;
  await canvas.click({ position: { x: width / 2, y: width / 2 - 65 * width / 420 } });
  const center = page.locator(".cleanup-map__center-control");
  await expect(center).toBeEnabled();
  await center.click();
  await page.locator("#cleanup-title").hover();
  await expect(page.locator(".cleanup-map__scan-stage")).toHaveAttribute("data-running", "true");
  expectContinuous(clock, await head(page));
});

test("completion restores paired results even when scanning in list view", async ({ page }) => {
  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.locator(".cleanup-index-list");
  for (const name of ["Users", "demo", "Downloads", "Installers"]) {
    await list.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  }
  await list.locator('input[type="checkbox"]:enabled').first().check();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.locator(".cleanup-map__scan-stage")).toBeVisible();
  await expect(list).toBeVisible();
  await expect(page.locator('.cleanup-map__breadcrumbs [aria-current="page"]')).toHaveText("Installers");
  await expect(page.locator(".cleanup-map__basket-items button")).toHaveCount(1);
});

test("paired results stack when the workspace becomes too narrow", async ({ page }) => {
  await page.locator(".visual-harness").evaluate((element) => { element.style.maxWidth = "650px"; });
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  const chart = (await page.locator(".cleanup-map__scan-stage").boundingBox())!;
  const browser = (await page.locator(".cleanup-index-list").boundingBox())!;
  expect(browser.y).toBeGreaterThanOrEqual(chart.y + chart.height);
  expect(await page.locator(".cleanup-map").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("completion preserves the folder and basket and leaves no continuing scan animations", async ({ page }) => {
  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.locator(".cleanup-index-list");
  for (const name of ["Users", "demo", "Downloads", "Installers"]) {
    await list.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  }
  await list.locator('input[type="checkbox"]:enabled').first().check();
  await expect(page.locator(".cleanup-map__basket-review")).toBeDisabled();
  await page.getByRole("button", { name: "Space map", exact: true }).click();
  const before = await page.locator(".cleanup-map__scan-stage").boundingBox();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.locator('.cleanup-map__breadcrumbs [aria-current="page"]')).toHaveText("Installers");
  await expect(page.locator(".cleanup-map__basket-items button")).toHaveCount(1);
  await expect(page.locator(".cleanup-map__basket-review")).toBeEnabled();
  const after = await page.locator(".cleanup-map__scan-stage").boundingBox();
  await expect(page.locator(".cleanup-map__dropzone")).toHaveCSS("position", "fixed");
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
  await page.waitForTimeout(1_100);
  const count = (await frames(page)).length;
  await page.waitForTimeout(250);
  expect((await frames(page)).length).toBe(count);
  expect(await page.locator(".cleanup-map__scan-stage").evaluate((e) => e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("complete-scan.png"), fullPage: true });
});
