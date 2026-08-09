// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App, type DailyDriverControls } from "../src/App.js";
import { DefaultAgentHostClient } from "../src/client.js";
import { AgentHostError } from "../src/errors.js";
import type { DashboardNotificationPermission, NotificationCoordinator, NotificationGateway } from "../src/daily/notifications.js";
import { defaultPreferences, type DashboardPreferences } from "../src/daily/preferences.js";
import { createLargeDemoSnapshot } from "../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(cleanup);

function renderDashboard(transport = new MockAgentHostTransport(), strict = false) {
  transport.currentSnapshot = createLargeDemoSnapshot();
  transport.holdEventStreams = true;
  const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
  const app = <App client={client} />;
  return { transport, user: userEvent.setup(), ...render(strict ? <StrictMode>{app}</StrictMode> : app) };
}

class RecordingNotificationGateway implements NotificationGateway {
  currentPermission: DashboardNotificationPermission = "default";
  readonly shown: Array<{ title: string; options: NotificationOptions; onClick?: () => void }> = [];
  permission() { return this.currentPermission; }
  async requestPermission() { this.currentPermission = "granted"; return this.currentPermission; }
  show(title: string, options: NotificationOptions, onClick?: () => void) { this.shown.push({ title, options, ...(onClick ? { onClick } : {}) }); }
}

const immediateNotificationCoordinator: NotificationCoordinator = {
  async runOnce(_key, operation) { operation(); },
  close() {},
};

function renderDailyDashboard(transport: MockAgentHostTransport, gateway = new RecordingNotificationGateway(), initialPreferences: DashboardPreferences = defaultPreferences) {
  transport.currentSnapshot = createLargeDemoSnapshot();
  transport.holdEventStreams = true;
  const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
  function Harness() {
    const [preferences, setPreferences] = useState<DashboardPreferences>(initialPreferences);
    const controls: DailyDriverControls = {
      preferences,
      onPreferencesChange(update) { setPreferences((current) => typeof update === "function" ? update(current) : update); },
      onReconnect() {},
      onTerminalFailure() {},
      onClearPreferences() { setPreferences(defaultPreferences); },
      notificationGateway: gateway,
      notificationCoordinator: immediateNotificationCoordinator,
      notificationNamespace: "test-host",
    };
    return <App client={client} dailyDriver={controls} showDemoControls={false} />;
  }
  return { gateway, transport, user: userEvent.setup(), ...render(<Harness />) };
}

describe("evaluation dashboard", () => {
  it("renders a bounded first page for the 1,000-agent fixture", async () => {
    renderDashboard();

    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeLessThan(70);
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
  });

  it("filters by semantic status and keeps public capability actions gated", async () => {
    const { user } = renderDashboard();
    const statusSelect = screen.getByLabelText("Status");

    await user.selectOptions(statusSelect, "unknown");
    expect(await screen.findByText(/shown of 166/)).toBeInTheDocument();
    await user.click((await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!);

    await waitFor(() => expect(screen.queryByRole("button", { name: /Review and send/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Interrupt/ })).not.toBeInTheDocument();
  });

  it("requires an explicit approval button and never treats Enter as approval", async () => {
    const { transport, user } = renderDashboard();
    await user.selectOptions(screen.getByLabelText("Status"), "blocked");
    expect(await screen.findByText(/shown of 167/)).toBeInTheDocument();
    await user.click((await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await user.click(approve);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Approve this exact request/)).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(/Enter and Escape never approve/);
    await user.keyboard("{Enter}");
    expect(transport.actions).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Approve request" }));
    await waitFor(() => expect(transport.actions).toHaveLength(1));
    expect(transport.actions[0]?.action).toMatchObject({ kind: "approve" });
    expect(transport.actions[0]?.target.id).toBe("demo:agent-0002");
  });

  it("restores focus after cancellation and suppresses duplicate actions", async () => {
    let releaseAction: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const { user } = renderDashboard(transport);
    await user.selectOptions(screen.getByLabelText("Status"), "blocked");
    const approve = await screen.findByRole("button", { name: "Approve" });
    await user.click(approve);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(approve).toHaveFocus());

    const read = screen.getByRole("button", { name: /Read output/ });
    await user.dblClick(read);
    expect(transport.actions).toHaveLength(1);
    expect(read).toBeDisabled();
    releaseAction();
    await waitFor(() => expect(read).toBeEnabled());
  });

  it("preserves filter, selection, and per-agent draft across live updates", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    transport.eventStreams = [[{
      type: "agent.upserted",
      revision: 41,
      agent: { ...createLargeDemoSnapshot().agents[0]!, name: "Updated agent name" },
    }]];
    const { user } = renderDashboard(transport);
    await user.selectOptions(screen.getByLabelText("Status"), "working");
    const selected = (await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!;
    await user.click(selected);
    const draft = await screen.findByLabelText("Prompt");
    await user.type(draft, "Keep this draft");

    releaseEvents();

    expect(await screen.findByRole("button", { name: /Updated agent name/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("Status")).toHaveValue("working");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Keep this draft");
  });

  it("cleans up the first Strict Mode stream instead of leaving duplicate connections", async () => {
    const transport = new MockAgentHostTransport();
    const rendered = renderDashboard(transport, true);
    await waitFor(() => expect(transport.activeEventStreams).toBe(1));
    rendered.unmount();
    await waitFor(() => expect(transport.activeEventStreams).toBe(0));
  });

  it("does not hide an unresolved detail error after the connection recovers", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [
      new AgentHostError("connection_failed", "Stream interrupted.", { retryable: true }),
      [{ type: "heartbeat", revision: 41 }],
    ];
    transport.detail = async () => {
      throw new AgentHostError("not_found", "Detail is unavailable.");
    };
    renderDashboard(transport);

    expect(await screen.findByText("Detail is unavailable.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Live connection")).toBeInTheDocument(), { timeout: 2_000 });
    expect(screen.getByText("Detail is unavailable.")).toBeInTheDocument();
  });

  it("restarts a terminally disconnected event connection", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [
      new AgentHostError("invalid_response", "The event stream was invalid."),
      [{ type: "heartbeat", revision: 41 }],
    ];
    const { user } = renderDashboard(transport);

    expect(await screen.findByText("Host disconnected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Live connection")).toBeInTheDocument());
    expect(await screen.findByText("r41")).toBeInTheDocument();
  });

  it("reloads the bounded page when a matching unseen agent is upserted", async () => {
    let releaseEvent: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const unseen = {
      ...createLargeDemoSnapshot().agents[60]!,
      id: "demo:new-attention-agent",
      name: "New attention agent",
      status: "blocked" as const,
    };
    transport.eventStreams = [[{ type: "agent.upserted", revision: 41, agent: unseen }]];
    renderDashboard(transport);
    await screen.findByText("50 shown of 1000");
    transport.currentSnapshot = {
      ...transport.currentSnapshot,
      agents: [unseen, ...transport.currentSnapshot.agents],
      total: transport.currentSnapshot.total! + 1,
    };

    releaseEvent();
    expect(await screen.findByRole("button", { name: /New attention agent/ })).toBeInTheDocument();
    expect(screen.getByText("50 shown of 1001")).toBeInTheDocument();
  });

  it("does not refetch selected detail for unrelated connection events", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    transport.eventStreams = [[
      { type: "adapter.health", revision: 41, adapter: transport.health[0]! },
      { type: "heartbeat", revision: 42 },
    ]];
    const detail = vi.spyOn(transport, "detail");
    renderDashboard(transport);
    await waitFor(() => expect(detail).toHaveBeenCalled());
    const callsBeforeEvents = detail.mock.calls.length;

    releaseEvents();
    await screen.findByText("r42");
    expect(detail).toHaveBeenCalledTimes(callsBeforeEvents);
  });

  it("refreshes selected detail when that agent changes", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const selected = createLargeDemoSnapshot().agents[1]!;
    transport.eventStreams = [[{
      type: "agent.upserted",
      revision: 41,
      agent: { ...selected, name: "Updated selected agent" },
    }]];
    const detail = vi.spyOn(transport, "detail");
    renderDashboard(transport);
    await waitFor(() => expect(detail).toHaveBeenCalled());
    const callsBeforeEvent = detail.mock.calls.length;

    releaseEvents();
    await waitFor(() => expect(detail.mock.calls.length).toBeGreaterThan(callsBeforeEvent));
  });

  it("preserves an unsent draft across an SSE reconnect", async () => {
    let releaseStream: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    transport.eventStreams = [
      new AgentHostError("connection_failed", "Stream interrupted.", { retryable: true }),
      [{ type: "heartbeat", revision: 41 }],
    ];
    const { user } = renderDashboard(transport);
    await user.selectOptions(screen.getByLabelText("Status"), "working");
    await user.click((await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!);
    await user.type(await screen.findByLabelText("Prompt"), "Keep this reconnect draft");

    releaseStream();

    await waitFor(() => expect(screen.getByText("Live connection")).toBeInTheDocument(), { timeout: 2_000 });
    await waitFor(() => expect(screen.getByText("r41")).toBeInTheDocument(), { timeout: 2_000 });
    expect(screen.getByLabelText("Prompt")).toHaveValue("Keep this reconnect draft");
  });

  it("requests notification permission from an explicit gesture and ignores the initial snapshot", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const blocked = { ...createLargeDemoSnapshot().agents[0]!, status: "blocked" as const };
    const alreadyBlocked = createLargeDemoSnapshot().agents[1]!;
    transport.eventStreams = [[
      { type: "agent.upserted", revision: 41, agent: alreadyBlocked },
      { type: "agent.upserted", revision: 42, agent: blocked },
    ]];
    const { gateway, user } = renderDailyDashboard(transport);
    await screen.findByText("50 shown of 1000");
    expect(gateway.shown).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Enable desktop notifications" }));
    await waitFor(() => expect(screen.getByText(/Browser permission:/)).toHaveTextContent("granted"));

    releaseEvents();
    await waitFor(() => expect(gateway.shown).toHaveLength(1));
    expect(gateway.shown[0]?.title).toContain("is blocked");
    gateway.shown[0]?.onClick?.();
    await waitFor(() => expect(document.querySelector(".workspace")).toHaveFocus());
  });

  it("does not replay attention events that occurred before notification opt-in", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const blocked = { ...createLargeDemoSnapshot().agents[0]!, status: "blocked" as const };
    transport.eventStreams = [[{ type: "agent.upserted", revision: 41, agent: blocked }]];
    const { gateway, user } = renderDailyDashboard(transport);
    await screen.findByText("50 shown of 1000");

    releaseEvents();
    await screen.findByText("r41");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Enable desktop notifications" }));
    await waitFor(() => expect(screen.getByText(/Browser permission:/)).toHaveTextContent("granted"));
    expect(gateway.shown).toHaveLength(0);
  });

  it("does not infer a transition for an existing attention agent outside the loaded page", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const pageOutsideBlocked = createLargeDemoSnapshot().agents[55]!;
    transport.eventStreams = [[{ type: "agent.upserted", revision: 41, agent: pageOutsideBlocked }]];
    const gateway = new RecordingNotificationGateway();
    gateway.currentPermission = "granted";
    renderDailyDashboard(transport, gateway, { ...defaultPreferences, notifications: { ...defaultPreferences.notifications, enabled: true } });
    await screen.findByText("50 shown of 1000");
    releaseEvents();
    await screen.findByText("r41");
    expect(gateway.shown).toHaveLength(0);
  });

  it("uses the authoritative snapshot baseline while the visible snapshot request is slow", async () => {
    const transport = new MockAgentHostTransport();
    const originalSnapshot = transport.snapshot.bind(transport);
    let snapshotCalls = 0;
    let releaseVisibleSnapshot: () => void = () => undefined;
    const visibleSnapshotGate = new Promise<void>((resolve) => { releaseVisibleSnapshot = resolve; });
    transport.snapshot = async (request, options) => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) await visibleSnapshotGate;
      return await originalSnapshot(request, options);
    };
    const transitioned = { ...createLargeDemoSnapshot().agents[0]!, status: "blocked" as const };
    transport.eventStreams = [[{ type: "agent.upserted", revision: 41, agent: transitioned }]];
    const gateway = new RecordingNotificationGateway();
    gateway.currentPermission = "granted";
    renderDailyDashboard(transport, gateway, { ...defaultPreferences, notifications: { ...defaultPreferences.notifications, enabled: true } });

    await waitFor(() => expect(gateway.shown).toHaveLength(1));
    releaseVisibleSnapshot();
    await screen.findByText("50 shown of 1000");
  });

  it("resets the notification baseline during a revision-gap resync", async () => {
    const transport = new MockAgentHostTransport();
    const transitioned = { ...createLargeDemoSnapshot().agents[0]!, status: "blocked" as const };
    let streamAttempt = 0;
    transport.events = async function* resyncEvents(options) {
      streamAttempt += 1;
      if (streamAttempt === 1) {
        const snapshot = createLargeDemoSnapshot(1_000, 42);
        transport.currentSnapshot = { ...snapshot, agents: snapshot.agents.slice(1), total: snapshot.total! - 1 };
        yield { type: "heartbeat", revision: 42 } as const;
        return;
      }
      yield { type: "agent.upserted", revision: 43, agent: transitioned } as const;
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    };
    const gateway = new RecordingNotificationGateway();
    gateway.currentPermission = "granted";
    renderDailyDashboard(transport, gateway, { ...defaultPreferences, notifications: { ...defaultPreferences.notifications, enabled: true } });

    await screen.findByText("r43", {}, { timeout: 2_000 });
    expect(gateway.shown).toHaveLength(0);
  });

  it("keeps recent agents and sanitized action history in the current session", async () => {
    const { user } = renderDailyDashboard(new MockAgentHostTransport());
    await user.selectOptions(await screen.findByLabelText("Status"), "blocked");
    await user.click((await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!);
    await user.click(await screen.findByRole("button", { name: /Read output/ }));
    await waitFor(() => expect(screen.getByText(/read completed/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Activity" }));

    expect(screen.getByRole("heading", { name: "Recent agents" })).toBeInTheDocument();
    const history = screen.getByRole("heading", { name: "Action history" }).closest("section");
    expect(history).not.toBeNull();
    expect(within(history!).getByText("read")).toBeInTheDocument();
    expect(within(history!).getByText(/Sanitized agent/)).toBeInTheDocument();
    expect(screen.getByText(/Prompt text, commands, approval payloads/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear session activity" }));
    expect(screen.getByText("No agents inspected yet.")).toBeInTheDocument();
    expect(screen.getByText("No actions performed in this session.")).toBeInTheDocument();
  });

  it("opens sanitized diagnostics and focuses search with the slash shortcut", async () => {
    const { user } = renderDailyDashboard(new MockAgentHostTransport());
    await screen.findByText("50 shown of 1000");
    await user.keyboard("/");
    expect(screen.getByLabelText("Search agents")).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("Sanitized diagnostics only")).toBeInTheDocument();
    expect(screen.getByText("events-after-revision")).toBeInTheDocument();
  });

  it("keeps observed notification scopes and mute choices stable across filtering", async () => {
    const { user } = renderDailyDashboard(new MockAgentHostTransport());
    await screen.findByText("50 shown of 1000");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByText(/Provider and project controls/));
    const providers = screen.getByRole("group", { name: "Providers" });
    await user.click(within(providers).getByLabelText("demo-alpha"));
    await user.click(screen.getAllByRole("button", { name: "Workspace" })[0]!);
    await user.selectOptions(screen.getByLabelText("Provider"), "demo-beta");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByText(/Provider and project controls/));

    expect(within(screen.getByRole("group", { name: "Providers" })).getByLabelText("demo-alpha")).not.toBeChecked();
    expect(screen.getByRole("group", { name: "Projects" })).toBeInTheDocument();
  });
});
