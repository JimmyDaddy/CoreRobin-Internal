import { expect, test, type Locator, type Page } from "@playwright/test";

async function openResult(page: Page, width: number, presentation: "map" | "list" = "list") {
  await page.addInitScript(() => {
    localStorage.setItem("core-robin.onboarding.v1", "completed");
    localStorage.setItem("core-robin.update-check.checked-at.v1", String(Date.now()));
    localStorage.setItem("core-robin.settings.v1", JSON.stringify({ version: 1, language: "zh-CN", experienceMode: "simple", reduceMotion: false }));
  });
  await page.setViewportSize({ width, height: 768 });
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "磁盘扫描" }).click();
  await page.getByRole("button", { name: "开始只读扫描" }).click();
  await expect(page.locator(".cleanup-results")).toBeVisible();
  if (presentation === "list") await page.getByRole("button", { name: "列表", exact: true }).click();
}

for (const width of [1040, 1180, 1440, 1920, 2560]) {
  test(`completed scan pairs the chart with a searchable browser at ${width}px`, async ({ page }) => {
    await openResult(page, width, "map");
    const chart = page.locator(".cleanup-map__scan-stage");
    const list = page.locator(".cleanup-index-list");
    await expect(chart).toBeVisible();
    await expect(list).toBeVisible();
    const plot = (await chart.boundingBox())!;
    const browser = (await list.boundingBox())!;
    const basket = page.locator(".cleanup-map__dropzone");
    expect(browser.x).toBeGreaterThanOrEqual(plot.x + plot.width);
    expect(Math.abs(browser.y - plot.y)).toBeLessThanOrEqual(2);
    expect(browser.width).toBeLessThanOrEqual(340);
    const canvas = (await page.locator(".cleanup-map__canvas").boundingBox())!;
    const toolbar = (await page.locator(".cleanup-map__browser-toolbar").boundingBox())!;
    expect(Math.abs(browser.x + browser.width - canvas.x - canvas.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(browser.x + browser.width - toolbar.x - toolbar.width)).toBeLessThanOrEqual(2);
    await expect(basket).toHaveCSS("position", "fixed");
    await expect(basket).toHaveClass(/is-collapsed/);
    await expect(list.locator(".cleanup-map__legend")).toBeVisible();
    await expect(list.locator(".cleanup-index-list__columns, .cleanup-index-list__summary, .cleanup-index-list__toolbar, input[type='checkbox']")).toHaveCount(0);
    for (const name of ["Users", "demo", "Downloads", "Installers"]) {
      await list.getByRole("button", { name: new RegExp(`^${name} `) }).click();
    }
    await expect(page.locator(".cleanup-map__center-control")).toContainText("Installers");
    await page.getByRole("searchbox").fill("macOS");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(chart).toBeVisible();
    await dragToBasket(page, list.getByRole("button", { name: /^macOS.dmg / }));
    await expect(basket).toHaveClass(/is-active/);
    await page.mouse.up();
    await expect(page.locator(".cleanup-map__basket-items")).toContainText("macOS.dmg");
    await expect(page.locator(".cleanup-map__center-control")).toContainText("Installers");
    await expect(basket).not.toHaveClass(/is-collapsed/);
    const basketBeforeScroll = (await basket.boundingBox())!;
    await page.mouse.move(plot.x + plot.width / 2, plot.y + 20);
    await page.mouse.wheel(0, 240);
    await expect.poll(async () => Math.abs((await basket.boundingBox())!.y - basketBeforeScroll.y)).toBeLessThanOrEqual(2);
    expect(await page.locator(".cleanup-map").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`completed-split-${width}.png`), fullPage: true });
  });
}

async function dragToBasket(page: Page, source: Locator, position?: { x: number; y: number }) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + (position?.x ?? from.width / 2), from.y + (position?.y ?? from.height / 2));
  await page.mouse.down();
  await page.mouse.move(from.x + (position?.x ?? from.width / 2) + 24, from.y + (position?.y ?? from.height / 2), { steps: 3 });
  await expect(page.locator(".cleanup-map__dropzone")).toHaveClass(/is-dragging/);
  const basket = (await page.locator(".cleanup-map__dropzone").boundingBox())!;
  await page.mouse.move(basket.x + basket.width / 2, basket.y + basket.height / 2, { steps: 16 });
}

for (const width of [900, 1180]) {
  test(`scan workspace preserves map and list dragging at ${width}px`, async ({ page }) => {
    await openResult(page, width);
    const map = page.locator(".cleanup-map");
    const list = page.locator(".cleanup-index-list");
    const basket = page.locator(".cleanup-map__dropzone");

    await dragToBasket(page, list.locator(".cleanup-index-list__select").filter({ hasText: "System" }));
    await expect(basket).toHaveClass(/is-protected-drag/);
    await page.mouse.up();
    await expect(basket).toHaveClass(/is-blocked/);
    await expect(basket.locator(".cleanup-map__basket-items button")).toHaveCount(0);

    for (const name of ["Users", "demo", "Downloads", "Installers"]) {
      await list.getByRole("button", { name: `进入 ${name}`, exact: true }).click();
    }
    await list.locator(".cleanup-index-list__select").filter({ hasText: "macOS.dmg" }).click();
    const selection = map.locator(".cleanup-map__selection");
    await expect(selection).toContainText("macOS.dmg");
    await selection.getByRole("button", { name: "空间明细", exact: true }).click();
    const details = page.getByRole("dialog", { name: "空间明细", exact: true });
    await expect(details).toContainText("macOS.dmg");
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(selection.getByRole("button", { name: "空间明细", exact: true })).toBeFocused();

    await dragToBasket(page, list.locator(".cleanup-index-list__select").filter({ hasText: "macOS.dmg" }));
    await expect(basket).toHaveClass(/is-active/);
    await page.mouse.up();
    await expect(basket.locator(".cleanup-map__basket-items")).toContainText("macOS.dmg");
    await basket.locator(".cleanup-map__basket-clear").click();

    await map.getByRole("button", { name: "空间图", exact: true }).click();
    const canvas = map.locator("canvas.cleanup-map__sunburst");
    await expect(canvas).toBeVisible();
    await map.locator(".cleanup-map__chart-frame").scrollIntoViewIfNeeded();
    const bounds = (await canvas.boundingBox())!;
    const angle = -Math.PI / 2 + 4.1 / 5.94 * Math.PI;
    const radius = 67 * bounds.width / 420;
    await dragToBasket(page, canvas, { x: bounds.width / 2 + radius * Math.cos(angle), y: bounds.width / 2 + radius * Math.sin(angle) });
    await expect(basket).toHaveClass(/is-active/);
    await page.mouse.up();
    await expect(basket.locator(".cleanup-map__basket-items")).toContainText("macOS.dmg");
    expect(await map.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(basket).toHaveCSS("position", "fixed");
    await page.screenshot({ path: test.info().outputPath(`workspace-${width}.png`), fullPage: true });
  });
}
