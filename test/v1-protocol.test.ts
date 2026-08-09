import { describe, expect, it } from "vitest";
import { AgentHostError } from "../src/errors.js";
import { AgentHostV1Protocol } from "../src/http/v1-protocol.js";
import type { HttpChannel, HttpRequest, HttpResponse, SseFrame, SseRequest } from "../src/http/types.js";

const agent = {
  id: "demo:blocked",
  provider: "demo",
  source: "demo-fixture",
  name: "Approval required",
  status: "blocked",
  capabilities: { prompt: false, read: true, approve: true, reject: true, interrupt: false },
  cwd: "/fixture/project",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  discoveredAt: "2026-01-01T00:00:00.000Z",
  discovery: { confidence: "high", visibility: "active" },
};

class RecordingChannel implements HttpChannel {
  readonly requests: HttpRequest[] = [];
  readonly eventRequests: SseRequest[] = [];
  responses: unknown[] = [];
  frames: SseFrame[] = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: this.responses.shift() as T };
  }

  async *events(request: SseRequest): AsyncIterable<SseFrame> {
    this.eventRequests.push(request);
    yield* this.frames;
  }
}

function frame(event: string, body: Record<string, unknown>): SseFrame {
  return { event, data: JSON.stringify({ apiVersion: "1", ...body }) };
}

describe("AgentHostV1Protocol", () => {
  it("encodes bounded filters and decodes provider-neutral summaries without inventing facets", async () => {
    const channel = new RecordingChannel();
    channel.responses = [{ apiVersion: "1", revision: 7, agents: [agent], page: { limit: 50, total: 1, nextCursor: "next-page" } }];
    const protocol = new AgentHostV1Protocol();

    const snapshot = await protocol.snapshot(channel, {
      limit: 50,
      filter: { providers: ["demo"], statuses: ["blocked"], text: "approval", cwd: "/fixture", view: "active" },
    });

    expect(channel.requests[0]?.path).toBe("/v1/agents?limit=50&provider=demo&status=blocked&cwd=%2Ffixture&q=approval&view=active");
    expect(snapshot).toMatchObject({ revision: 7, total: 1, nextCursor: "next-page" });
    expect(snapshot).not.toHaveProperty("facets");
    expect(snapshot.agents[0]).toMatchObject({ id: agent.id, capabilities: { read: true, approve: true, reject: true } });
    await expect(protocol.snapshot(channel, { sort: { field: "name", direction: "asc" } })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("decodes detail approvals and adapter health without provider-native branching", async () => {
    const channel = new RecordingChannel();
    channel.responses = [
      { apiVersion: "1", revision: 7, agent: { ...agent, pendingApprovals: [{ approvalId: "approval-1", method: "demo/requestApproval", reason: "Verify", command: "npm test" }] } },
      { apiVersion: "1", revision: 7, adapters: [{ id: "demo", status: "error", lastAttemptAt: "2026-01-01T00:00:01.000Z", lastSuccessAt: null, durationMs: 12, agentCount: 0, error: { code: "demo_unavailable", message: "deterministic failure" } }] },
    ];
    const protocol = new AgentHostV1Protocol();

    const detail = await protocol.detail(channel, agent.id);
    const health = await protocol.adapterHealth(channel);

    expect(channel.requests[0]?.path).toBe("/v1/agents/demo%3Ablocked");
    expect(detail.pendingApprovals[0]).toEqual({ id: "approval-1", kind: "command", summary: "Verify", reason: "Verify", command: "npm test" });
    expect(health[0]).toMatchObject({ id: "demo", status: "unavailable", error: { code: "demo_unavailable", retryable: true } });
  });

  it("uses one safe idempotency key as the local action correlation id", async () => {
    const channel = new RecordingChannel();
    channel.responses = [{ apiVersion: "1", result: { ok: true, agentId: agent.id, action: "approve", replayed: false } }];
    const protocol = new AgentHostV1Protocol({ createIdempotencyKey: () => "action-request-0001" });

    const result = await protocol.action(channel, { id: agent.id }, { kind: "approve", approvalId: "approval-1" });

    expect(result).toEqual({ ok: true, actionId: "action-request-0001" });
    expect(channel.requests[0]).toMatchObject({
      path: "/v1/agents/demo%3Ablocked/approve",
      method: "POST",
      headers: { "idempotency-key": "action-request-0001" },
      body: { approvalId: "approval-1" },
    });
    await expect(protocol.action(channel, { id: agent.id }, { kind: "read", expectedRevision: 7 })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reuses the same idempotency key for one bounded transport retry", async () => {
    const channel = new RecordingChannel();
    const request = channel.request.bind(channel);
    let attempts = 0;
    channel.request = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new AgentHostError("connection_failed", "connection reset", { retryable: true });
      return await request(input);
    };
    channel.responses = [{ apiVersion: "1", result: { ok: true, agentId: agent.id, action: "read", replayed: true } }];
    let keyCalls = 0;
    const protocol = new AgentHostV1Protocol({ createIdempotencyKey: () => {
      keyCalls += 1;
      return "retry-action-0001";
    } });

    await expect(protocol.action(channel, { id: agent.id }, { kind: "read" })).resolves.toEqual({ ok: true, actionId: "retry-action-0001" });
    expect(attempts).toBe(2);
    expect(keyCalls).toBe(1);
    expect(channel.requests.map((value) => value.headers?.["idempotency-key"])).toEqual(["retry-action-0001"]);
  });

  it("keeps stream sequence separate from snapshot revision and ignores unknown events", async () => {
    const channel = new RecordingChannel();
    channel.frames = [
      frame("ready", { ok: true, revision: 7, sequence: 20 }),
      frame("agent.discovered", { sequence: 21, snapshotRevision: 8, agent }),
      frame("agent.updated", { sequence: 22, snapshotRevision: 8, agent: { ...agent, name: "Updated" } }),
      frame("future.event", { sequence: 23, snapshotRevision: 8, payload: "ignored" }),
      frame("audit.action", { sequence: 24, snapshotRevision: 8, phase: "completed", requestId: "request-1", agentId: agent.id, action: "approve", ok: true }),
    ];
    const protocol = new AgentHostV1Protocol();
    const events = [];

    for await (const decoded of protocol.events(channel, { afterRevision: 7 })) events.push(decoded);

    expect(events.map((value) => [value.type, value.revision, value.sequence])).toEqual([
      ["agent.upserted", 8, 21],
      ["agent.upserted", 8, 22],
      ["action.completed", 8, 24],
    ]);
  });

  it("fails closed on ready mismatch, sequence gaps, and incompatible frames", async () => {
    const readyMismatch = new RecordingChannel();
    readyMismatch.frames = [frame("ready", { revision: 8, sequence: 1 })];
    const protocol = new AgentHostV1Protocol();
    await expect(protocol.events(readyMismatch, { afterRevision: 7 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "revision_gap" });

    const gap = new RecordingChannel();
    gap.frames = [frame("ready", { revision: 7, sequence: 1 }), frame("agent.updated", { sequence: 3, snapshotRevision: 8, agent })];
    await expect(protocol.events(gap, { afterRevision: 7 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "revision_gap" });

    const incompatible = new RecordingChannel();
    incompatible.frames = [{ event: "ready", data: JSON.stringify({ apiVersion: "2", revision: 7, sequence: 1 }) }];
    await expect(protocol.events(incompatible, { afterRevision: 7 })[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AgentHostError);
    await expect(protocol.events(incompatible, { afterRevision: 7 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "incompatible_version" });
  });
});
