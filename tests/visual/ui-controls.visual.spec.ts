import { expect, test, type Locator } from "@playwright/test";
import { mockAiForBrowser } from "./ai.fixture";
import { captureUiAudit } from "./ui-audit";

async function noOverlap(locator: Locator) {
  const collisions = await locator.evaluateAll((elements) => {
    const visible = elements.filter((element) => element.getClientRects().length > 0);
    const result: string[] = [];
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i].getBoundingClientRect(), b = visible[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) result.push(`${visible[i].textContent} / ${visible[j].textContent}`);
    }
    return result;
  });
  expect(collisions).toEqual([]);
}

for (const config of [{ width: 900, language: "en", large: false }, { width: 900, language: "de", large: false }, { width: 900, language: "zh-CN", large: true }, { width: 1440, language: "en", large: false }]) {
  test(`settings and process controls fit ${config.width}px ${config.language} ${config.large ? "large" : "normal"}`, async ({ page }) => {
    await mockAiForBrowser(page);
    await page.addInitScript(({ language, large }) => {
      localStorage.setItem("core-robin.language.v1", language);
      localStorage.setItem("core-robin.settings.v1", JSON.stringify({ version: 1, language, experienceMode: "professional", interfaceScale: large ? "large" : "comfortable", reduceMotion: true }));
    }, config);
    await page.setViewportSize({ width: config.width, height: 900 });
    await page.goto("/");
    const navigation = page.locator(".sidebar .nav-group button");
    await navigation.last().click();
    const fields = page.locator(".settings-interface-control");
    await expect(fields).toHaveCount(2);
    await noOverlap(fields);
    for (const field of await fields.all()) {
      await noOverlap(field.locator(":scope > span, :scope > .settings-segmented"));
      expect(await field.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.children].every((child) => { const bounds = child.getBoundingClientRect(); return bounds.left >= box.left && bounds.right <= box.right; });
      })).toBe(true);
    }
    await captureUiAudit(page, `fixed-settings-${config.width}-${config.language}-${config.large}`);
    await navigation.nth(2).click();
    const panel = page.locator(".process-panel");
    await expect(panel.locator(".process-view-controls button")).toHaveCount(7);
    await noOverlap(panel.locator(".process-view-controls button, .search-field"));
    expect(await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll(".process-view-controls button")].every((button) => { const bounds = button.getBoundingClientRect(); return bounds.left >= box.left && bounds.right <= box.right; });
    })).toBe(true);
    await captureUiAudit(page, `fixed-process-${config.width}-${config.language}-${config.large}`);
  });
}

test("embedded forms keep native styles, aligned layouts and switch semantics", async ({ page }) => {
  await mockAiForBrowser(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
  const input = page.getByRole("textbox", { name: "Message Robin" });
  await expect(input).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __aiFixture: { formIds: string[] } }).__aiFixture.formIds = ["processes.control", "settings.privacy", "toolbox.color"]; });
  await input.fill("Open forms for inspection"); await input.press("Enter");
  for (const id of ["processes.control", "settings.privacy", "toolbox.color"]) {
    await page.locator(`[data-capability-id="${id}"]`).getByRole("button", { name: "Open operation", exact: true }).click();
    const dialog = page.locator(".capability-form-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Loading operation…", { exact: true })).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.closest(".ai-assistant"))).toBeNull();
    if (id === "processes.control") {
      await expect(dialog.locator(".search-field input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(dialog.locator(".search-field input")).toHaveCSS("padding", "0px");
    } else if (id === "settings.privacy") {
      const toggle = dialog.getByRole("switch").first();
      await expect(toggle).toHaveCSS("width", "36px");
      expect(await toggle.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
      expect(await dialog.locator(".button--danger-ghost").first().evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    } else {
      await expect(dialog.locator(".toolbox-tool-layout")).toHaveCSS("margin-left", "0px");
      const action = dialog.locator(".toolbox-tool-layout__body > .button");
      await expect(action).toHaveCSS("justify-self", "start");
    }
    await captureUiAudit(page, `fixed-${id}`);
    await dialog.getByRole("button", { name: "Close operation", exact: true }).click();
    await expect(page.locator(`[data-capability-id="${id}"]`).getByRole("button", { name: "Open operation", exact: true })).toBeFocused();
  }
});

for (const compact of [false, true]) {
  test(`shared selectors and capability colors in ${compact ? "Robin" : "main"}`, async ({ page }) => {
    await mockAiForBrowser(page, compact);
    await page.setViewportSize(compact ? { width: 400, height: 540 } : { width: 1180, height: 900 });
    await page.goto(compact ? "/robin-chat.html" : "/");
    if (!compact) await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
    const input = page.getByRole("textbox", { name: "Message Robin" });
    await expect(input).toBeEnabled();
    const select = page.locator(".ai-history-period select");
    await expect(select).toHaveCSS("appearance", "none");
    await expect(select).toHaveCSS("min-height", "30px");
    await select.focus();
    await expect(select).toHaveCSS("outline-style", "solid");
    const checkbox = page.locator(".ai-check input");
    await checkbox.focus(); await checkbox.press("Space");
    await expect(checkbox).not.toBeChecked();
    await checkbox.press("Space"); await expect(checkbox).toBeChecked();
    await page.evaluate(() => { (window as unknown as { __aiFixture: { toolCards: boolean } }).__aiFixture.toolCards = true; });
    await input.fill("Inspect storage"); await input.press("Enter");
    const disk = page.locator(".capability-result--disk");
    await expect(disk.locator(".capability-result-meta")).toHaveCSS("color", "rgb(111, 124, 134)");
    await expect(disk.locator(".capability-warning").first()).toHaveCSS("color", "rgb(239, 182, 94)");
    await disk.scrollIntoViewIfNeeded();
    await captureUiAudit(page, compact ? "fixed-robin-controls" : "fixed-main-controls");
  });
}
