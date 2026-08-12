import type { RequestOptions } from "../../transport.js";
import type { RepositoryContextSource } from "../../repositories/context-source.js";
import type { RepositoryContextResult, RepositoryLocator } from "../../repositories/domain.js";
import { boundedSourceControlRequest, repositoryKey } from "../../repositories/use-cases.js";
import type {
  IssuePageRequest,
  PullRequestPageRequest,
  SourceControlClient,
  SourceControlPage,
  SourceControlRequestOptions,
} from "../../repositories/source-control.js";
import { SourceControlError } from "../../repositories/source-control.js";
import type { SourceControlIssue, SourceControlPullRequest, SourceControlRepository } from "../../repositories/domain.js";
import { demoIssues, demoPullRequests, demoRepository, demoRepositoryAssociations } from "./fixtures.js";

function ensureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SourceControlError("aborted", "The source-control request was cancelled.", { cause: signal.reason });
}

function page<T>(items: readonly T[], cursor: string | undefined, limit = 20): SourceControlPage<T> {
  const offset = Number.parseInt(cursor ?? "0", 10);
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    totalCount: items.length,
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
    rateLimit: { remaining: 4_999, limit: 5_000, resetsAt: "2026-01-15T10:00:00.000Z" },
  };
}

export class MockRepositoryContextSource implements RepositoryContextSource {
  result: RepositoryContextResult = { state: "ready", associations: demoRepositoryAssociations, revision: 40 };

  async forAgent(agentId: string, options?: RequestOptions): Promise<RepositoryContextResult> {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (this.result.state !== "ready") return this.result;
    return {
      ...this.result,
      associations: this.result.associations.filter((association) => association.agentId === agentId),
    };
  }
}

export class MockSourceControlClient implements SourceControlClient {
  readonly repositories = new Map([[repositoryKey(demoRepository.locator), demoRepository]]);
  readonly issuesByRepository = new Map([[repositoryKey(demoRepository.locator), demoIssues]]);
  readonly pullRequestsByRepository = new Map([[repositoryKey(demoRepository.locator), demoPullRequests]]);

  async repository(locator: RepositoryLocator, options?: SourceControlRequestOptions): Promise<SourceControlRepository> {
    ensureActive(options?.signal);
    const repository = this.repositories.get(repositoryKey(locator));
    if (!repository) throw new SourceControlError("not_found", "The sanitized repository was not found.", { status: 404 });
    return repository;
  }

  async pullRequest(locator: RepositoryLocator, number: number, options?: SourceControlRequestOptions): Promise<SourceControlPullRequest> {
    ensureActive(options?.signal);
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("pull request number must be a positive integer.");
    const pullRequest = this.pullRequestsByRepository.get(repositoryKey(locator))?.find((item) => item.number === number);
    if (!pullRequest) throw new SourceControlError("not_found", "The sanitized pull request was not found.", { status: 404 });
    return pullRequest;
  }

  async issues(
    locator: RepositoryLocator,
    request: IssuePageRequest = {},
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlIssue>> {
    ensureActive(options?.signal);
    boundedSourceControlRequest(request);
    const all = this.issuesByRepository.get(repositoryKey(locator));
    if (!all) throw new SourceControlError("not_found", "The sanitized repository was not found.", { status: 404 });
    const query = request.query?.toLowerCase();
    const filtered = all
      .filter((issue) => !request.states || request.states.includes(issue.state))
      .filter((issue) => !query || issue.title.toLowerCase().includes(query));
    return page(filtered, request.cursor, request.limit);
  }

  async pullRequests(
    locator: RepositoryLocator,
    request: PullRequestPageRequest = {},
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlPullRequest>> {
    ensureActive(options?.signal);
    boundedSourceControlRequest(request);
    const all = this.pullRequestsByRepository.get(repositoryKey(locator));
    if (!all) throw new SourceControlError("not_found", "The sanitized repository was not found.", { status: 404 });
    const query = request.query?.toLowerCase();
    const filtered = all
      .filter((pullRequest) => !request.states || request.states.includes(pullRequest.state))
      .filter((pullRequest) => request.draft === undefined || pullRequest.draft === request.draft)
      .filter((pullRequest) => !query || pullRequest.title.toLowerCase().includes(query));
    return page(filtered, request.cursor, request.limit);
  }
}
