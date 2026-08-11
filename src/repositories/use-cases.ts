import type {
  PullRequestRelationship,
  RelatedPullRequest,
  RepositoryAssociation,
  RepositoryLocator,
  SourceControlPullRequest,
} from "./domain.js";
import type { SourceControlPageRequest } from "./source-control.js";

const maximumPageSize = 100;
const maximumQueryLength = 256;
const maximumCursorLength = 1_024;

function requiredSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || /[\\/?#]/u.test(normalized)) {
    throw new TypeError(`${label} must be one repository locator segment.`);
  }
  return normalized;
}

export function normalizeRepositoryLocator(locator: RepositoryLocator): RepositoryLocator {
  const host = requiredSegment(locator.host, "host").toLocaleLowerCase();
  const owner = requiredSegment(locator.owner, "owner");
  const name = requiredSegment(locator.name, "name").replace(/\.git$/iu, "");
  if (!name) throw new TypeError("name must be one repository locator segment.");
  return {
    service: "github",
    host,
    owner,
    name,
    ...(locator.repositoryId === undefined ? {} : { repositoryId: requiredSegment(locator.repositoryId, "repositoryId") }),
  };
}

export function repositoryKey(locator: RepositoryLocator): string {
  const normalized = normalizeRepositoryLocator(locator);
  const identity = normalized.repositoryId === undefined
    ? ["path", normalized.owner, normalized.name]
    : ["id", normalized.repositoryId];
  return [normalized.service, normalized.host, ...identity]
    .map((segment) => segment.toLocaleLowerCase())
    .join(":");
}

export function boundedSourceControlRequest<T extends SourceControlPageRequest>(request: T): T {
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > maximumPageSize)) {
    throw new RangeError(`limit must be an integer from 1 to ${maximumPageSize}.`);
  }
  if (request.cursor !== undefined && request.cursor.length > maximumCursorLength) {
    throw new RangeError(`cursor must not exceed ${maximumCursorLength} characters.`);
  }
  if (request.query !== undefined && request.query.length > maximumQueryLength) {
    throw new RangeError(`query must not exceed ${maximumQueryLength} characters.`);
  }
  return request;
}

export function uniqueRepositoryLocators(associations: readonly RepositoryAssociation[]): readonly RepositoryLocator[] {
  const repositories = new Map<string, RepositoryLocator>();
  for (const association of associations) {
    const normalized = normalizeRepositoryLocator(association.repository);
    repositories.set(repositoryKey(normalized), normalized);
  }
  return [...repositories.values()];
}

function sameRepository(left: RepositoryLocator, right: RepositoryLocator): boolean {
  return repositoryKey(left) === repositoryKey(right);
}

export function pullRequestRelationship(
  associations: readonly RepositoryAssociation[],
  repository: RepositoryLocator,
  pullRequest: SourceControlPullRequest,
): PullRequestRelationship {
  for (const association of associations) {
    if (!sameRepository(association.repository, repository)) continue;
    if (association.kind === "confirmed" && association.pullRequest?.number === pullRequest.number) return "associated";
  }
  for (const association of associations) {
    if (!sameRepository(association.repository, repository)) continue;
    const branch = association.checkout?.branch;
    if (association.kind === "candidate" && association.reason === "repository_match") return "candidate";
    if (association.kind === "candidate" && association.reason === "branch_match" && branch === pullRequest.head.branch) {
      return "candidate";
    }
    if (branch && branch === pullRequest.head.branch) return "candidate";
  }
  return "repository_wide";
}

export function relatePullRequests(
  associations: readonly RepositoryAssociation[],
  repository: RepositoryLocator,
  pullRequests: readonly SourceControlPullRequest[],
): readonly RelatedPullRequest[] {
  const priority: Record<PullRequestRelationship, number> = { associated: 0, candidate: 1, repository_wide: 2 };
  return pullRequests
    .map((pullRequest) => ({
      pullRequest,
      relationship: pullRequestRelationship(associations, repository, pullRequest),
    }))
    .sort((left, right) => priority[left.relationship] - priority[right.relationship]
      || Date.parse(right.pullRequest.updatedAt) - Date.parse(left.pullRequest.updatedAt)
      || right.pullRequest.number - left.pullRequest.number);
}
