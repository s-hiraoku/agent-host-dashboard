import { expect, test } from "@playwright/test";

async function connect(page: import("@playwright/test").Page, credential?: string): Promise<void> {
  if (credential) await page.getByLabel(/Access token/).fill(credential);
  await page.getByRole("button", { name: "Connect securely" }).click();
}

test("onboards without persisting credentials and restores safe preferences", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect to your local agent-host" })).toBeVisible();
  await expect(page.getByText(/Simulation mode/)).toBeVisible();
  const generatedCredential = `ephemeral-${Date.now()}`;
  await connect(page, generatedCredential);
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  await expect(page.getByText(/Simulation mode/)).toBeVisible();

  const persistedAfterConnect = await page.evaluate(() => localStorage.getItem("agent-host-dashboard.preferences") ?? "");
  expect(persistedAfterConnect).toContain("http://127.0.0.1:8787/");
  expect(persistedAfterConnect).not.toContain(generatedCredential);
  expect(page.url()).not.toContain(generatedCredential);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Density" }).selectOption("compact");
  await page.getByRole("checkbox", { name: "project" }).uncheck();
  await page.getByRole("button", { name: "Workspace" }).first().click();
  await expect(page.locator(".app-shell")).toHaveClass(/density-compact/);
  await page.getByLabel("Status").selectOption("blocked");
  await expect(page.getByText(/shown of 167/)).toBeVisible();
  await page.getByRole("button", { name: "Save view" }).click();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect to your local agent-host" })).toBeVisible();
  await expect(page.getByLabel("Agent-host endpoint")).toHaveValue("http://127.0.0.1:8787/");
  await expect(page.getByLabel(/Access token/)).toHaveValue("");
  await connect(page);
  await expect(page.locator(".app-shell")).toHaveClass(/density-compact/);
  await expect(page.getByLabel("Status")).toHaveValue("blocked");
  await expect(page.getByLabel("Saved view").locator("option")).toHaveCount(2);
});

for (const recovery of [
  { mode: "unauthorized", heading: "Authentication failed", guidance: "credential was cleared" },
  { mode: "unavailable", heading: "Local host is not reachable", guidance: "Start agent-host" },
  { mode: "incompatible", heading: "API version is incompatible", guidance: "supported API versions overlap" },
] as const) {
  test(`recovers from ${recovery.mode} without retaining the failed credential`, async ({ page }) => {
    await page.goto(`/?connection=${recovery.mode}`);
    const generatedCredential = `ephemeral-${recovery.mode}-${Date.now()}`;
    await connect(page, generatedCredential);
    await expect(page.getByRole("heading", { name: recovery.heading })).toBeVisible();
    await expect(page.getByText(new RegExp(recovery.guidance, "i"))).toBeVisible();
    await expect(page.getByLabel(/Access token/)).toHaveValue("");
    expect(await page.evaluate(() => localStorage.getItem("agent-host-dashboard.preferences"))).toBeNull();

    await connect(page);
    await expect(page.getByText("50 shown of 1000")).toBeVisible();
  });
}

test("clears all persisted dashboard preferences from the privacy surface", async ({ page }) => {
  await page.goto("/");
  await connect(page);
  await page.getByRole("button", { name: "Privacy" }).click();
  await expect(page.getByText("Only non-secret preferences persist")).toBeVisible();
  await page.getByRole("button", { name: "Clear local preferences" }).click();
  expect(await page.evaluate(() => localStorage.getItem("agent-host-dashboard.preferences"))).toBeNull();
});

test("supports keyboard-only first-run connection", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Agent-host endpoint")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/Access token/)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connect securely" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
});
