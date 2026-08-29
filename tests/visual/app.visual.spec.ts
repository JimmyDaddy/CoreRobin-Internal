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

test("application center and task center at compact desktop width", async ({ page }) => {
  await prepareApp(page, "en", "professional", false);
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "Apps" }).click();
  await expect(page.locator(".application-center")).toBeVisible();
  await page.locator(".global-task-center__trigger").click();
  await expect(page.locator(".global-task-center__popover")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("application-center-task-center-en-900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});

test("startup inventory at compact desktop width", async ({ page }) => {
  await prepareApp(page, "en", "professional", false);
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "Startup" }).click();
  await expect(page.locator(".startup-explorer")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("startup-en-900.png", {
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
    // Dense CJK text produces stable cross-platform antialiasing differences.
    // Keep the extra tolerance scoped to this scenario; layout changes still fail.
    maxDiffPixelRatio: 0.025,
  });
});

test("disk scan result map at compact desktop width", async ({ page }) => {
  await openCleanupResult(page, 900);
  await page.locator(".cleanup-result-overview").scrollIntoViewIfNeeded();
  await stabilize(page);
  await expect(page).toHaveScreenshot("cleanup-result-map-zh-900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.025,
  });
});

test("disk scan list uses the full result width", async ({ page }) => {
  await openCleanupResult(page, 1180);
  await page.getByRole("button", { name: "列表" }).click();
  await expect(page.locator(".cleanup-map__workspace.is-list")).toBeVisible();
  await page.locator("#cleanup-space-map").scrollIntoViewIfNeeded();
  await stabilize(page);
  await expect(page).toHaveScreenshot("cleanup-result-list-zh-1180.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.025,
  });
});

test("reclaimable summary opens an honest category breakdown", async ({ page }) => {
  await openCleanupResult(page, 900);
  await page.getByRole("button", { name: /可能可回收空间.*查看构成/ }).click();
  await expect(page.locator(".cleanup-map__active-filter")).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("cleanup-reclaimable-categories-zh-900.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.025,
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

async function openCleanupResult(page: Page, width: number) {
  await prepareApp(page, "zh-CN", "simple", false);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "磁盘扫描" }).click();
  await expect(page.locator(".cleanup-assistant")).toBeVisible();
  await page.getByRole("button", { name: "开始只读扫描" }).click();
  await expect(page.locator(".cleanup-results")).toBeVisible();
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
