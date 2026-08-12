import { useCallback, useEffect, useState } from "react";
import type { RepositoryContextSource } from "../repositories/context-source.js";
import type {
  RelatedPullRequest,
  RepositoryAssociation,
  SourceControlIssue,
  SourceControlRepository,
} from "../repositories/domain.js";
import type { SourceControlClient } from "../repositories/source-control.js";
import { SourceControlError, toSourceControlError } from "../repositories/source-control.js";
import { relatePullRequests, repositoryKey, uniqueRepositoryLocators } from "../repositories/use-cases.js";

const maximumRepositories = 8;
const maximumConcurrency = 3;
const maximumIssuePages = 8;
const maximumIssues = 6;
const maximumPullRequests = 8;

export interface RepositoryOverviewEntry {
  readonly repository: SourceControlRepository;
  readonly associations: readonly RepositoryAssociation[];
  readonly issues: readonly SourceControlIssue[];
  readonly pullRequests: readonly RelatedPullRequest[];
}

export interface RepositoryOverviewFailure {
  readonly repository: string;
  readonly code: string;
  readonly message: string;
  readonly retryAt?: string;
}

export type RepositoryOverviewState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly entries: readonly RepositoryOverviewEntry[]; readonly failures: readonly RepositoryOverviewFailure[]; readonly truncated: boolean }
  | { readonly status: "unsupported" | "unavailable"; readonly message: string; readonly retryable: boolean }
  | { readonly status: "error"; readonly code: string; readonly message: string; readonly retryAt?: string };

export function requiresRepositoryAuthentication(state: RepositoryOverviewState): boolean {
  return (state.status === "error" && state.code === "unauthorized")
    || (state.status === "ready" && state.failures.some((failure) => failure.code === "unauthorized"));
}

async function mapLimited<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function openIssues(
  sourceControl: SourceControlClient,
  locator: RepositoryAssociation["repository"],
  signal: AbortSignal,
): Promise<readonly SourceControlIssue[]> {
  const issues: SourceControlIssue[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maximumIssuePages && issues.length < maximumIssues; page += 1) {
    const result = await sourceControl.issues(
      locator,
      { states: ["open"], limit: maximumIssues, ...(cursor === undefined ? {} : { cursor }) },
      { signal },
    );
    issues.push(...result.items.slice(0, maximumIssues - issues.length));
    if (!result.nextCursor || visitedCursors.has(result.nextCursor)) break;
    visitedCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return issues;
}

export function useRepositoryOverview(
  agentId: string | undefined,
  contextSource: RepositoryContextSource | undefined,
  sourceControl: SourceControlClient | undefined,
): { readonly state: RepositoryOverviewState; refresh(): void } {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<RepositoryOverviewState>({ status: "idle" });

  useEffect(() => {
    if (!agentId || !contextSource) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void contextSource.forAgent(agentId, { signal: controller.signal })
      .then(async (context) => {
        if (controller.signal.aborted) return;
        if (context.state === "unsupported") {
          setState({ status: "unsupported", message: context.reason, retryable: false });
          return;
        }
        if (context.state === "unavailable") {
          setState({ status: "unavailable", message: context.reason, retryable: context.retryable });
          return;
        }
        if (!sourceControl) {
          setState({ status: "unavailable", message: "Source-control connection is not configured.", retryable: false });
          return;
        }
        const locators = uniqueRepositoryLocators(context.associations);
        const confirmedRepositories = new Set(context.associations
          .filter((association) => association.kind === "confirmed")
          .map((association) => repositoryKey(association.repository)));
        const prioritizedLocators = [...locators].sort((left, right) =>
          Number(!confirmedRepositories.has(repositoryKey(left))) - Number(!confirmedRepositories.has(repositoryKey(right))));
        const selected = prioritizedLocators.slice(0, maximumRepositories);
        const results = await mapLimited(selected, maximumConcurrency, async (locator) => {
          try {
            const associations = context.associations.filter((association) => repositoryKey(association.repository) === repositoryKey(locator));
            const explicitPullRequestNumbers = [...new Set(associations.flatMap((association) => association.kind === "confirmed" && association.pullRequest ? [association.pullRequest.number] : []))]
              .slice(0, maximumPullRequests);
            const [repository, issues, pullRequests, explicitPullRequests] = await Promise.all([
              sourceControl.repository(locator, { signal: controller.signal }),
              openIssues(sourceControl, locator, controller.signal),
              sourceControl.pullRequests(locator, { states: ["open"], limit: maximumPullRequests }, { signal: controller.signal }),
              mapLimited(explicitPullRequestNumbers, maximumConcurrency, async (number) => await sourceControl.pullRequest(locator, number, { signal: controller.signal })),
            ]);
            const combinedPullRequests = new Map(pullRequests.items.map((pullRequest) => [pullRequest.number, pullRequest]));
            for (const pullRequest of explicitPullRequests) combinedPullRequests.set(pullRequest.number, pullRequest);
            return {
              status: "ready" as const,
              entry: {
                repository,
                associations,
                issues,
                pullRequests: relatePullRequests(associations, locator, [...combinedPullRequests.values()]).slice(0, maximumPullRequests),
              },
            };
          } catch (failure) {
            const error = failure instanceof SourceControlError ? failure : toSourceControlError(failure);
            if (error.code === "aborted") throw error;
            return {
              status: "error" as const,
              error,
              failure: {
                repository: `${locator.host}/${locator.owner}/${locator.name}`,
                code: error.code,
                message: error.message,
                ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
              },
            };
          }
        });
        const entries = results.flatMap((result) => result.status === "ready" ? [result.entry] : []);
        const failures = results.flatMap((result) => result.status === "error" ? [result.failure] : []);
        if (!entries.length && failures.length) {
          const failed = results.find((result) => result.status === "error");
          if (failed?.status === "error") throw failed.error;
        }
        if (!controller.signal.aborted) setState({ status: "ready", entries, failures, truncated: locators.length > selected.length });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const error = failure instanceof SourceControlError
          ? failure
          : toSourceControlError(failure);
        setState({
          status: "error",
          code: error.code,
          message: error.message,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        });
      });
    return () => controller.abort(new DOMException("selection changed", "AbortError"));
  }, [agentId, contextSource, generation, sourceControl]);

  return { state, refresh: useCallback(() => setGeneration((current) => current + 1), []) };
}
