import { describe, expect, it } from "vitest";
import {
  demoIssues,
  demoPullRequests,
  demoRepository,
  demoRepositoryAssociations,
} from "../../src/testing/repositories/fixtures.js";

describe("repository fixture privacy", () => {
  it("contains only explicit sanitized identities and no credential-shaped fields", () => {
    const fixture = JSON.stringify({ demoRepository, demoRepositoryAssociations, demoIssues, demoPullRequests });

    expect(fixture).toContain("example-labs");
    expect(fixture).toContain("sanitized-fixture");
    expect(fixture).not.toMatch(/token|authorization|bearer|password|secret|\/Users\/|\/home\//iu);
  });
});
