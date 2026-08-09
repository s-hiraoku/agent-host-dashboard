import { describe, expect, it } from "vitest";
import { createLargeDemoSnapshot, demoAgents } from "../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";

describe("sanitized fixtures", () => {
  it("keeps full detail records separate from summary snapshots", async () => {
    const transport = new MockAgentHostTransport();
    const agentId = "demo:harbor-approval";
    const detail = await transport.detail(agentId);
    const summary = transport.currentSnapshot.agents.find((agent) => agent.id === agentId);

    expect(detail.pendingApprovals[0]).toMatchObject({ command: "npm run verify:release" });
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("pendingApprovals");
  });

  it("contain all representative statuses and capability combinations", () => {
    expect(new Set(demoAgents.map((agent) => agent.status))).toEqual(
      new Set(["unknown", "idle", "working", "blocked", "done", "error"]),
    );
    expect(demoAgents.some((agent) => agent.capabilities.approve && agent.capabilities.reject)).toBe(true);
    expect(demoAgents.some((agent) => Object.keys(agent.capabilities).length === 0)).toBe(true);
  });

  it("generates exactly 1,000 bounded public records without private data", () => {
    const snapshot = createLargeDemoSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.agents).toHaveLength(1_000);
    expect(serialized).not.toMatch(/token|authorization|users\//i);
    expect(serialized).not.toContain("hiraoku");
  });

  it("accepts zero and rejects invalid large-fixture counts", () => {
    expect(createLargeDemoSnapshot(0)).toMatchObject({ agents: [], total: 0 });
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createLargeDemoSnapshot(count)).toThrow(RangeError);
    }
  });

  it("resolves detail from the snapshot selected by the mock transport", async () => {
    const transport = new MockAgentHostTransport();
    const selected = createLargeDemoSnapshot(1);
    transport.snapshots = [selected];
    await transport.snapshot({});

    await expect(transport.detail(selected.agents[0]!.id)).resolves.toMatchObject({
      id: selected.agents[0]!.id,
      pendingApprovals: [],
    });
    await expect(transport.detail(demoAgents[1]!.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports aggregate facets for the active filter scope", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();

    const snapshot = await transport.snapshot({ filter: { statuses: ["blocked"] } });

    expect(snapshot.total).toBeGreaterThan(0);
    expect(snapshot.facets?.byStatus).toEqual({ blocked: snapshot.total });
    expect(Object.values(snapshot.facets?.byProvider ?? {}).reduce((sum, count) => sum + count, 0)).toBe(snapshot.total);
  });

  it("does not hang a held direct event stream without a cancellation signal", async () => {
    const transport = new MockAgentHostTransport();
    transport.holdEventStreams = true;

    await expect(transport.events({ afterRevision: 40 })[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
