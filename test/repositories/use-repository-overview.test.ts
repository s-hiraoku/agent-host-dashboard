import { describe, expect, it } from "vitest";
import { requiresRepositoryAuthentication } from "../../src/dashboard/use-repository-overview.js";

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
});
