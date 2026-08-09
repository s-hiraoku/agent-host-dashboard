import { defineConfig } from "@playwright/test";

const baseUse = {
  baseURL: "http://127.0.0.1:4173",
  colorScheme: "dark" as const,
  screenshot: "only-on-failure" as const,
  trace: "retain-on-failure" as const,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  outputDir: "test-results/playwright",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      testMatch: ["**/workflows.spec.ts", "**/daily-driver.spec.ts"],
      use: { ...baseUse, browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "narrow",
      testMatch: "**/responsive.spec.ts",
      use: { ...baseUse, browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
    {
      name: "accessibility",
      testMatch: "**/accessibility.spec.ts",
      use: { ...baseUse, browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "performance",
      testMatch: "**/performance.spec.ts",
      use: { ...baseUse, browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
});
