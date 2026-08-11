import { describe, expect, it } from "vitest";
import {
  boundedSourceControlRequest,
  normalizeRepositoryLocator,
  pullRequestRelationship,
  relatePullRequests,
  repositoryKey,
  uniqueRepositoryLocators,
} from "../../src/repositories/use-cases.js";
import { demoPullRequests, demoRepository, demoRepositoryAssociations } from "../../src/testing/repositories/fixtures.js";

const { repositoryId: _repositoryId, ...demoRepositoryWithoutId } = demoRepository.locator;

describe("repository use cases", () => {
  it("normalizes structured locators without parsing repository URLs", () => {
    const locator = normalizeRepositoryLocator({
      service: "github",
      host: " GitHub.COM ",
      owner: "Example-Labs",
      name: "orbit.git",
    });

    expect(locator).toEqual({ service: "github", host: "github.com", owner: "Example-Labs", name: "orbit" });
    expect(repositoryKey(locator)).toBe("github:github.com:example-labs:orbit");
    expect(() => normalizeRepositoryLocator({ service: "github", host: "github.com", owner: "../private", name: "orbit" }))
      .toThrow(/one repository locator segment/);
    expect(repositoryKey({ ...locator, repositoryId: "R_demo_1" }))
      .toBe("github:github.com:example-labs:orbit");
    expect(repositoryKey({ ...locator, host: "GITHUB.COM", owner: "IDENTITY" }))
      .toBe("github:github.com:identity:orbit");
  });

  it("enforces bounded pagination and search inputs", () => {
    expect(boundedSourceControlRequest({ limit: 50, query: "parser" })).toEqual({ limit: 50, query: "parser" });
    expect(() => boundedSourceControlRequest({ limit: 101 })).toThrow(/1 to 100/);
    expect(() => boundedSourceControlRequest({ query: "x".repeat(257) })).toThrow(/256/);
    expect(() => boundedSourceControlRequest({ cursor: "x".repeat(1_025) })).toThrow(/1024/);
  });

  it("deduplicates repository work before source-control queries", () => {
    expect(uniqueRepositoryLocators(demoRepositoryAssociations)).toEqual([demoRepository.locator]);
    const withoutIdLast = uniqueRepositoryLocators([
      demoRepositoryAssociations[0]!,
      { ...demoRepositoryAssociations[0]!, repository: demoRepositoryWithoutId },
    ]);
    const withoutIdFirst = uniqueRepositoryLocators([
      { ...demoRepositoryAssociations[0]!, repository: demoRepositoryWithoutId },
      demoRepositoryAssociations[0]!,
    ]);
    expect(withoutIdLast).toEqual([demoRepository.locator]);
    expect(withoutIdFirst).toEqual([demoRepository.locator]);
  });

  it("never presents repository or branch inference as a confirmed PR association", () => {
    const confirmed = demoPullRequests.find((pullRequest) => pullRequest.number === 42)!;
    const branchCandidate = demoPullRequests.find((pullRequest) => pullRequest.number === 41)!;
    const repositoryWide = demoPullRequests.find((pullRequest) => pullRequest.number === 38)!;

    expect(pullRequestRelationship(demoRepositoryAssociations, demoRepository.locator, confirmed)).toBe("associated");
    expect(pullRequestRelationship(demoRepositoryAssociations, demoRepository.locator, branchCandidate)).toBe("candidate");
    expect(pullRequestRelationship(demoRepositoryAssociations, demoRepository.locator, {
      ...branchCandidate,
      head: { owner: "another-contributor", branch: branchCandidate.head.branch },
    })).toBe("repository_wide");
    expect(pullRequestRelationship(demoRepositoryAssociations, demoRepository.locator, repositoryWide)).toBe("repository_wide");
    expect(pullRequestRelationship(demoRepositoryAssociations, demoRepositoryWithoutId, confirmed)).toBe("associated");
    expect(pullRequestRelationship([
      { ...demoRepositoryAssociations[1]!, repository: { ...demoRepository.locator, owner: " Example-Labs " } },
    ], demoRepository.locator, { ...branchCandidate, head: { ...branchCandidate.head, owner: "example-labs" } })).toBe("candidate");

    const confirmedOnly = demoRepositoryAssociations.filter((association) => association.kind === "confirmed");
    expect(pullRequestRelationship(confirmedOnly, demoRepository.locator, repositoryWide)).toBe("repository_wide");
  });

  it("orders confirmed, candidate, and repository-wide PRs explicitly", () => {
    const related = relatePullRequests(
      demoRepositoryAssociations.filter((association) => association.agentId === "demo:orbit-review"),
      demoRepository.locator,
      demoPullRequests,
    );

    expect(related.map((item) => [item.pullRequest.number, item.relationship])).toEqual([
      [42, "associated"],
      [41, "repository_wide"],
      [38, "repository_wide"],
    ]);
  });
});
