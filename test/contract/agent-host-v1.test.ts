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

  it("drives additive list-features and file-approval fixtures through the production codec", async () => {
    const list = fixture<{
      request: { path: string };
      responseShape: {
        revision: number;
        facets: { revision: number; providers: Array<{ value: string; count: number }>; statuses: Array<{ value: string; count: number }> };
        page: { sort: string; direction: string; total: number };
        agentProject: { id: string; name: string; scope: string };
      };
    }>("list-features");
    const file = fixture<{
      agentId: string;
      status: string;
      pendingApproval: Record<string, unknown>;
      clientRule: string;
    }>("file-approval");
    const channel = new FixtureChannel();
    channel.responses = [
      {
        apiVersion: "1",
        revision: list.responseShape.revision,
        agents: [{
          id: "codex:alpha",
          provider: "codex",
          source: "codex",
          name: "Alpha",
          status: "working",
          capabilities: {},
          cwd: "/workspace/project",
          project: list.responseShape.agentProject,
        }],
        page: { limit: 50, total: list.responseShape.page.total, sort: list.responseShape.page.sort, direction: list.responseShape.page.direction },
        facets: list.responseShape.facets,
      },
      {
        apiVersion: "1",
        revision: 1,
        agent: {
          id: file.agentId,
          provider: "codex",
          source: "codex",
          name: "File change",
          status: file.status,
          capabilities: { approve: true, reject: true },
          pendingApprovals: [file.pendingApproval],
        },
      },
    ];
    const protocol = new AgentHostV1Protocol();
    const snapshot = await protocol.snapshot(channel, { limit: 50, filter: { view: "recent", providers: ["codex"] }, sort: { field: "name", direction: "asc" } });
    const detail = await protocol.detail(channel, file.agentId);

    expect(sameRequestPath(channel.requests[0]!.path, list.request.path)).toBe(true);
    expect(snapshot.sort).toEqual({ field: "name", direction: "asc" });
    expect(snapshot.facets).toEqual({
      revision: 12,
      byProvider: { codex: 2, herdr: 1 },
      byStatus: { blocked: 1, working: 1 },
    });
    expect(snapshot.agents[0]?.project).toEqual(list.responseShape.agentProject);
    expect(detail.pendingApprovals[0]).toMatchObject({
      id: "fixture-file-approval-1",
      kind: "file",
      actionable: true,
      files: [
        { path: "src/agent.js", kind: "update" },
        { path: "test/agent.test.js", kind: "add" },
      ],
    });
    expect(file.clientRule).toMatch(/Never offer approve or reject when actionable is false/);
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

  it("drives repository-association fixtures through the production codec", async () => {
    const pinned = fixture<{
      capability: { path: string; name: string; version: string; maxItems: number };
      request: { method: string; pathTemplate: string };
      cases: {
        zero: { agentId: string; response: { state: string; freshness: string; complete: boolean; associations: unknown[] } };
        one: { agentId: string; associationCount: number; repository: { forge: string; host: string; coordinates: { kind: string; owner: string; name: string }; webUrl: string } };
        unsupported: { agentId: string; state: string; reason: string };
      };
      changedAssociation: { agentId: string; event: string; payloadRule: string };
      hostUnsupportedRule: string;
    }>("repository-associations");
    const channel = new FixtureChannel();
    channel.responses = [
      {
        apiVersion: "1",
        capabilities: {
          repositoryAssociations: {
            status: "supported",
            versions: [pinned.capability.version],
            maxItems: pinned.capability.maxItems,
            events: [pinned.changedAssociation.event],
            replay: false,
          },
        },
      },
      {
        apiVersion: "1",
        associationVersion: pinned.capability.version,
        revision: 1,
        agentId: pinned.cases.zero.agentId,
        ...pinned.cases.zero.response,
      },
      {
        apiVersion: "1",
        associationVersion: pinned.capability.version,
        revision: 1,
        agentId: pinned.cases.one.agentId,
        state: "ready",
        freshness: "current",
        complete: true,
        associations: [{
          kind: "confirmed",
          repository: pinned.cases.one.repository,
          provenance: { source: "adapter-authoritative", confidence: "high" },
        }],
      },
      {
        apiVersion: "1",
        associationVersion: pinned.capability.version,
        revision: 1,
        agentId: pinned.cases.unsupported.agentId,
        state: pinned.cases.unsupported.state,
        reason: pinned.cases.unsupported.reason,
      },
    ];
    const protocol = new AgentHostV1Protocol();

    const capability = await protocol.repositoryCapability(channel);
    const zero = await protocol.repositoryContext(channel, pinned.cases.zero.agentId);
    const one = await protocol.repositoryContext(channel, pinned.cases.one.agentId);
    const unsupported = await protocol.repositoryContext(channel, pinned.cases.unsupported.agentId);

    expect(sameRequestPath(channel.requests[0]!.path, pinned.capability.path)).toBe(true);
    expect(capability).toMatchObject({ versions: [pinned.capability.version], maxItems: pinned.capability.maxItems, replay: false });
    expect(zero).toEqual({
      state: "ready",
      freshness: "current",
      complete: true,
      associations: [],
      revision: 1,
    });
    expect(one.state).toBe("ready");
    if (one.state !== "ready") return;
    expect(one.associations).toHaveLength(pinned.cases.one.associationCount);
    expect(one).toMatchObject({
      state: "ready",
      associations: [{
        kind: "confirmed",
        repository: {
          service: "github",
          host: pinned.cases.one.repository.host,
          owner: pinned.cases.one.repository.coordinates.owner,
          name: pinned.cases.one.repository.coordinates.name,
        },
      }],
    });
    expect(unsupported).toEqual({ state: "unsupported", reason: pinned.cases.unsupported.reason });
    expect(channel.requests[2]?.path).toBe(pinned.request.pathTemplate.replace("{agentId}", encodeURIComponent(pinned.cases.one.agentId)));
    expect(pinned.changedAssociation.payloadRule).toMatch(/never expect repository identity/);
    expect(pinned.hostUnsupportedRule).toMatch(/404 for the capability endpoint means unsupported/);
  });
});
