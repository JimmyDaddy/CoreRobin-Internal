import { expect, test, type Page } from "@playwright/test";

// Browser fixtures verify interaction and layout, never native cleanup or CPU.
async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("core-robin.onboarding.v1", "completed");
    localStorage.setItem("core-robin.update-check.checked-at.v1", String(Date.now()));
    localStorage.setItem("core-robin.settings.v1", JSON.stringify({ version: 1, language: "zh-CN", experienceMode: "simple", reduceMotion: true }));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.locator(".daily-home")).toBeVisible();
}

test("the current problem and action fit a short desktop, and intentional sleep can be undone", async ({ page }) => {
  await openApp(page);
  const action = page.locator(".daily-companion-hero__actions .button--primary");
  await expect(action).toHaveText(/看看原因/);
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThan(720);
  await action.click();
  await page.getByText("查看保持唤醒的任务", { exact: true }).click();
  await expect(page.getByText("Electron", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "这是我计划中的任务", exact: true }).click();
  await expect(page.getByText("已将你确认的任务从提醒中排除，电脑仍会保持唤醒。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "已按计划保持唤醒（点击撤销）", exact: true }).click();
  await expect(page.getByRole("button", { name: "这是我计划中的任务", exact: true })).toBeVisible();
});

test("quick cleanup is opt-in for Trash and reviews kept sources before any deletion", async ({ page }, testInfo) => {
  await openApp(page);
  await page.locator(".sidebar .nav-group button").filter({ hasText: "快速清理" }).click();
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("button", { name: /废纸篓.*219/ })).toHaveAttribute("aria-pressed", "false");
  await page.getByText("查看来源与选择保留", { exact: true }).first().click();
  await page.getByRole("checkbox", { name: /保留.*example.app/ }).check();
  await page.getByRole("button", { name: "清理 579.8 MB", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认快速清理" });
  await expect(confirmation.getByText("保留 1 个位置（所在目录也会保留）")).toBeVisible();
  await expect(confirmation.locator("li").filter({ hasText: "废纸篓" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("quick-clean-review.png") });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByText("清理完成", { exact: true })).toHaveCount(0);
});

test("the toolbox presents usable tools first and keeps a recently opened tool accessible", async ({ page }) => {
  await openApp(page);
  await page.locator(".sidebar .nav-group button").filter({ hasText: "工具箱" }).click();
  const ready = page.locator("section[aria-labelledby=toolbox-section-ready]");
  await expect(ready.locator(".toolbox-card")).toHaveCount(6);
  await expect(ready.locator(".toolbox-card--unavailable")).toHaveCount(0);
  await page.getByText("JSON", { exact: true }).click();
  await page.getByRole("button", { name: "返回工具箱", exact: true }).click();
  await expect(ready.locator(".toolbox-card").first()).toContainText("JSON");
});
