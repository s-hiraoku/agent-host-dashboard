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

test("provides session activity, diagnostics, scoped notifications, and search shortcut", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("/");
  await connect(page);
  await expect(page.getByText("50 shown of 1000")).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search agents")).toBeFocused();
  await page.getByLabel("Status").selectOption("blocked");
  await page.locator(".agent-row").first().click();
  await page.getByRole("button", { name: "Read output" }).click();
  await expect(page.getByText(/read completed/)).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Recent agents" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Action history" })).toBeVisible();
  await expect(page.locator(".action-history")).toContainText("read");
  await page.locator(".activity-list button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace")).toBeFocused();
  await page.getByRole("button", { name: "Activity" }).click();
  await page.locator(".settings-heading").getByRole("button", { name: "Workspace" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace")).toBeFocused();

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.getByText("events-after-revision")).toBeVisible();
  await expect(page.getByText("Sanitized diagnostics only")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const permission = page.getByText(/Browser permission:/);
  await expect(permission).toContainText(/granted|denied/);
  if ((await permission.textContent())?.includes("granted")) await page.getByLabel("Notifications enabled").check();
  await page.getByText(/Provider and project controls/).click();
  const providers = page.getByRole("group", { name: "Providers" });
  const projects = page.getByRole("group", { name: "Projects" });
  await expect(providers).toBeVisible();
  await expect(projects).toBeVisible();
  await providers.getByLabel("demo-alpha").uncheck();
  await projects.locator('input[type="checkbox"]').first().uncheck();
  await page.getByRole("combobox", { name: "Density", exact: true }).selectOption("compact");

  const persisted = await page.evaluate(() => localStorage.getItem("agent-host-dashboard.preferences") ?? "");
  expect(persisted).not.toMatch(/Sanitized agent|demo:agent|recent|actionHistory|muted|project-0|read/);

  await page.reload();
  await connect(page);
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("No agents inspected yet.")).toBeVisible();
  await expect(page.getByText("No actions performed in this session.")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText(/Provider and project controls/).click();
  await expect(page.getByRole("group", { name: "Providers" }).locator('input[type="checkbox"]').first()).toBeChecked();
});
