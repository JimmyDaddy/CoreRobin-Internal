import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { mockAiForBrowser } from "./ai.fixture";

const output = ".local-dev/ai-validation";
async function capture(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${output}/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}

for (const compact of [false, true]) {
  test(`${compact ? "Robin" : "Main"} application cards show operations, preserve drafts and require confirmation`, async ({ page }) => {
    await mockAiForBrowser(page, compact);
    await page.setViewportSize(compact ? { width: 400, height: 540 } : { width: 1180, height: 900 });
    await page.goto(compact ? "/robin-chat.html" : "/");
    if (!compact) await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
    const input = page.getByRole("textbox", { name: "Message Robin" });
    await expect(input).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { __aiFixture: { toolCards: boolean } }).__aiFixture.toolCards = true; });
    await input.fill("Inspect my device and storage.");
    await input.press("Enter");
    await expect(page.locator(".capability-result")).toHaveCount(5);
    const card = page.locator(".capability-result--disk");
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText("Downloads", { exact: true })).toBeVisible();
    expect(await card.locator("pre").count()).toBe(0);
    await capture(page, compact ? "capability-cards-robin-400" : "capability-cards-main");
    await input.fill("Keep this draft for my next question");
    await card.getByRole("checkbox", { name: "Application caches" }).check();
    await card.getByRole("button", { name: "Move selected items to trash" }).click();
    await expect(page.getByText("/synthetic/Application caches", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("Keep this draft for my next question");
    const snapshot = await page.evaluate(() => (window as unknown as { __aiFixture: { calls: { start: number }; cardActions: { targetRefs: string[] }[]; decisions: unknown[] } }).__aiFixture);
    expect(snapshot.calls.start).toBe(1);
    expect(snapshot.cardActions[0].targetRefs).toEqual(["disk-2"]);
    expect(snapshot.decisions).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("AI settings and main assistant use explicit requests, previews and history", async ({
  page,
}) => {
  await mockAiForBrowser(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/");
  await page
    .locator(".sidebar .nav-group button")
    .filter({ hasText: "AI assistant" })
    .click();
  await expect(page.locator(".ai-assistant")).toBeVisible();
  await page.getByRole("button", { name: "AI settings", exact: true }).click();
  await expect(page.locator(".ai-settings")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await capture(page, "settings-desktop");
  await expect(
    page.getByRole("button", { name: "Refresh model list" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Refresh model list" }).click();
  await page.getByRole("button", { name: "Back · AI assistant" }).click();
  await page
    .getByRole("textbox", { name: "Message Robin" })
    .fill("Why does my device feel slow?");
  await page.getByRole("button", { name: "Review message", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Review what will be sent" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Review what will be sent" })
      .getByRole("button", { name: "Send", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __aiFixture: { calls: { start: number } } })
          .__aiFixture.calls.start,
    ),
  ).toBe(0);
  await capture(page, "preview-desktop");
  await page
    .getByRole("region", { name: "Review what will be sent" })
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect(
    page.getByText(/Your current CPU and memory usage/),
  ).toBeVisible();
  await capture(page, "conversation-desktop");
  await page
    .getByRole("button", { name: "Clear all conversations", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByText(/Your current CPU and memory usage/),
  ).toBeVisible();
});

test("400x540 Robin chat supports history scope, IME, failures and handoff", async ({
  page,
}) => {
  await mockAiForBrowser(page, true);
  await page.setViewportSize({ width: 400, height: 540 });
  await page.goto("/robin-chat.html");
  await expect(page.locator(".ai-assistant")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message Robin" }),
  ).toBeEnabled();
  await capture(page, "robin-empty-400");
  await page
    .getByRole("combobox", { name: "Device context" })
    .selectOption("history");
  const input = page.getByRole("textbox", { name: "Message Robin" });
  await input.fill("Explain the recent history.");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __aiFixture: { calls: { prepare: number } } })
          .__aiFixture.calls.prepare,
    ),
  ).toBe(0);
  await input.dispatchEvent("compositionend");
  await page.getByRole("button", { name: "Review message", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Review what will be sent" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Review what will be sent" })
      .getByRole("button", { name: "Send", exact: true }),
  ).toBeInViewport();
  await capture(page, "robin-preview-400");
  await page.evaluate(() => {
    (
      window as unknown as { __aiFixture: { failNext: boolean } }
    ).__aiFixture.failNext = true;
  });
  await page
    .getByRole("region", { name: "Review what will be sent" })
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await capture(page, "robin-failure-400");
  await page
    .getByRole("region", { name: "Review what will be sent" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Conversation history", exact: true })
    .click();
  await expect(page.locator(".ai-history")).toBeVisible();
  await capture(page, "robin-history-400");
  await page
    .locator(".ai-history")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue in main window", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __aiNavigation?: { sessionId: string } })
            .__aiNavigation?.sessionId,
      ),
    )
    .toBe("chat-1");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 400),
  ).toBe(true);
});

for (const compact of [false, true]) {
  test(`${compact ? "Robin bubble" : "Main assistant"} sends with device context on Enter without a confirmation step`, async ({ page }) => {
    await mockAiForBrowser(page, compact);
    await page.setViewportSize(compact ? { width: 400, height: 540 } : { width: 1180, height: 720 });
    await page.goto(compact ? "/robin-chat.html" : "/");
    if (!compact) {
      await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
    }
    const input = page.getByRole("textbox", { name: "Message Robin" });
    await expect(input).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: "Include selected device context" })).toBeChecked();
    await input.fill("Explain the current device data.");
    await input.press("Enter");
    await expect(page.getByText(/Your current CPU and memory usage/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Review what will be sent" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __aiFixture: { calls: { start: number } } }).__aiFixture.calls.start)).toBe(1);
    await expect(input).toBeInViewport({ ratio: 1 });
    await capture(page, compact ? "robin-direct-send-400" : "main-direct-send");
  });
}

async function seedLongConversation(page: Page) {
  await page.evaluate(async () => {
    const modulePath = "/src/ai/api.ts";
    const { aiApi } = await import(modulePath);
    const originalGetSession = aiApi.getSession;
    aiApi.getSession = async (id: string) => {
      const session = await originalGetSession(id);
      return {
        ...session,
        messages: Array.from({ length: 12 }, (_, turn) => {
          const shared = {
            createdAt: 1_700_000_000_000 + turn * 1000,
            status: "complete",
            requestId: `layout-run-${turn}`,
            sourceCategories: [],
            reusableInContext: true,
            usage: null,
          };
          return [
            {
              ...shared,
              id: `layout-user-${turn}`,
              role: "user",
              content: `Round ${turn + 1}: Explain the recent CPU, memory, disk and network measurements in detail.\n\nCompare the observations carefully and describe what additional evidence would distinguish an application bottleneck from background activity.`,
              modelLabel: null,
            },
            {
              ...shared,
              id: `layout-assistant-${turn}`,
              role: "assistant",
              content: Array.from(
                { length: 6 },
                (_, paragraph) =>
                  `Round ${turn + 1}, observation ${paragraph + 1}. The available measurements describe this device at a particular moment and should be compared with several samples before drawing conclusions. CPU utilization, memory pressure, disk throughput and network activity each provide a different part of the picture. A quiet aggregate reading does not rule out an application waiting for external work. Compare the same task under similar conditions and retain the relevant time range so the next observation can be interpreted accurately.`,
              ).join("\n\n"),
              modelLabel: "my-local-model",
            },
          ];
        }).flat(),
      };
    };
  });
}

for (const viewport of [
  { width: 1180, height: 720 },
  { width: 960, height: 640 },
]) {
  test(`${viewport.width}x${viewport.height} long main chat keeps the composer visible and settings scrollable`, async ({
    page,
  }) => {
    await mockAiForBrowser(page);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await seedLongConversation(page);
    await page
      .locator(".sidebar .nav-group button")
      .filter({ hasText: "AI assistant" })
      .click();
    await expect(page.locator(".ai-message--assistant")).toHaveCount(12);
    await expect(page.locator(".ai-message--user")).toHaveCount(12);

    const input = page.getByRole("textbox", { name: "Message Robin" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    // Assert before interacting: filling/clicking can otherwise scroll an
    // oversized outer workspace and conceal the composer regression.
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    const main = page.locator(".main-content");
    const messages = page.locator(".ai-messages");
    const outer = await main.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      bottom: element.getBoundingClientRect().bottom,
    }));
    expect(outer.scrollHeight).toBeLessThanOrEqual(outer.clientHeight + 1);
    expect(outer.scrollTop).toBe(0);
    expect(outer.bottom).toBeLessThanOrEqual(viewport.height);
    const messageArea = await messages.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(messageArea.clientHeight).toBeGreaterThan(0);
    expect(messageArea.scrollHeight).toBeGreaterThan(messageArea.clientHeight);
    expect(["auto", "scroll"]).toContain(messageArea.overflowY);
    await messages.evaluate((element) => { element.scrollTop = 0; });
    await messages.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    await capture(page, `conversation-long-${viewport.width}x${viewport.height}`);

    await page.getByRole("button", { name: "AI settings", exact: true }).click();
    await expect(page.locator(".ai-settings")).toBeVisible();
    const settingsScrollRange = await main.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(settingsScrollRange).toBeGreaterThan(0);
    const clear = page.locator(".ai-settings").getByRole("button", {
      name: "Clear all conversations", exact: true,
    });
    await clear.scrollIntoViewIfNeeded();
    await expect(clear).toBeInViewport({ ratio: 1 });
    expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Back · AI assistant" }).click();
    await expect(page.locator(".ai-message--assistant")).toHaveCount(12);
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  });
}

for (const compact of [false, true]) {
  test(`tool progress and native confirmation stay usable in ${compact ? "400x540 chat" : "main assistant"}`, async ({ page }) => {
    await mockAiForBrowser(page, compact);
    await page.setViewportSize(compact ? { width: 400, height: 540 } : { width: 1180, height: 900 });
    await page.goto(compact ? "/robin-chat.html" : "/");
    if (!compact) await page.locator(".sidebar .nav-group button").filter({ hasText: "AI assistant" }).click();
    await expect(page.getByRole("textbox", { name: "Message Robin" })).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { __aiFixture: { toolTask: boolean } }).__aiFixture.toolTask = true; });
    await page.getByRole("textbox", { name: "Message Robin" }).fill("Check the busy application and ask me before closing it.");
    await page.getByRole("textbox", { name: "Message Robin" }).press("Enter");
    await expect(page.getByText("Synthetic editor · PID 12345", { exact: true })).toBeVisible();
    if (!compact) {
      await page.locator(".global-task-center__trigger:visible").click();
      await expect(page.locator(".global-task-center__popover").getByText("Robin task", { exact: true })).toBeVisible();
      await page.locator(".global-task-center__popover").getByRole("button", { name: "Return to task", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Message Robin" })).toHaveValue("");
    }
    const approve = page.getByRole("button", { name: "Confirm action", exact: true });
    const decline = page.getByRole("button", { name: "Decline", exact: true });
    await decline.scrollIntoViewIfNeeded();
    await expect(approve).toBeInViewport();
    await expect(decline).toBeInViewport();
    await expect(page.getByText("Synthetic editor · PID 12345", { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => (window as unknown as { __aiFixture: { decisions: unknown[] } }).__aiFixture.decisions)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, compact ? "task-confirmation-400" : "task-confirmation-desktop");
    await decline.click();
    await expect(page.getByText("The close request was declined. No process was stopped.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __aiFixture: { decisions: { approved: boolean }[] } }).__aiFixture.decisions.map(item => item.approved))).toEqual([false]);
    await capture(page, compact ? "task-declined-400" : "task-declined-desktop");
  });
}
