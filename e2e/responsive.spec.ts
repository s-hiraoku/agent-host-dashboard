import { expect, test } from "@playwright/test";

test("stacks the operations workspace at a narrow viewport without horizontal overflow", async ({ page }) => {
  await page.goto("/?fixture=live");
  await expect(page.getByText("50 shown of 1000")).toBeVisible();

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    renderedAgents: document.querySelectorAll(".agent-list > li").length,
    panelTops: [...document.querySelectorAll<HTMLElement>(".workspace > *")].map((panel) => panel.offsetTop),
  }));

  expect(layout.scrollWidth).toBe(layout.clientWidth);
  expect(layout.renderedAgents).toBe(50);
  expect(layout.panelTops).toEqual([...layout.panelTops].sort((left, right) => left - right));
  expect(new Set(layout.panelTops).size).toBe(3);
});

test("keeps first-run onboarding usable at a narrow viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect to your local agent-host" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    buttonHeight: document.querySelector<HTMLButtonElement>('button[type="submit"]')?.getBoundingClientRect().height,
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
  expect(layout.buttonHeight).toBeGreaterThanOrEqual(37);
});

test("keeps activity, diagnostics, settings, and privacy usable without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect securely" }).click();
  for (const surface of ["Activity", "Diagnostics", "Settings", "Privacy"]) {
    await page.getByRole("button", { name: surface }).click();
    await expect(page.locator("#main-content")).toBeVisible();
    const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(widths.scroll).toBe(widths.client);
  }
});
