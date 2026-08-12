import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FetchHttpChannel } from "../../src/http/fetch-channel.js";
import { AgentHostV1Protocol } from "../../src/http/v1-protocol.js";
import type { HttpChannel, HttpRequest, HttpResponse, SseFrame, SseRequest } from "../../src/http/types.js";
import { createLargeDemoSnapshot } from "../../src/testing/fixtures.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../contracts/agent-host-v1/${name}.json`, import.meta.url), "utf8")) as T;
}

class FixtureChannel implements HttpChannel {
  requests: HttpRequest[] = [];
  responses: unknown[] = [];
  frames: SseFrame[] = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: this.responses.shift() as T };
  }

  async *events(_request: SseRequest): AsyncIterable<SseFrame> {
    yield* this.frames;
  }
}

function sameRequestPath(actual: string, expected: string): boolean {
  const left = new URL(actual, "http://fixture.local");
  const right = new URL(expected, "http://fixture.local");
  return left.pathname === right.pathname
    && [...left.searchParams].sort().toString() === [...right.searchParams].sort().toString();
}

describe("pinned agent-host v1 client conformance", () => {
  it("drives snapshot decoding from the official snapshot fixture", async () => {
    const pinned = fixture<{
      fixtureVersion: number;
      request: { method: string; path: string };
      expected: { apiVersion: string; agentCount: number; statuses: string[]; provider: string };
    }>("snapshot");
    const channel = new FixtureChannel();
    channel.responses = [{
      apiVersion: pinned.expected.apiVersion,
      revision: 1,
      agents: pinned.expected.statuses.map((status, index) => ({
        id: `demo:${status}`,
        provider: pinned.expected.provider,
        source: "demo",
        name: `Demo ${status}`,
        status,
        capabilities: {},
        lastActivityAt: `2026-01-01T00:00:0${index}.000Z`,
      })),
      page: { limit: 200, total: pinned.expected.agentCount },
    }];

    const snapshot = await new AgentHostV1Protocol().snapshot(channel, { limit: 200, filter: { view: "raw" } });

    expect(pinned.fixtureVersion).toBe(1);
    expect(sameRequestPath(channel.requests[0]!.path, pinned.request.path)).toBe(true);
    expect(snapshot.agents).toHaveLength(pinned.expected.agentCount);
    expect(snapshot.agents.map((agent) => agent.status)).toEqual(pinned.expected.statuses);
  });

  it("drives prompt encoding and correlation from the official action fixture", async () => {
    const pinned = fixture<{
      request: { method: "POST"; path: string; body: { text: string } };
      expected: { agentId: string; action: "prompt" };
    }>("action");
    const channel = new FixtureChannel();
    channel.responses = [{ apiVersion: "1", result: { ok: true, agentId: pinned.expected.agentId, action: pinned.expected.action, replayed: false } }];
    const protocol = new AgentHostV1Protocol({ createIdempotencyKey: () => "fixture-action-0001" });

    await expect(protocol.action(channel, { id: pinned.expected.agentId }, { kind: "prompt", text: pinned.request.body.text })).resolves.toEqual({ ok: true, actionId: "fixture-action-0001" });
    expect(channel.requests[0]).toMatchObject({ path: pinned.request.path, method: pinned.request.method, body: pinned.request.body });
  });

  it("decodes official approval and adapter-failure fixtures without private metadata", async () => {
    const approval = fixture<{ agentId: string; status: string; pendingApproval: Record<string, unknown> }>("approval");
    const adapter = fixture<{ response: Record<string, unknown> }>("adapter-failure");
    const channel = new FixtureChannel();
    channel.responses = [
      { apiVersion: "1", revision: 1, agent: { id: approval.agentId, provider: "demo", source: "demo", name: "Approval", status: approval.status, capabilities: { approve: true, reject: true }, pendingApprovals: [approval.pendingApproval] } },
      adapter.response,
    ];
    const protocol = new AgentHostV1Protocol();

    const detail = await protocol.detail(channel, approval.agentId);
    const health = await protocol.adapterHealth(channel);

    expect(detail.pendingApprovals[0]).toMatchObject({ id: "demo-approval-1", kind: "other" });
    expect(health[0]).toMatchObject({ id: "demo-failure", status: "unavailable", error: { code: "demo_unavailable" } });
    expect(JSON.stringify({ detail, health })).not.toMatch(/token|authorization|metadata/i);
  });

  it("applies the official reconnect rule for sequence and ready gaps", async () => {
    const pinned = fixture<{
      firstConnection: { ready: Record<string, unknown>; event: { type: string; sequence: number; snapshotRevision: number } };
      reconnection: { ready: Record<string, unknown>; clientRule: string };
    }>("event-reconnect");
    const protocol = new AgentHostV1Protocol();
    const first = new FixtureChannel();
    first.frames = [
      { event: "ready", data: JSON.stringify(pinned.firstConnection.ready) },
      { event: pinned.firstConnection.event.type, data: JSON.stringify({ apiVersion: "1", ...pinned.firstConnection.event }) },
    ];
    await expect(protocol.events(first, { afterRevision: 1 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "revision_gap" });

    const reconnect = new FixtureChannel();
    reconnect.frames = [{ event: "ready", data: JSON.stringify(pinned.reconnection.ready) }];
    await expect(protocol.events(reconnect, { afterRevision: 1 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "revision_gap" });
    expect(pinned.reconnection.clientRule).toMatch(/replace the local snapshot/);
  });

  it("maps the official structured error and pins the 1,000-agent scale artifact", async () => {
    const pinnedError = fixture<{ request: { path: string }; expected: { status: number; apiVersion: string; code: string } }>("error");
    const manifest = fixture<{ commit: string; largeList: { gitBlobSha: string; bytes: number; agentCount: number } }>("manifest");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      apiVersion: pinnedError.expected.apiVersion,
      error: { code: pinnedError.expected.code, message: "agent not found" },
    }), { status: pinnedError.expected.status, headers: { "content-type": "application/json" } }));

    await expect(new FetchHttpChannel({ fetch }).request({ path: pinnedError.request.path })).rejects.toMatchObject({
      code: "not_found",
      details: { apiCode: pinnedError.expected.code },
    });
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.largeList).toMatchObject({ gitBlobSha: "75a40a60e80f331673a5d6086b8b924dd3564e05", bytes: 544491, agentCount: 1000 });
    expect(createLargeDemoSnapshot(manifest.largeList.agentCount).agents).toHaveLength(1000);
  });
});
