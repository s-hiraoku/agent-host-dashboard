import { describe, expect, it } from "vitest";
import { DefaultAgentHostClient } from "../src/client.js";
import type { ConnectionObserver, ConnectionScheduler, ConnectionState } from "../src/connection.js";
import type { AgentEvent, AgentSnapshot } from "../src/domain.js";
import { AgentHostError } from "../src/errors.js";
import { createDemoSnapshot, demoAgents } from "../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";

const immediateScheduler: ConnectionScheduler = {
  sleep: async (_delay, signal) => {
    if (signal.aborted) throw signal.reason;
  },
  random: () => 0.5,
};

function recorder(onEvent?: (event: AgentEvent) => void): {
  observer: ConnectionObserver;
  states: ConnectionState[];
  snapshots: AgentSnapshot[];
  events: AgentEvent[];
  errors: AgentHostError[];
} {
  const states: ConnectionState[] = [];
  const snapshots: AgentSnapshot[] = [];
  const events: AgentEvent[] = [];
  const errors: AgentHostError[] = [];
  return {
    states,
    snapshots,
    events,
    errors,
    observer: {
      onState: (value) => states.push(value),
      onSnapshot: (value) => snapshots.push(value),
      onEvent: (value) => {
        events.push(value);
        onEvent?.(value);
      },
      onError: (value) => errors.push(value),
    },
  };
}

describe("agent-host connection", () => {
  it("detects a revision gap, resyncs a bounded snapshot, and resumes", async () => {
    const transport = new MockAgentHostTransport();
    transport.snapshots = [createDemoSnapshot(40), createDemoSnapshot(42)];
    transport.eventStreams = [
      [{ type: "heartbeat", revision: 42 }],
      [{ type: "agent.upserted", revision: 43, agent: demoAgents[0]! }],
    ];
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    let close: () => void = () => undefined;
    const recorded = recorder(() => close());
    const connection = client.connect(recorded.observer, { scheduler: immediateScheduler });
    close = connection.close;
    await connection.completed;

    expect(recorded.snapshots.map((snapshot) => snapshot.revision)).toEqual([40, 42]);
    expect(recorded.errors.some((error) => error.code === "revision_gap")).toBe(true);
    expect(recorded.states.some((value) => value.status === "stale")).toBe(true);
    expect(recorded.events.map((event) => event.revision)).toEqual([43]);
  });

  it("reconnects with backoff after a retryable stream failure", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [
      new AgentHostError("connection_failed", "offline", { retryable: true }),
      [{ type: "heartbeat", revision: 41 }],
    ];
    const delays: number[] = [];
    const scheduler: ConnectionScheduler = {
      sleep: async (delay, signal) => {
        if (signal.aborted) throw signal.reason;
        delays.push(delay);
      },
      random: () => 0.5,
    };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    let close: () => void = () => undefined;
    const recorded = recorder(() => close());
    const connection = client.connect(recorded.observer, { scheduler, initialBackoffMs: 250 });
    close = connection.close;
    await connection.completed;

    expect(delays).toEqual([250]);
    expect(recorded.states.some((value) => value.status === "reconnecting" && value.attempt === 1)).toBe(true);
    expect(recorded.snapshots.map((snapshot) => snapshot.revision)).toEqual([40, 40]);
  });

  it("accepts multiple sequenced events for one snapshot revision", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [[
      { type: "agent.upserted", revision: 41, sequence: 10, agent: { ...demoAgents[0]!, name: "First" } },
      { type: "agent.upserted", revision: 41, sequence: 11, agent: { ...demoAgents[1]!, name: "Second" } },
    ]];
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    let close: () => void = () => undefined;
    const recorded = recorder(() => {
      if (recorded.events.length === 2) close();
    });
    const connection = client.connect(recorded.observer, { scheduler: immediateScheduler });
    close = connection.close;
    await connection.completed;

    expect(recorded.events.map((event) => event.sequence)).toEqual([10, 11]);
    expect(recorded.errors).toEqual([]);
  });

  it("detects a sequence gap even when the snapshot revision is unchanged", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [[
      { type: "heartbeat", revision: 40, sequence: 10 },
      { type: "heartbeat", revision: 40, sequence: 12 },
    ]];
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const recorded = recorder();

    await client.connect(recorded.observer, { scheduler: immediateScheduler, maxConsecutiveResyncs: 0 }).completed;

    expect(recorded.events.map((event) => event.sequence)).toEqual([10]);
    expect(recorded.errors).toContainEqual(expect.objectContaining({ code: "revision_gap" }));
    expect(recorded.states.at(-1)?.status).toBe("disconnected");
  });

  it("retries initial discovery failures until the host becomes available", async () => {
    const transport = new MockAgentHostTransport();
    let attempts = 0;
    transport.discover = async () => {
      attempts += 1;
      if (attempts === 1) throw new AgentHostError("connection_failed", "host starting", { retryable: true });
      return transport.apiInfo;
    };
    transport.eventStreams = [[{ type: "heartbeat", revision: 41 }]];
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    let close: () => void = () => undefined;
    const recorded = recorder(() => close());
    const connection = client.connect(recorded.observer, { scheduler: immediateScheduler });
    close = connection.close;
    await connection.completed;

    expect(attempts).toBe(2);
    expect(recorded.states.some((value) => value.status === "reconnecting")).toBe(true);
    expect(recorded.snapshots).toHaveLength(1);
  });

  it("disconnects without retrying a permanent stream failure", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [new AgentHostError("invalid_response", "wrong media type")];
    const delays: number[] = [];
    const scheduler: ConnectionScheduler = {
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
    };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const recorded = recorder();
    await client.connect(recorded.observer, { scheduler }).completed;

    expect(delays).toEqual([]);
    expect(recorded.states.at(-1)?.status).toBe("disconnected");
  });

  it("stops after repeated revision gaps instead of reconnecting forever", async () => {
    const transport = new MockAgentHostTransport();
    transport.snapshots = [createDemoSnapshot(40), createDemoSnapshot(42), createDemoSnapshot(44)];
    transport.eventStreams = [
      [{ type: "heartbeat", revision: 42 }],
      [{ type: "heartbeat", revision: 44 }],
      [{ type: "heartbeat", revision: 46 }],
    ];
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const recorded = recorder();
    await client.connect(recorded.observer, { scheduler: immediateScheduler, maxConsecutiveResyncs: 2 }).completed;

    expect(recorded.snapshots.map((snapshot) => snapshot.revision)).toEqual([40, 42, 44]);
    expect(recorded.states.at(-1)?.status).toBe("disconnected");
    expect(recorded.states.at(-1)?.reason).toMatch(/Repeated revision gaps/);
  });

  it("stops reconnecting for unauthorized and incompatible states", async () => {
    const unauthorizedTransport = new MockAgentHostTransport();
    unauthorizedTransport.eventStreams = [new AgentHostError("unauthorized", "rotate token", { status: 401 })];
    const unauthorizedClient = new DefaultAgentHostClient(unauthorizedTransport, { supportedApiVersions: ["1"] });
    const unauthorized = recorder();
    await unauthorizedClient.connect(unauthorized.observer, { scheduler: immediateScheduler }).completed;
    expect(unauthorized.states.at(-1)?.status).toBe("unauthorized");

    const incompatibleTransport = new MockAgentHostTransport();
    incompatibleTransport.apiInfo = { apiVersion: "2", features: [] };
    const incompatibleClient = new DefaultAgentHostClient(incompatibleTransport, { supportedApiVersions: ["1"] });
    const incompatible = recorder();
    await incompatibleClient.connect(incompatible.observer, { scheduler: immediateScheduler }).completed;
    expect(incompatible.states.at(-1)?.status).toBe("incompatible");
  });

  it("does not consume a queued event stream when already cancelled", async () => {
    const transport = new MockAgentHostTransport();
    transport.eventStreams = [[{ type: "heartbeat", revision: 41 }]];
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      transport.events({ afterRevision: 40, signal: controller.signal })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.eventStreams).toHaveLength(1);
  });
});
