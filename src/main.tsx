import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DefaultAgentHostClient } from "./client.js";
import type { AgentEvent } from "./domain.js";
import { AgentHostError } from "./errors.js";
import { createLargeDemoSnapshot, demoAdapterHealth } from "./testing/fixtures.js";
import { MockAgentHostTransport } from "./testing/mock-transport.js";
import "./styles.css";

const transport = new MockAgentHostTransport();
const snapshot = createLargeDemoSnapshot();
transport.currentSnapshot = snapshot;
transport.holdEventStreams = true;
const fixtureMode = new URLSearchParams(window.location.search).get("fixture") ?? "live";

async function holdUntilAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

if (fixtureMode === "incompatible") {
  transport.apiInfo = { apiVersion: "2", serverVersion: "demo-incompatible", features: [] };
} else if (fixtureMode === "unauthorized") {
  transport.eventStreams = [new AgentHostError("unauthorized", "The demo credential was rejected.", { status: 401 })];
} else if (fixtureMode === "reconnect") {
  let streamAttempt = 0;
  transport.events = async function* reconnectingEvents(options): AsyncIterable<AgentEvent> {
    streamAttempt += 1;
    if (streamAttempt === 1) {
      throw new AgentHostError("connection_failed", "The demo stream was interrupted.", { retryable: true });
    }
    yield { type: "heartbeat", revision: 41 };
    await holdUntilAbort(options.signal);
  };
} else if (fixtureMode === "gap") {
  let streamAttempt = 0;
  const snapshotRequest = transport.snapshot.bind(transport);
  transport.snapshot = async (request, options) => {
    if (transport.currentSnapshot.revision === 42) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return await snapshotRequest(request, options);
  };
  transport.events = async function* gapEvents(options): AsyncIterable<AgentEvent> {
    streamAttempt += 1;
    if (streamAttempt === 1) {
      transport.currentSnapshot = createLargeDemoSnapshot(1_000, 42);
      yield { type: "heartbeat", revision: 42 };
      return;
    }
    const updated = { ...transport.currentSnapshot.agents[0]!, name: "Resynchronized live agent" };
    yield { type: "agent.upserted", revision: 43, agent: updated };
    await holdUntilAbort(options.signal);
  };
} else if (fixtureMode === "delayed-update") {
  transport.events = async function* delayedUpdateEvents(options): AsyncIterable<AgentEvent> {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const updated = { ...snapshot.agents[0]!, name: "Delayed live agent" };
    yield { type: "agent.upserted", revision: 41, agent: updated };
    await holdUntilAbort(options.signal);
  };
} else {
  transport.eventStreams = [
    [
      { type: "heartbeat", revision: 41 },
      { type: "adapter.health", revision: 42, adapter: demoAdapterHealth[0]! },
      { type: "action.completed", revision: 43, agentId: snapshot.agents[0]!.id, actionId: "demo-action-live", ok: true },
    ],
  ];
}
const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
const app = <App client={client} now={() => Date.parse("2026-01-15T09:31:00.000Z")} />;
createRoot(root).render(fixtureMode === "live" ? <StrictMode>{app}</StrictMode> : app);
