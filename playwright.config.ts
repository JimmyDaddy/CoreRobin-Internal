import { defineConfig } from "@playwright/test";

const localBrowserExecutable = process.env.CORE_ROBIN_PLAYWRIGHT_EXECUTABLE;
const localBrowserChannel = process.env.CORE_ROBIN_PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:1420",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    locale: "en-US",
    screenshot: "only-on-failure",
    timezoneId: "Asia/Shanghai",
    channel: localBrowserChannel || undefined,
    launchOptions: localBrowserExecutable
      ? { executablePath: localBrowserExecutable }
      : undefined,
  },
  webServer: {
    command: "pnpm dev:web --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
