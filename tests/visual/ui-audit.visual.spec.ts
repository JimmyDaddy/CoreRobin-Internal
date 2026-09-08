import { expect, test } from "@playwright/test";
import { mockAiForBrowser } from "./ai.fixture";
import { captureUiAudit } from "./ui-audit";

for (const width of [900, 1440]) {
  test(`inspect every navigation page at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await mockAiForBrowser(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const navigation = page.locator(".sidebar .nav-group button");
    await expect(navigation.first()).toBeVisible();
    const names = await navigation.allTextContents();
    for (let index = 0; index < names.length; index++) {
      await navigation.nth(index).click();
      await expect(page.locator(".surface-loading")).toHaveCount(0);
      await captureUiAudit(page, `nav-${width}-${index}-${names[index].trim().replace(/[^a-z0-9]/gi, "-")}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    for (let index = 0; index < await page.locator(".settings-section-tabs button").count(); index++) {
      await page.locator(".settings-section-tabs button").nth(index).click();
      await captureUiAudit(page, `settings-${width}-${index}`);
    }
    await page.locator(".settings-section-tabs button").first().click();
    await page.getByRole("button", { name: "AI settings", exact: true }).click();
    await expect(page.locator(".ai-settings")).toBeVisible();
    await captureUiAudit(page, `ai-settings-${width}`);
  });
}
