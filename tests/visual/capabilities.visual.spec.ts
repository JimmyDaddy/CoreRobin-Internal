import { expect, test } from "@playwright/test";
import { mockAiForBrowser } from "./ai.fixture";
import { BUSINESS_FORM_IDS } from "../../src/capabilities/formCatalog";
import { TOOLBOX_TOOL_IDS } from "../../src/toolbox/contracts";

// Browser/dev data, not native execution or platform availability proof.
test("all catalog forms open shared operations without running model actions", async ({ page }) => {
  test.setTimeout(180_000);
  await mockAiForBrowser(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
  const ids = [...BUSINESS_FORM_IDS, "storage.quick_clean", ...TOOLBOX_TOOL_IDS.map((id) => `toolbox.${id}`)];
  await page.evaluate((formIds) => { (window as unknown as { __aiFixture: { formIds: string[] } }).__aiFixture.formIds = formIds; }, ids);
  const input = page.getByRole("textbox", { name: "Message Robin" });
  await input.fill("Show the available local operation forms"); await input.press("Enter");
  await expect(page.locator(".capability-form-card")).toHaveCount(ids.length);
  await input.fill("Keep my unsent draft");
  for (const id of ids) {
    const card = page.locator(`[data-capability-id="${id}"]`);
    await card.getByRole("button", { name: "Open operation", exact: true }).click();
    const dialog = page.locator(".capability-form-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Loading operation…", { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await dialog.locator(".capability-form-body").innerText()).length).toBeGreaterThan(0);
    // Do not silently accept an operation component crashing into the boundary.
    expect(await dialog.locator(".capability-form-body > [role=alert]").count(), id).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), id).toBe(true);
    if (["settings.privacy", "storage.file_insights", "toolbox.image-editor"].includes(id)) await page.screenshot({ path: `.local-dev/ai-validation/capability-form-${id.replaceAll(".", "-")}.png` });
    await dialog.getByRole("button", { name: "Close operation", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await expect(input).toHaveValue("Keep my unsent draft");
  expect(await page.evaluate(() => (window as unknown as { __aiFixture: { calls: { start: number } } }).__aiFixture.calls.start)).toBe(1);
});

test("JSON entered through a conversation operation is available in the original toolbox", async ({ page }) => {
  await mockAiForBrowser(page); await page.goto("/");
  await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
  await page.evaluate(() => { (window as unknown as { __aiFixture: { formIds: string[] } }).__aiFixture.formIds = ["toolbox.json"]; });
  const input = page.getByRole("textbox", { name: "Message Robin" });
  await input.fill("Open the JSON utility"); await input.press("Enter");
  await page.getByRole("button", { name: "Open operation", exact: true }).click();
  const dialog = page.locator(".capability-form-dialog");
  await dialog.locator("textarea").fill('{"big":900719925474099312345,"source":"local-only"}');
  await dialog.getByRole("button", { name: "Validate and format", exact: true }).click();
  await expect(dialog.locator(".toolbox-result")).toContainText("900719925474099312345");
  await dialog.getByRole("button", { name: "Close operation", exact: true }).click();
  await page.locator(".sidebar .nav-group button").filter({ hasText: "Toolbox" }).click();
  await page.locator('[data-toolbox-open$="-json"]').first().click();
  await expect(page.locator(".toolbox-result")).toContainText("900719925474099312345");
  await expect(page.locator(".toolbox-tool-page textarea")).toHaveValue('{"big":900719925474099312345,"source":"local-only"}');
  expect(await page.evaluate(() => (window as unknown as { __aiFixture: { calls: { start: number } } }).__aiFixture.calls.start)).toBe(1);
});
