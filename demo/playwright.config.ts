import { defineConfig } from "@playwright/test";

const baseURL = process.env.DEMO_E2E_BASE_URL;
if (!baseURL) throw new Error("DEMO_E2E_BASE_URL is required");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: process.env.DEMO_E2E_EVIDENCE_DIR ?? "test-results",
  reporter: [["line"]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    video: "on",
    screenshot: "only-on-failure",
    trace: "off",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
    },
  },
});
