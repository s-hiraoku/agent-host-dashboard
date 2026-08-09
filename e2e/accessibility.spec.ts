import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("has no automated accessibility violations in the live workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  await expectNoViolations(page);
});

test("keeps the contextual approval dialog accessible", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Status").selectOption("blocked");
  await page.locator(".agent-row").first().click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(/Enter and Escape never approve/);
  await expectNoViolations(page);
});

test("uses non-color status text and honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?fixture=unauthorized");
  await expect(page.getByText("Authentication required")).toBeVisible();
  await expect(page.locator(".connection-banner")).toContainText("credential was rejected");
  const animationDuration = await page.locator(".connection-banner svg").evaluate(
    (element) => getComputedStyle(element).animationDuration,
  );
  const durationMs = Number.parseFloat(animationDuration) * (animationDuration.endsWith("ms") ? 1 : 1_000);
  expect(durationMs).toBeLessThanOrEqual(0.01);
  await expectNoViolations(page);

  await page.goto("/");
  await expect(page.locator(".agent-row").first().locator(".status-badge")).toContainText(/blocked|error|working|idle|done|unknown/);
});
