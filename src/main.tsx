import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DefaultAgentHostClient } from "./client.js";
import { DailyDriverShell } from "./daily/DailyDriverShell.js";
import { LocalPreferenceStore } from "./daily/preferences.js";
import { assertOpenSession, type ClientConnector } from "./daily/session.js";
import type { AgentEvent } from "./domain.js";
import { AgentHostError } from "./errors.js";
import { createLargeDemoSnapshot, demoAdapterHealth } from "./testing/fixtures.js";
import { MockAgentHostTransport } from "./testing/mock-transport.js";
import "./styles.css";

const parameters = new URLSearchParams(window.location.search);
const fixtureMode = parameters.get("fixture") ?? "onboarding";

async function holdUntilAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

async function delayUnlessAborted(milliseconds: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createFixtureClient(mode: string): DefaultAgentHostClient {
  const transport = new MockAgentHostTransport();
  const snapshot = createLargeDemoSnapshot();
  transport.currentSnapshot = snapshot;
  transport.holdEventStreams = true;
  if (mode === "incompatible") {
    transport.apiInfo = { apiVersion: "2", serverVersion: "demo-incompatible", features: [] };
  } else if (mode === "unauthorized") {
    transport.eventStreams = [new AgentHostError("unauthorized", "The demo credential was rejected.", { status: 401 })];
  } else if (mode === "reconnect") {
    let streamAttempt = 0;
    transport.events = async function* reconnectingEvents(options): AsyncIterable<AgentEvent> {
      streamAttempt += 1;
      if (streamAttempt === 1) {
        throw new AgentHostError("connection_failed", "The demo stream was interrupted.", { retryable: true });
      }
      yield { type: "heartbeat", revision: 41 };
      await holdUntilAbort(options.signal);
    };
  } else if (mode === "gap") {
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
  } else if (mode === "delayed-update") {
    transport.events = async function* delayedUpdateEvents(options): AsyncIterable<AgentEvent> {
      if (!(await delayUnlessAborted(1_000, options.signal))) return;
      const updated = { ...snapshot.agents[0]!, name: "Delayed live agent" };
      yield { type: "agent.upserted", revision: 41, agent: updated };
      await holdUntilAbort(options.signal);
    };
  } else {
    transport.eventStreams = [[
      { type: "heartbeat", revision: 41 },
      { type: "adapter.health", revision: 42, adapter: demoAdapterHealth[0]! },
      { type: "action.completed", revision: 43, agentId: snapshot.agents[0]!.id, actionId: "demo-action-live", ok: true },
    ]];
  }
  return new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
}

let connectionAttempt = 0;
const demoConnector: ClientConnector = {
  async open(input, signal) {
    assertOpenSession(signal);
    connectionAttempt += 1;
    input.credential();
    const plannedFailure = parameters.get("connection");
    if (connectionAttempt === 1 && plannedFailure === "unauthorized") {
      throw new AgentHostError("unauthorized", "The supplied credential was rejected.", { status: 401 });
    }
    if (connectionAttempt === 1 && plannedFailure === "incompatible") {
      throw new AgentHostError("incompatible_version", "Host API v2 is outside the supported range.");
    }
    if (connectionAttempt === 1 && plannedFailure === "unavailable") {
      throw new AgentHostError("connection_failed", "No agent-host responded at the loopback endpoint.", { retryable: true });
    }
    return { client: createFixtureClient("live"), close() {} };
  },
};

const blockedConnector: ClientConnector = {
  async open() {
    throw new AgentHostError(
      "unsupported",
      "This build does not include an agent-host HTTP/SSE adapter because the versioned public wire contract is not yet confirmed.",
    );
  },
};

const simulationNotice = "Simulation mode · sanitized fixtures only. No request is sent to the endpoint.";
const unavailableConnectorNotice = "Public HTTP/SSE connector unavailable · this build fails closed until the versioned agent-host wire contract is confirmed.";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
const app = fixtureMode === "onboarding"
  ? <DailyDriverShell
      connector={import.meta.env.DEV ? demoConnector : blockedConnector}
      preferenceStore={new LocalPreferenceStore()}
      environmentNotice={import.meta.env.DEV ? simulationNotice : unavailableConnectorNotice}
    />
  : <App client={createFixtureClient(fixtureMode)} now={() => Date.parse("2026-01-15T09:31:00.000Z")} />;
createRoot(root).render(fixtureMode === "live" || fixtureMode === "onboarding" ? <StrictMode>{app}</StrictMode> : app);
