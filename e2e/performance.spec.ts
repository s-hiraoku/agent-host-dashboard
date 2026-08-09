import { expect, test } from "@playwright/test";

test("keeps the 1,000-agent scenario within interaction and DOM budgets", async ({ page }, testInfo) => {
  const navigationStarted = Date.now();
  await page.goto("/");
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  const readyMs = Date.now() - navigationStarted;

  const dom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    agentRows: document.querySelectorAll(".agent-list > li").length,
  }));

  const filterStarted = Date.now();
  await page.getByPlaceholder("Search agents").fill("0999");
  await expect(page.getByText("1 shown of 1")).toBeVisible();
  const filterMs = Date.now() - filterStarted;

  const selectionStarted = Date.now();
  await page.locator(".agent-row").click();
  await expect(page.getByRole("heading", { name: "Sanitized agent 0999", level: 2 })).toBeVisible();
  const selectionMs = Date.now() - selectionStarted;

  const measurements = { readyMs, filterMs, selectionMs, ...dom };
  console.log("performance-budget", measurements);
  await testInfo.attach("performance-budget.json", {
    body: Buffer.from(JSON.stringify(measurements, null, 2)),
    contentType: "application/json",
  });

  expect(dom.agentRows).toBe(50);
  expect(dom.elements).toBeLessThan(1_500);
  expect(readyMs).toBeLessThan(3_000);
  expect(filterMs).toBeLessThan(750);
  expect(selectionMs).toBeLessThan(500);
});
