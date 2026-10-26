import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/visual-regression.html?scenario=cleanup-scan-motion&language=en");
});

test("real scan states control motion, including stalled reads and reduced motion", async ({ page }) => {
  const scene = page.locator(".cleanup-map__scan-stage");
  const orbit = page.locator(".scan-fx-orbit").first();
  await expect(scene).toHaveAttribute("data-running", "true");
  await expect.poll(() => orbit.evaluate((e) => getComputedStyle(e).animationName)).toBe("scan-orbit");
  const clock = await orbit.evaluate((e) => { const a = e.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!; a.id = "continuous-orbit"; return a.currentTime as number; });
  await page.waitForTimeout(6800);
  await expect(scene).toHaveAttribute("data-running", "true");
  expect(await orbit.evaluate((e) => e.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!.currentTime as number)).toBeGreaterThan(clock);
  await page.getByRole("button", { name: "New batch", exact: true }).click();
  await expect(scene).toHaveAttribute("data-running", "true");
  await expect(page.locator(".scan-fx-arrival")).toBeVisible();
  expect(await page.locator(".scan-fx-shine").count()).toBeLessThanOrEqual(5);
  for (const label of ["Pause", "Slow folder"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(scene).toHaveAttribute("data-running", "false");
    await expect.poll(() => orbit.evaluate((e) => getComputedStyle(e).animationPlayState)).toBe("paused");
  }
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  expect(await orbit.evaluate((e) => e.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!.id)).toBe("continuous-orbit");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => orbit.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
});

test("live discoveries share the original canvas and wait while the user is browsing", async ({ page }) => {
  const canvas = page.locator("canvas.cleanup-map__sunburst");
  await canvas.evaluate((e) => e.setAttribute("data-original-canvas", "true"));
  await page.locator(".cleanup-map__scan-stage").hover();
  const before = await page.locator(".cleanup-map__center-control strong").innerText();
  await page.getByRole("button", { name: "New batch", exact: true }).evaluate((e) => (e as HTMLButtonElement).click());
  await expect(page.getByRole("button", { name: "Update map", exact: true })).toBeVisible();
  await expect(page.locator(".cleanup-map__scan-stage")).toHaveAttribute("data-running", "true");
  await expect(page.locator(".cleanup-map__center-control strong")).toHaveText(before);
  await page.locator("#cleanup-title").hover();
  await expect(page.locator(".cleanup-map__center-control strong")).not.toHaveText(before);
  await expect(canvas).toHaveAttribute("data-original-canvas", "true");
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
  const orbit = page.locator(".scan-fx-orbit").first();
  const before = (await scene.boundingBox())!;
  const pointerY = Math.min(before.y - 16, 680);
  await page.mouse.move(before.x + before.width / 2, pointerY);
  await expect(scene).toHaveAttribute("data-quiet", "false");
  const clock = await orbit.evaluate((element) => {
    const animation = element.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!;
    animation.id = "scroll-orbit";
    return animation.currentTime as number;
  });
  await page.mouse.wheel(0, Math.max(180, before.y - pointerY + 40));
  await expect.poll(async () => (await scene.boundingBox())!.y).toBeLessThan(before.y);
  // Refresh Chromium's post-scroll hit test without changing the pointer position.
  await page.mouse.move(before.x + before.width / 2, pointerY);
  await expect(scene).toHaveAttribute("data-quiet", "true");
  await expect(scene).toHaveAttribute("data-running", "true");
  await expect.poll(() => orbit.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe("running");
  await page.waitForTimeout(350);
  const after = await orbit.evaluate((element) => {
    const animation = element.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!;
    return { id: animation.id, time: animation.currentTime as number };
  });
  expect(after.id).toBe("scroll-orbit");
  expect(after.time).toBeGreaterThan(clock + 300);
});

test("pointer navigation resumes the existing orbit instead of leaving it paused or restarting", async ({ page }) => {
  const orbit = page.locator(".scan-fx-orbit").first();
  await orbit.evaluate((element) => { element.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!.id = "navigation-orbit"; });
  const canvas = page.locator("canvas.cleanup-map__sunburst");
  const width = (await canvas.boundingBox())!.width;
  await canvas.click({ position: { x: width / 2, y: width / 2 - 65 * width / 420 } });
  const center = page.locator(".cleanup-map__center-control");
  await expect(center).toBeEnabled();
  await center.click();
  await page.locator("#cleanup-title").hover();
  await expect(page.locator(".cleanup-map__scan-stage")).toHaveAttribute("data-running", "true");
  expect(await orbit.evaluate((element) => element.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "scan-orbit")!.id)).toBe("navigation-orbit");
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
  await expect(page.locator(".scan-fx-seal")).toBeVisible();
  const after = await page.locator(".cleanup-map__scan-stage").boundingBox();
  const basket = await page.locator(".cleanup-map__dropzone").boundingBox();
  expect(basket!.y).toBeGreaterThanOrEqual(after!.y + after!.height);
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
  await expect(page.locator(".scan-fx-wave")).toHaveCount(0, { timeout: 2000 });
  expect(await page.locator(".cleanup-map__scan-stage").evaluate((e) => e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("complete-scan.png"), fullPage: true });
});
