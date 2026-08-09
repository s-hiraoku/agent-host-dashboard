// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { DefaultAgentHostClient } from "../src/client.js";
import { AgentHostError } from "../src/errors.js";
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
});
