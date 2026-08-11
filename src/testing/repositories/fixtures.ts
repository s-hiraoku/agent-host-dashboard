import type {
  RepositoryAssociation,
  SourceControlIssue,
  SourceControlPullRequest,
  SourceControlRepository,
} from "../../repositories/domain.js";

export const demoRepository: SourceControlRepository = {
  locator: { service: "github", host: "github.com", owner: "example-labs", name: "orbit" },
  url: "https://github.com/example-labs/orbit",
  visibility: "public",
  defaultBranch: "main",
};

export const demoRepositoryAssociations: readonly RepositoryAssociation[] = [
  {
    kind: "confirmed",
    agentId: "demo:orbit-review",
    repository: demoRepository.locator,
    provenance: { source: "sanitized-fixture", confidence: "high" },
    checkout: { branch: "fix/parser-boundary", worktree: "/workspace/orbit" },
    pullRequest: { number: 42 },
  },
  {
    kind: "confirmed",
    agentId: "demo:agent-0002",
    repository: demoRepository.locator,
    provenance: { source: "sanitized-fixture", confidence: "high" },
    checkout: { branch: "fix/parser-boundary", worktree: "/workspace/project-1" },
    pullRequest: { number: 42 },
  },
  {
    kind: "candidate",
    agentId: "demo:orbit-candidate",
    repository: demoRepository.locator,
    provenance: { source: "sanitized-fixture", confidence: "medium" },
    reason: "branch_match",
    checkout: { branch: "investigate/cache" },
  },
];

export const demoIssues: readonly SourceControlIssue[] = [
  {
    id: "fixture-issue-17",
    number: 17,
    title: "Clarify bounded parser behavior",
    state: "open",
    url: "https://github.com/example-labs/orbit/issues/17",
    updatedAt: "2026-01-15T09:15:00.000Z",
    labels: ["contract"],
  },
  {
    id: "fixture-issue-9",
    number: 9,
    title: "Document fixture privacy rules",
    state: "closed",
    url: "https://github.com/example-labs/orbit/issues/9",
    updatedAt: "2026-01-14T18:00:00.000Z",
    labels: ["documentation"],
  },
];

export const demoPullRequests: readonly SourceControlPullRequest[] = [
  {
    id: "fixture-pr-42",
    number: 42,
    title: "Harden parser boundary",
    state: "open",
    draft: false,
    url: "https://github.com/example-labs/orbit/pull/42",
    updatedAt: "2026-01-15T09:25:00.000Z",
    head: { owner: "example-labs", branch: "fix/parser-boundary" },
    checks: "passing",
    review: "approved",
  },
  {
    id: "fixture-pr-41",
    number: 41,
    title: "Investigate cache lifecycle",
    state: "open",
    draft: true,
    url: "https://github.com/example-labs/orbit/pull/41",
    updatedAt: "2026-01-15T09:20:00.000Z",
    head: { owner: "example-labs", branch: "investigate/cache" },
    checks: "pending",
    review: "pending",
  },
  {
    id: "fixture-pr-38",
    number: 38,
    title: "Refresh contributor guide",
    state: "merged",
    draft: false,
    url: "https://github.com/example-labs/orbit/pull/38",
    updatedAt: "2026-01-14T10:00:00.000Z",
    head: { owner: "example-labs", branch: "docs/contributing" },
    checks: "passing",
    review: "approved",
  },
];
