import { describe, expect, it } from "vitest";
import {
  applyVisibleEvent,
  findAttentionAgent,
  providerMetrics,
  reconcileVisibleEvents,
  statusMetrics,
  formatActivity,
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

  it("invalidates aggregate facets when an off-page event cannot be reconciled safely", () => {
    const snapshot = {
      ...createLargeDemoSnapshot(100),
      agents: createLargeDemoSnapshot(100).agents.slice(0, 50),
      facets: { byStatus: { working: 100 }, byProvider: { "demo-alpha": 100 } },
    };
    const updated = applyVisibleEvent(snapshot, {
      type: "agent.upserted",
      revision: 41,
      agent: { ...createLargeDemoSnapshot(100).agents[60]!, status: "blocked" },
    });

    expect(updated.facets).toBeUndefined();
    expect(updated.agents).toEqual(snapshot.agents);
    expect(updated.revision).toBe(41);
  });

  it("decrements total while invalidating facets for an off-page removal", () => {
    const snapshot = {
      ...createLargeDemoSnapshot(100),
      agents: createLargeDemoSnapshot(100).agents.slice(0, 50),
      facets: { byStatus: { working: 100 }, byProvider: { "demo-alpha": 100 } },
    };

    const updated = applyVisibleEvent(snapshot, {
      type: "agent.removed",
      revision: 41,
      agentId: snapshot.agents[60]?.id ?? "demo:off-page",
    });

    expect(updated.total).toBe(99);
    expect(updated.facets).toBeUndefined();
  });

  it("formats valid activity and handles invalid timestamps safely", () => {
    const now = Date.parse("2026-01-15T10:00:00.000Z");
    expect(formatActivity("2026-01-15T09:59:30.000Z", now)).toBe("30s ago");
    expect(formatActivity("not-a-date", now)).toBe("No activity");
    expect(formatActivity(undefined, now)).toBe("No activity");
  });

  it("prioritizes blocked and error agents without provider-specific rules", () => {
    const snapshot = createLargeDemoSnapshot(12);
    expect(findAttentionAgent(snapshot.agents)?.status).toBe("blocked");
  });
});
