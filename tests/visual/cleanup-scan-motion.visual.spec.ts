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
  await expect(scene).toHaveAttribute("data-running", "false", { timeout: 9000 });
  await page.getByRole("button", { name: "New batch", exact: true }).click();
  await expect(scene).toHaveAttribute("data-running", "true");
  await expect(page.locator(".scan-fx-arrival")).toBeVisible();
  expect(await page.locator(".scan-fx-shine").count()).toBeLessThanOrEqual(5);
  for (const label of ["Pause", "Slow folder"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(scene).toHaveAttribute("data-running", "false");
    await expect.poll(() => orbit.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  }
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
  await expect(page.locator(".cleanup-map__scan-stage")).toHaveAttribute("data-running", "false");
  await expect(page.locator(".cleanup-map__center-control strong")).toHaveText(before);
  await page.locator("#cleanup-title").hover();
  await expect(page.locator(".cleanup-map__center-control strong")).not.toHaveText(before);
  await expect(canvas).toHaveAttribute("data-original-canvas", "true");
  await page.screenshot({ path: test.info().outputPath("live-scan.png"), fullPage: true });
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
