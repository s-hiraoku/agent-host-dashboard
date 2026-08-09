import { describe, expect, it } from "vitest";
import {
  applyVisibleEvent,
  findAttentionAgent,
  providerMetrics,
  reconcileVisibleEvents,
  statusMetrics,
} from "../src/dashboard/use-cases.js";
import { createLargeDemoSnapshot } from "../src/testing/fixtures.js";

describe("dashboard use cases", () => {
  it("builds provider and status summaries from bounded snapshot facets", () => {
    const snapshot = createLargeDemoSnapshot();
    const withFacets = {
      ...snapshot,
      facets: {
        byStatus: { blocked: 167, error: 166, working: 167, idle: 167, done: 167, unknown: 166 },
        byProvider: { "demo-alpha": 334, "demo-beta": 333, "demo-gamma": 167, "demo-process": 166 },
      },
    };

    expect(statusMetrics(withFacets).find((metric) => metric.status === "blocked")?.count).toBe(167);
    expect(providerMetrics(withFacets)[0]).toEqual(["demo-alpha", 334]);
  });

  it("updates a visible row in place without changing row order or selection identity", () => {
    const snapshot = createLargeDemoSnapshot(10);
    const target = snapshot.agents[4]!;
    const updated = applyVisibleEvent(snapshot, {
      type: "agent.upserted",
      revision: 41,
      agent: { ...target, status: "blocked" },
    });

    expect(updated.agents.map((agent) => agent.id)).toEqual(snapshot.agents.map((agent) => agent.id));
    expect(updated.agents[4]?.status).toBe("blocked");
    expect(updated.revision).toBe(41);
  });

  it("removes a visible row that no longer belongs to the active filter", () => {
    const snapshot = createLargeDemoSnapshot(10);
    const target = snapshot.agents[0]!;
    const updated = applyVisibleEvent(
      snapshot,
      { type: "agent.upserted", revision: 41, agent: { ...target, status: "done" } },
      (agent) => agent.status === "working",
    );

    expect(updated.agents).not.toContainEqual(expect.objectContaining({ id: target.id }));
    expect(updated.total).toBe(9);
  });

  it("replays live events over an older snapshot response and updates metadata", () => {
    const snapshot = {
      ...createLargeDemoSnapshot(10),
      facets: { byStatus: { working: 10 }, byProvider: { "demo-alpha": 10 } },
    };
    const target = snapshot.agents[0]!;
    const reconciled = reconcileVisibleEvents(snapshot, [
      { type: "agent.upserted", revision: 41, agent: { ...target, name: "Live update" } },
      { type: "agent.removed", revision: 42, agentId: target.id },
    ]);

    expect(reconciled.revision).toBe(42);
    expect(reconciled.agents).not.toContainEqual(expect.objectContaining({ id: target.id }));
    expect(reconciled.total).toBe(9);
    expect(reconciled.facets?.byStatus.working).toBe(9);
    expect(reconciled.facets?.byProvider["demo-alpha"]).toBe(9);
  });

  it("prioritizes blocked and error agents without provider-specific rules", () => {
    const snapshot = createLargeDemoSnapshot(12);
    expect(findAttentionAgent(snapshot.agents)?.status).toBe("blocked");
  });
});
