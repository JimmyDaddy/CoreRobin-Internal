import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

export async function captureUiAudit(page: Page, name: string) {
  const directory = ".local-dev/ui-audit-2026-09-08-fixed";
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  const controls = await page.locator("button, select, input, textarea").evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).map((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { tag: element.tagName, className: element.className, label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80), appearance: style.appearance, background: style.backgroundColor, color: style.color, border: style.border, radius: style.borderRadius, font: style.fontSize, height: bounds.height, width: bounds.width, minWidth: style.minWidth, disabled: element.matches(":disabled"), outsideViewport: bounds.right > innerWidth || bounds.left < 0 };
  }));
  await writeFile(`${directory}/${name}.json`, JSON.stringify(controls, null, 2));
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true, animations: "disabled" });
}
