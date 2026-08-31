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

for (const width of [900, 1180]) {
  test(`disk scan list remains stable at ${width}px`, async ({ page }) => {
    await openCleanupResult(page, width);
    await page.getByRole("button", { name: "列表" }).click();
    const list = page.locator(".cleanup-index-list");
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await page.locator("#cleanup-space-map").scrollIntoViewIfNeeded();
    await stabilize(page);
    await expect(list.locator(".cleanup-index-list__frame")).toHaveAttribute("aria-busy", "false");
    await expect(page).toHaveScreenshot(`cleanup-result-list-zh-${width}.png`, {
      animations: "disabled",
      maxDiffPixelRatio: 0.025,
    });

    const height = await list.evaluate((element) => element.getBoundingClientRect().height);
    await list.getByRole("searchbox").fill("no-such-file");
    await expect(list.getByText("当前文件夹没有匹配内容")).toBeVisible();
    expect(await list.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
    await list.getByRole("button", { name: "清空搜索" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await list.getByRole("button", { name: /^Users/ }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await list.getByRole("button", { name: "返回上一级" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(4);
  });
}

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

for (const width of [900, 1180]) {
  test(`scan scope is clear and keyboard accessible at ${width}px`, async ({ page }) => {
    await prepareApp(page, "zh-CN", "simple", false);
    await page.addInitScript(() => window.localStorage.setItem("core-robin.cleanup.recent-targets.v1", JSON.stringify([
      { targetKind: "folder", targetPath: "/Users/demo/Projects/Reports" },
      { targetKind: "folder", targetPath: "/Volumes/Archive/Client Deliverables/2026/Quarterly Reports/Reports" },
    ])));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page.locator(".sidebar .nav-group button").filter({ hasText: "磁盘扫描" }).click();
    const scope = page.locator(".cleanup-targets");
    await expect(scope).toBeVisible();
    await stabilize(page);
    await expect(scope).toHaveScreenshot(`cleanup-scope-system-zh-${width}.png`, { animations: "disabled", maxDiffPixelRatio: 0.005 });
    const complete = scope.getByRole("button", { name: /^完整扫描/ });
    await complete.focus();
    await page.keyboard.press("Enter");
    await expect(complete).toHaveAttribute("aria-pressed", "true");
    await scope.getByRole("button", { name: "Reports /Volumes/Archive/Client Deliverables/2026/Quarterly Reports/Reports" }).click();
    await expect(scope.getByRole("button", { name: "选择文件夹" })).toHaveAttribute("aria-pressed", "true");
    await expect(scope.locator(".cleanup-targets__selected-path small")).toHaveText("/Volumes/Archive/Client Deliverables/2026/Quarterly Reports/Reports");
    expect(await scope.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(scope).toHaveScreenshot(`cleanup-scope-folder-zh-${width}.png`, { animations: "disabled", maxDiffPixelRatio: 0.005 });
    await scope.getByRole("button", { name: /^系统磁盘/ }).click();
    await expect(complete).toHaveAttribute("aria-pressed", "true");
  });
}

test("edited scan scope stays distinct from the existing result when collapsed", async ({ page }) => {
  await openCleanupResult(page, 900);
  const scope = page.locator(".cleanup-targets");
  await scope.getByRole("button", { name: "修改范围" }).click();
  await scope.getByRole("button", { name: /^快速扫描/ }).click();
  await expect(scope.getByText("待扫描")).toBeVisible();
  await scope.getByRole("button", { name: "收起" }).click();
  await expect(scope.getByRole("button", { name: "修改范围" })).toHaveAttribute("aria-expanded", "false");
  await expect(scope.getByText("待扫描")).toBeVisible();
  await expect(page.locator(".cleanup-results")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始只读扫描" })).toBeVisible();
});

for (const stage of ["working", "success", "partial"]) {
  test(`cleanup basket animation: ${stage}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 850 });
    await page.goto(`/visual-regression.html?scenario=cleanup-animation&stage=${stage}&language=zh-CN`);
    await expect(page.locator(`.cleanup-activity.is-${stage}`)).toBeVisible();
    await stabilize(page);
    await page.evaluate(() => document.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = 500;
    }));
    await expect(page).toHaveScreenshot(`cleanup-animation-${stage}-zh-900.png`, {
      animations: "allow",
      maxDiffPixelRatio: 0.001,
    });
  });
}

for (const mode of ["trash", "permanent"]) {
  test(`cleanup files visibly fall into the bin: ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 850 });
    await page.goto(`/visual-regression.html?scenario=cleanup-animation&stage=working&mode=${mode}&language=zh-CN`);
    const file = page.locator(".cleanup-activity__packet").first();
    const bin = page.locator(".cleanup-activity__bin-body");
    await expect(file).toBeAttached();
    await page.evaluate(() => document.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = 500;
    }));
    const binBounds = (await bin.boundingBox())!;
    const airborneBounds = (await file.boundingBox())!;
    expect(airborneBounds.y + airborneBounds.height).toBeLessThan(binBounds.y);
    expect(airborneBounds.x).toBeLessThan(binBounds.x);
    await file.evaluate((element) => { element.getAnimations()[0].currentTime = 1488; });
    const swallowedBounds = (await file.boundingBox())!;
    expect(swallowedBounds.x).toBeGreaterThan(binBounds.x);
    expect(swallowedBounds.x + swallowedBounds.width).toBeLessThan(binBounds.x + binBounds.width);
    expect(swallowedBounds.y).toBeGreaterThan(binBounds.y);
    expect(await file.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    await expect(page.locator(".cleanup-activity__shred")).toHaveCount(mode === "permanent" ? 9 : 0);
    if (mode === "trash") {
      await file.evaluate((element) => { element.getAnimations()[0].currentTime = 500; });
      await expect(page).toHaveScreenshot("cleanup-animation-trash-zh-900.png", { animations: "allow", maxDiffPixelRatio: 0.025 });
    }
  });
}

test("cleanup animation respects reduced motion and keeps its close action visible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 600, height: 620 });
  await page.goto("/visual-regression.html?scenario=cleanup-animation&stage=success&language=zh-CN");
  await expect(page.getByLabel("8.4 GB", { exact: true })).toHaveText("8.4 GB");
  await expect(page.locator(".cleanup-activity__burst")).toBeHidden();
  const activity = page.locator(".cleanup-activity");
  expect(await activity.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.getByRole("button", { name: "working", exact: true }).click();
  await expect(page.locator(".cleanup-activity__packets")).toBeHidden();
  await expect(page.locator(".cleanup-activity__shreds")).toBeHidden();
  expect(await activity.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.getByRole("button", { name: "停止删除" }).click();
  await expect(page.getByRole("heading", { name: "清理已停止" })).toBeVisible();
  await expect(page.locator(".cleanup-activity__burst")).toHaveCount(0);
});

test("cleanup basket transitions from confirmed work to a reusable receipt", async ({ page }) => {
  await openCleanupResult(page, 1180);
  await page.getByRole("button", { name: "列表" }).click();
  const list = page.locator(".cleanup-index-list");
  for (const name of ["Users", "demo", "Downloads", "Installers"]) {
    await list.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  }
  await list.getByRole("checkbox", { name: /加入清理篮: macOS.dmg/ }).check();
  await page.getByRole("button", { name: "选择删除方式" }).click();
  await page.getByRole("button", { name: "移到废纸篓（1 项）" }).click();
  await expect(page.locator(".cleanup-activity.is-working")).toBeVisible();
  await expect(page.getByRole("heading", { name: "清理完成", exact: true })).toBeVisible();
  await expect(page.getByText("已移到废纸篓", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.getByRole("button", { name: "查看结算" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".cleanup-activity__burst")).toHaveCount(0);
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
