import type {
  RepositoryLocator,
  SourceControlIssue,
  SourceControlPullRequest,
  SourceControlRepository,
} from "./domain.js";

export const sourceControlErrorCodes = [
  "aborted",
  "forbidden",
  "invalid_response",
  "not_found",
  "rate_limited",
  "timeout",
  "unauthorized",
  "unavailable",
  "unsupported_host",
  "unknown",
] as const;

export type SourceControlErrorCode = (typeof sourceControlErrorCodes)[number];

export interface SourceControlErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly requestId?: string;
  readonly retryAt?: string;
  readonly cause?: unknown;
}

export class SourceControlError extends Error {
  readonly code: SourceControlErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly retryAt: string | undefined;

  constructor(code: SourceControlErrorCode, message: string, options: SourceControlErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "SourceControlError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.retryAt = options.retryAt;
  }
}

export function toSourceControlError(error: unknown): SourceControlError {
  if (error instanceof SourceControlError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new SourceControlError("aborted", "The source-control request was cancelled.", { cause: error });
  }
  return new SourceControlError("unknown", error instanceof Error ? error.message : "An unknown source-control error occurred.", {
    cause: error,
  });
}

export interface SourceControlRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SourceControlPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
  readonly query?: string;
}

export interface IssuePageRequest extends SourceControlPageRequest {
  readonly states?: readonly ("open" | "closed")[];
}

export interface PullRequestPageRequest extends SourceControlPageRequest {
  readonly states?: readonly ("open" | "closed" | "merged")[];
  readonly draft?: boolean;
}

export interface SourceControlRateLimit {
  readonly remaining: number;
  readonly limit: number;
  readonly resetsAt: string;
}

export interface SourceControlPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly totalCount?: number;
  readonly rateLimit?: SourceControlRateLimit;
}

export interface SourceControlClient {
  repository(locator: RepositoryLocator, options?: SourceControlRequestOptions): Promise<SourceControlRepository>;
  issues(
    locator: RepositoryLocator,
    request?: IssuePageRequest,
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlIssue>>;
  pullRequests(
    locator: RepositoryLocator,
    request?: PullRequestPageRequest,
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlPullRequest>>;
}
