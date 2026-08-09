import { expect, test } from "@playwright/test";

test("stacks the operations workspace at a narrow viewport without horizontal overflow", async ({ page }) => {
  await page.goto("/");
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
