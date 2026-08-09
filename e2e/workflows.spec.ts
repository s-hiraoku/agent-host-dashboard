import { expect, test, type Page } from "@playwright/test";

async function focusNextMatching(page: Page, selector: string, limit = 16): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(`${selector}:focus`).count()) return;
  }
  throw new Error(`Keyboard focus did not reach ${selector}.`);
}

test("loads, filters, paginates, and exposes detail JSON without unbounded DOM", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Live connection")).toBeVisible();
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  await expect(page.locator(".agent-list > li")).toHaveCount(50);

  await page.getByRole("button", { name: /Next/ }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await page.getByLabel("Status").selectOption("working");
  await expect(page.getByText(/shown of 167/)).toBeVisible();

  const agent = page.locator(".agent-row").first();
  await agent.click();
  await expect(page.getByRole("heading", { name: /Sanitized agent/, level: 2 }).first()).toBeVisible();
  await page.getByText("Developer panel", { exact: true }).click();
  await expect(page.locator(".developer-panel pre")).toContainText('"provider"');
});

test("reviews prompt and interrupt context before a single explicit dispatch", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Status").selectOption("working");
  await page.locator(".agent-row").first().click();

  await page.getByRole("button", { name: "Read output" }).click();
  await expect(page.getByText(/read completed/)).toBeVisible();

  await page.getByLabel("Prompt").fill("Inspect the sanitized fixture");
  await page.getByRole("button", { name: "Review and send" }).click();
  let promptDialog = page.getByRole("dialog");
  await expect(promptDialog).toContainText("Inspect the sanitized fixture");
  await expect(promptDialog).toContainText("/workspace/");
  await promptDialog.press("Escape");
  await expect(promptDialog).toHaveCount(0);
  await expect(page.getByText(/prompt completed/)).toHaveCount(0);
  await expect(page.getByLabel("Prompt")).toHaveValue("Inspect the sanitized fixture");

  await page.getByRole("button", { name: "Review and send" }).click();
  promptDialog = page.getByRole("dialog");
  await promptDialog.press("Enter");
  await expect(promptDialog).toBeVisible();
  await promptDialog.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByText(/prompt completed/)).toBeVisible();

  await page.getByRole("button", { name: "Interrupt" }).click();
  let interruptDialog = page.getByRole("dialog");
  await expect(interruptDialog).toContainText("stop the active operation");
  await interruptDialog.press("Escape");
  await expect(interruptDialog).toHaveCount(0);
  await expect(page.getByText(/interrupt completed/)).toHaveCount(0);

  await page.getByRole("button", { name: "Interrupt" }).click();
  interruptDialog = page.getByRole("dialog");
  await interruptDialog.getByRole("button", { name: "Interrupt agent" }).click();
  await expect(page.getByText(/interrupt completed/)).toBeVisible();
});

test("requires explicit approval and preserves command context", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Status").selectOption("blocked");
  await page.locator(".agent-row").first().click();
  await page.getByRole("button", { name: "Approve" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("npm run check");
  await expect(dialog).toContainText("Confirm the selected change");
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/approve completed/)).toHaveCount(0);

  await page.getByRole("button", { name: "Approve" }).click();
  const reopenedDialog = page.getByRole("dialog");
  await reopenedDialog.press("Enter");
  await expect(reopenedDialog).toBeVisible();
  await expect(page.getByText(/approve completed/)).toHaveCount(0);
  await reopenedDialog.getByRole("button", { name: "Approve request" }).click();
  await expect(page.getByText(/approve completed/)).toBeVisible();

  await page.getByRole("button", { name: "Reject" }).click();
  let rejectDialog = page.getByRole("dialog");
  await expect(rejectDialog).toContainText("npm run check");
  await rejectDialog.press("Escape");
  await expect(rejectDialog).toHaveCount(0);
  await expect(page.getByText(/reject completed/)).toHaveCount(0);

  await page.getByRole("button", { name: "Reject" }).click();
  rejectDialog = page.getByRole("dialog");
  await rejectDialog.getByRole("button", { name: "Reject request" }).click();
  await expect(page.getByText(/reject completed/)).toBeVisible();
});

test("keeps filter, selection, draft, list position, and row identity across a live update", async ({ page }) => {
  await page.goto("/?fixture=delayed-update");
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  await page.getByLabel("Status").selectOption("working");
  await expect(page.getByText("50 shown of 167")).toBeVisible();
  await page.locator(".agent-row").first().click();
  await page.getByLabel("Prompt").fill("Keep this draft during the event");

  const list = page.locator(".agent-list");
  const firstRow = page.locator(".agent-row").first();
  await list.evaluate((element) => { element.scrollTop = 200; });
  await firstRow.evaluate((element) => { element.dataset.liveUpdateMarker = "retained"; });

  await expect(page.locator(".agent-row").getByText("Delayed live agent", { exact: true })).toBeVisible();
  await expect(page.getByText("r41", { exact: true })).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(150);
  await expect(page.locator('.agent-row[data-live-update-marker="retained"]')).toHaveCount(1);
  await expect(page.getByLabel("Status")).toHaveValue("working");
  await expect(page.locator('.agent-row[aria-current="true"]')).toHaveCount(1);
  await expect(page.getByLabel("Prompt")).toHaveValue("Keep this draft during the event");
});

test("recovers from an SSE reconnect and a revision-gap resync", async ({ page }) => {
  await page.goto("/?fixture=reconnect");
  await expect(page.getByText(/Reconnecting/)).toBeVisible();
  await expect(page.getByText("Live connection")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("r41", { exact: true })).toBeVisible();

  await page.goto("/?fixture=gap");
  await expect(page.getByText(/Snapshot is stale/)).toBeVisible();
  await expect(page.getByText("Live connection")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Resynchronized live agent")).toBeVisible();
  await expect(page.getByText("r43", { exact: true })).toBeVisible();
});

test("renders authorization, incompatibility, adapter, and error recovery states", async ({ page }) => {
  await page.goto("/?fixture=unauthorized");
  await expect(page.getByText("Authentication required")).toBeVisible();
  await expect(page.locator(".connection-banner")).toContainText("credential was rejected");

  await page.goto("/?fixture=incompatible");
  await expect(page.getByText("Incompatible API version")).toBeVisible();
  await expect(page.locator(".connection-banner")).toContainText("Unsupported agent-host API version");

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Adapter health" })).toContainText("degraded");
  await page.getByLabel("Demo state").selectOption("disconnected");
  await expect(page.getByText("Host disconnected")).toBeVisible();
  await page.getByLabel("Demo state").selectOption("error");
  await expect(page.getByText(/shown of 167/)).toBeVisible();
  await expect(page.locator(".agent-row").first()).toContainText("error");
});

test("supports a keyboard-only search and selection workflow", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to agent workspace" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  await focusNextMatching(page, 'input[placeholder="Search agents"]', 4);
  await page.keyboard.type("0999");
  await expect(page.getByText("1 shown of 1")).toBeVisible();
  await focusNextMatching(page, ".agent-row");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Sanitized agent 0999", level: 2 })).toBeVisible();
  await expect(page.locator(":focus")).toHaveCSS("outline-style", "solid");
});
