import { describe, expect, it } from "vitest";
import { createRequestLimiter, requiresRepositoryAuthentication } from "../../src/dashboard/use-repository-overview.js";

describe("repository overview authentication", () => {
  it("requires recovery when a partial repository result is unauthorized", () => {
    expect(requiresRepositoryAuthentication({
      status: "ready",
      entries: [],
      failures: [
        { repository: "github.com/example-labs/denied", code: "unauthorized", message: "Rejected test credential." },
      ],
      truncated: false,
    })).toBe(true);
  });

  it("bounds all work routed through one request limiter", async () => {
    const request = createRequestLimiter(3);
    let active = 0;
    let maximumActive = 0;

    await Promise.all(Array.from({ length: 12 }, (_, index) => request(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    })));

    expect(maximumActive).toBe(3);
  });
});
