import { expect, test } from "@playwright/test";

test("partial maps remain visible, navigable and read-only while scanning", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.goto("/visual-regression.html?scenario=cleanup-progressive&language=en");
  await expect(page.getByText("Partial scan results")).toBeVisible();
  await expect(page.locator(".cleanup-results")).toBeVisible();
  await expect(page.locator(".cleanup-scan-stage")).toBeVisible();
  await expect(page.locator(".cleanup-map__mode button").nth(1)).toBeDisabled();
  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.locator(".cleanup-index-list");
  await expect(list.getByRole("listitem")).toHaveCount(4);
  for (const name of ["Users", "demo", "Downloads", "Installers"]) {
    await list.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  }
  await list.locator('input[type="checkbox"]:enabled').first().check();
  await expect(page.locator(".cleanup-map__basket-review")).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("partial-map.png"), fullPage: true });
  await page.getByRole("button", { name: "Stop scan", exact: true }).click();
  await expect(page.locator(".cleanup-scan-stage")).toBeHidden();
  await expect(page.getByText("Partial scan results")).toBeVisible();
  await expect(page.locator(".cleanup-map__basket-review")).toBeDisabled();
});
