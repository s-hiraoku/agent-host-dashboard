// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App, type DailyDriverControls } from "../src/App.js";
import { DefaultAgentHostClient } from "../src/client.js";
import { AgentHostError } from "../src/errors.js";
import type { AgentDetail } from "../src/domain.js";
import type { DashboardNotificationPermission, NotificationCoordinator, NotificationGateway } from "../src/daily/notifications.js";
import { defaultPreferences, type DashboardPreferences } from "../src/daily/preferences.js";
import { createLargeDemoSnapshot } from "../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";
import { MockRepositoryContextSource, MockSourceControlClient } from "../src/testing/repositories/mock-clients.js";
import { SourceControlError } from "../src/repositories/source-control.js";
import { demoIssues, demoPullRequests, demoRepositoryAssociations } from "../src/testing/repositories/fixtures.js";

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
  requestFailure: Error | undefined;
  readonly shown: Array<{ title: string; options: NotificationOptions; onClick?: () => void }> = [];
  permission() { return this.currentPermission; }
  async requestPermission() {
    if (this.requestFailure) throw this.requestFailure;
    this.currentPermission = "granted";
    return this.currentPermission;
  }
  show(title: string, options: NotificationOptions, onClick?: () => void) { this.shown.push({ title, options, ...(onClick ? { onClick } : {}) }); }
}

function createImmediateNotificationCoordinator(): NotificationCoordinator {
  const delivered = new Set<string>();
  return {
    async runOnce(key, operation) {
      if (delivered.has(key)) return;
      delivered.add(key);
      operation();
    },
    close() { delivered.clear(); },
  };
}

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
      notificationCoordinator: createImmediateNotificationCoordinator(),
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

  it("shows sanitized repository, Issue, and PR context only for the selected agent", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const repositoryContext = new MockRepositoryContextSource();
    const sourceControl = new MockSourceControlClient();
    const repository = vi.spyOn(sourceControl, "repository");
    render(<App client={client} repositoryContext={repositoryContext} sourceControl={sourceControl} />);

    expect(await screen.findByRole("link", { name: /example-labs\/orbit/ })).toHaveAttribute("href", "https://github.com/example-labs/orbit");
    expect(screen.getByText("Clarify bounded parser behavior")).toBeInTheDocument();
    expect(screen.getByText("Harden parser boundary")).toBeInTheDocument();
    expect(screen.getByText("Agent PR")).toBeInTheDocument();
    expect(repository).toHaveBeenCalledTimes(1);
  });

  it("loads an explicitly associated PR even when it is outside the bounded list page", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const sourceControl = new MockSourceControlClient();
    sourceControl.pullRequests = async () => ({ items: [demoPullRequests[1]!] });
    const pullRequest = vi.spyOn(sourceControl, "pullRequest");
    render(<App client={client} repositoryContext={new MockRepositoryContextSource()} sourceControl={sourceControl} />);

    expect(await screen.findByText("Harden parser boundary")).toBeInTheDocument();
    expect(screen.getByText("Agent PR")).toBeInTheDocument();
    expect(pullRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "orbit" }), 42, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("continues bounded Issue pagination when a page contains no Issue entries", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const sourceControl = new MockSourceControlClient();
    const issues = vi.spyOn(sourceControl, "issues")
      .mockResolvedValueOnce({ items: [], nextCursor: "2" })
      .mockResolvedValueOnce({ items: [demoIssues[0]!] });
    render(<App client={client} repositoryContext={new MockRepositoryContextSource()} sourceControl={sourceControl} />);

    expect(await screen.findByText("Clarify bounded parser behavior")).toBeInTheDocument();
    expect(issues).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ cursor: "2" }), expect.anything());
  });

  it("keeps valid repository context visible when another association fails", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const repositoryContext = new MockRepositoryContextSource();
    repositoryContext.result = {
      state: "ready",
      revision: 41,
      associations: [
        ...demoRepositoryAssociations,
        {
          kind: "confirmed",
          agentId: "demo:agent-0002",
          repository: { service: "github", host: "github.com", owner: "example-labs", name: "retired" },
          provenance: { source: "sanitized-fixture", confidence: "high" },
        },
      ],
    };
    render(<App client={client} repositoryContext={repositoryContext} sourceControl={new MockSourceControlClient()} />);

    expect(await screen.findByRole("link", { name: /example-labs\/orbit/ })).toBeInTheDocument();
    expect(screen.getByText(/Repository context unavailable for github.com\/example-labs\/retired/)).toBeInTheDocument();
  });

  it("provides an explicit GitHub authentication recovery state", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const sourceControl = new MockSourceControlClient();
    sourceControl.repository = async () => {
      throw new SourceControlError("unauthorized", "GitHub authentication failed.", { status: 401 });
    };
    render(<App client={client} repositoryContext={new MockRepositoryContextSource()} sourceControl={sourceControl} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub authentication required");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("does not install stale repository context after selection changes", async () => {
    let resolveInitial: (value: Awaited<ReturnType<MockRepositoryContextSource["forAgent"]>>) => void = () => undefined;
    const initial = new Promise<Awaited<ReturnType<MockRepositoryContextSource["forAgent"]>>>((resolve) => { resolveInitial = resolve; });
    const context = new MockRepositoryContextSource();
    const forAgent = context.forAgent.bind(context);
    context.forAgent = async (agentId, options) => agentId === "demo:agent-0002" ? await initial : await forAgent(agentId, options);
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const user = userEvent.setup();
    render(<App client={client} repositoryContext={context} sourceControl={new MockSourceControlClient()} />);
    const next = (await screen.findAllByRole("button", { name: /Sanitized agent/ })).find((button) => button.getAttribute("aria-current") !== "true")!;

    await user.click(next);
    resolveInitial({ state: "ready", associations: context.result.state === "ready" ? context.result.associations : [] });

    expect(await screen.findByText("No repository association")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /example-labs\/orbit/ })).not.toBeInTheDocument();
  });

  it("clears the previous agent detail and repository while the next detail is pending", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    const originalDetail = transport.detail.bind(transport);
    let pendingAgentId: string | undefined;
    transport.detail = async (agentId, options) => {
      if (pendingAgentId === agentId) return await new Promise<AgentDetail>(() => undefined);
      return await originalDetail(agentId, options);
    };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const user = userEvent.setup();
    render(<App client={client} repositoryContext={new MockRepositoryContextSource()} sourceControl={new MockSourceControlClient()} />);
    expect(await screen.findByRole("link", { name: /example-labs\/orbit/ })).toBeInTheDocument();
    const next = (await screen.findAllByRole("button", { name: /Sanitized agent/ })).find((button) => button.getAttribute("aria-current") !== "true")!;
    pendingAgentId = transport.currentSnapshot.agents.find((agent) => next.textContent?.includes(agent.name))?.id;
    expect(pendingAgentId).toBeDefined();

    await user.click(next);

    expect(screen.queryByRole("link", { name: /example-labs\/orbit/ })).not.toBeInTheDocument();
    expect(screen.getByText("Select an agent to inspect its public details.")).toBeInTheDocument();
  });

  it("does not present page-local sort or facet approximations as global capabilities", async () => {
    const transport = new MockAgentHostTransport();
    transport.apiInfo = { apiVersion: "1", features: ["fixed-attention-order"] };
    const snapshot = transport.snapshot.bind(transport);
    transport.snapshot = async (request, options) => {
      const { facets: _facets, ...withoutFacets } = await snapshot(request, options);
      return withoutFacets;
    };
    const { container } = renderDashboard(transport);

    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    expect(screen.getByLabelText("Sort")).toBeDisabled();
    expect(screen.getByText(/Dashes are shown instead of page-local approximations/)).toBeInTheDocument();
    expect([...container.querySelectorAll(".summary-metric strong")].every((node) => node.textContent === "—")).toBe(true);
  });

  it("disables pagination while the next page is loading", async () => {
    const transport = new MockAgentHostTransport();
    const originalSnapshot = transport.snapshot.bind(transport);
    let releaseNextPage: () => void = () => undefined;
    const nextPageGate = new Promise<void>((resolve) => { releaseNextPage = resolve; });
    transport.snapshot = async (request, options) => {
      if (request.cursor === "50") await nextPageGate;
      return await originalSnapshot(request, options);
    };
    const { user } = renderDashboard(transport);
    const next = await screen.findByRole("button", { name: /Next/ });

    await user.click(next);
    expect(next).toBeDisabled();
    releaseNextPage();
    await waitFor(() => expect(next).toBeEnabled());
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

  it("disables semantic approval when the host omits command and file context", async () => {
    const transport = new MockAgentHostTransport();
    const detail = transport.detail.bind(transport);
    transport.detail = async (agentId, options) => ({
      ...await detail(agentId, options),
      pendingApprovals: [{ id: "opaque-approval", kind: "other", summary: "Approval request" }],
    });
    const { user } = renderDashboard(transport);

    await user.selectOptions(screen.getByLabelText("Status"), "blocked");
    await user.click((await screen.findAllByRole("button", { name: /Sanitized agent/ }))[0]!);

    expect(await screen.findByText(/host did not expose command or file context/)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
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

  it("reloads a bounded page when a visible agent leaves the active filter", async () => {
    let releaseEvent: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const snapshot = vi.spyOn(transport, "snapshot");
    const { user } = renderDashboard(transport);
    await user.selectOptions(await screen.findByLabelText("Status"), "working");
    const target = transport.currentSnapshot.agents.find((agent) => agent.status === "working")!;
    transport.eventStreams = [[{
      type: "agent.upserted",
      revision: 41,
      agent: { ...target, status: "done" },
    }]];
    const callsBeforeEvent = snapshot.mock.calls.length;

    releaseEvent();

    await waitFor(() => expect(snapshot.mock.calls.length).toBeGreaterThan(callsBeforeEvent));
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

  it("ignores a stale detail response after selection changes", async () => {
    const transport = new MockAgentHostTransport();
    const pending: Array<{ id: string; resolve: (detail: AgentDetail) => void }> = [];
    transport.detail = async (id) => await new Promise<AgentDetail>((resolve) => pending.push({ id, resolve }));
    const { user } = renderDashboard(transport);
    await waitFor(() => expect(pending).toHaveLength(1));
    const nextRow = (await screen.findAllByRole("button", { name: /Sanitized agent/ }))
      .find((row) => row.getAttribute("aria-current") !== "true")!;

    await user.click(nextRow);
    await waitFor(() => expect(pending).toHaveLength(2));
    const nextSummary = transport.currentSnapshot.agents.find((agent) => agent.id === pending[1]!.id)!;
    await act(async () => pending[1]!.resolve({ ...nextSummary, pendingApprovals: [] }));
    expect(screen.getByRole("heading", { name: nextSummary.name })).toBeInTheDocument();

    const staleSummary = transport.currentSnapshot.agents.find((agent) => agent.id === pending[0]!.id)!;
    await act(async () => pending[0]!.resolve({ ...staleSummary, name: "Stale detail", pendingApprovals: [] }));
    expect(screen.queryByRole("heading", { name: "Stale detail" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: nextSummary.name })).toBeInTheDocument();
  });

  it("clears detail and action capabilities when the selected agent is removed", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    transport.eventStreams = [[{ type: "agent.removed", revision: 41, agentId: "demo:agent-0002" }]];
    const { user } = renderDashboard(transport);
    await user.click(await screen.findByRole("button", { name: /Sanitized agent 0002/ }));
    await screen.findByRole("heading", { name: "Sanitized agent 0002" });

    releaseEvents();
    expect(await screen.findByText("Select an agent to inspect its public details.")).toBeInTheDocument();
    expect(screen.getByText("Select an agent to inspect available actions.")).toBeInTheDocument();
  });

  it("bounds off-page event bursts to one authoritative reload", async () => {
    let releaseEvents: () => void = () => undefined;
    const transport = new MockAgentHostTransport();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    transport.eventStreams = [Array.from({ length: 20 }, (_, index) => ({
      type: "agent.upserted" as const,
      revision: 41 + index,
      agent: { ...createLargeDemoSnapshot().agents[60]!, id: `demo:off-page-${index}` },
    }))];
    const snapshot = vi.spyOn(transport, "snapshot");
    renderDashboard(transport);
    await screen.findByText("50 shown of 1000");
    const callsBeforeEvents = snapshot.mock.calls.length;

    releaseEvents();
    await screen.findByText("r60");
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(callsBeforeEvents + 1), { timeout: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(snapshot).toHaveBeenCalledTimes(callsBeforeEvents + 1);
  });

  it("cancels a scheduled reload when the client rotates", async () => {
    let releaseEvents: () => void = () => undefined;
    const oldTransport = new MockAgentHostTransport();
    oldTransport.currentSnapshot = createLargeDemoSnapshot();
    oldTransport.holdEventStreams = true;
    oldTransport.eventStreamGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    oldTransport.eventStreams = [[{
      type: "agent.upserted",
      revision: 41,
      agent: { ...createLargeDemoSnapshot().agents[60]!, id: "demo:off-page-rotation" },
    }]];
    const oldSnapshot = vi.spyOn(oldTransport, "snapshot");
    const oldClient = new DefaultAgentHostClient(oldTransport, { supportedApiVersions: ["1"] });
    const newTransport = new MockAgentHostTransport();
    newTransport.currentSnapshot = createLargeDemoSnapshot();
    newTransport.holdEventStreams = true;
    const newClient = new DefaultAgentHostClient(newTransport, { supportedApiVersions: ["1"] });
    const rendered = render(<App client={oldClient} />);
    await screen.findByText("50 shown of 1000");

    releaseEvents();
    await screen.findByText("r41");
    rendered.rerender(<App client={newClient} />);
    const callsAfterRotation = oldSnapshot.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(oldSnapshot).toHaveBeenCalledTimes(callsAfterRotation);
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

  it("reports a notification permission request failure", async () => {
    const gateway = new RecordingNotificationGateway();
    gateway.requestFailure = new Error("browser rejected request");
    const { user } = renderDailyDashboard(new MockAgentHostTransport(), gateway);
    await screen.findByText("50 shown of 1000");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Enable desktop notifications" }));

    expect(await screen.findByText(/Notification permission could not be requested/)).toBeInTheDocument();
    expect(screen.getByText(/Browser permission:/)).toHaveTextContent("default");
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
    expect(screen.getByText(/events-after-revision/)).toBeInTheDocument();
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

  it("announces when the saved-view limit is reached", async () => {
    const savedViews = Array.from({ length: 12 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
      status: "all" as const,
      provider: "",
      sort: { field: "status" as const, direction: "asc" as const },
    }));
    const { user } = renderDailyDashboard(new MockAgentHostTransport(), new RecordingNotificationGateway(), {
      ...defaultPreferences,
      savedViews,
    });
    await screen.findByText("50 shown of 1000");

    await user.click(screen.getByRole("button", { name: "Save view" }));

    expect(await screen.findByText(/Saved view limit reached/)).toBeInTheDocument();
  });
});
