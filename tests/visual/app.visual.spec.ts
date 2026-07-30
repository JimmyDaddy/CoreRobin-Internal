import { expect, test, type Page } from "@playwright/test";

const widths = [900, 1180, 1440, 1920] as const;

for (const width of widths) {
  test(`everyday overview at ${width}px`, async ({ page }) => {
    await prepareApp(page, "zh-CN", "simple", false);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".app-shell--daily")).toBeVisible();
    await stabilize(page);
    await expect(page).toHaveScreenshot(`daily-zh-${width}.png`, {
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
    });
  });
}

test("professional overview in English", async ({ page }) => {
  await prepareApp(page, "en", "professional", false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".app-shell--professional")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("professional-en-1440.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});

test("loading, error, empty, complete and chart-gap states", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/visual-regression.html?scenario=states&language=en");
  await expect(page.locator(".visual-harness__chart")).toBeVisible();
  await page.getByRole("button", { name: "Retry failed operation" }).hover();
  await stabilize(page);
  await expect(page).toHaveScreenshot("states-en-1180.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});

test("long action outcomes in Chinese with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.goto("/visual-regression.html?scenario=review&language=zh-CN");
  await expect(page.locator(".today-review")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("review-zh-reduced-motion-900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});

test("history export privacy preview at compact width", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/visual-regression.html?scenario=export&language=zh-CN");
  await expect(page.locator(".history-export")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("history-export-zh-900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});

async function prepareApp(
  page: Page,
  language: string,
  experienceMode: "simple" | "professional",
  reduceMotion: boolean,
) {
  await page.addInitScript(({ language, experienceMode, reduceMotion }) => {
    window.localStorage.setItem("core-robin.onboarding.v1", "completed");
    window.localStorage.setItem("core-robin.update-check.checked-at.v1", String(Date.now()));
    window.localStorage.setItem("core-robin.settings.v1", JSON.stringify({
      version: 1,
      language,
      experienceMode,
      reduceMotion,
    }));
  }, { language, experienceMode, reduceMotion });
}

async function stabilize(page: Page) {
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      body, button, input, select, textarea { font-family: Arial, sans-serif !important; }
    `,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1_200);
}
