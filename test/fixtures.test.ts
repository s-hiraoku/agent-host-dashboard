import { describe, expect, it } from "vitest";
import { createLargeDemoSnapshot, demoAgents } from "../src/testing/fixtures.js";

describe("sanitized fixtures", () => {
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
});
