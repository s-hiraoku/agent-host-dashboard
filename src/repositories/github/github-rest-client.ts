import type {
  RepositoryLocator,
  SourceControlIssue,
  SourceControlPullRequest,
  SourceControlRepository,
} from "../domain.js";
import {
  SourceControlError,
  type IssuePageRequest,
  type PullRequestPageRequest,
  type SourceControlClient,
  type SourceControlPage,
  type SourceControlRateLimit,
  type SourceControlRequestOptions,
} from "../source-control.js";
import { boundedSourceControlRequest, normalizeRepositoryLocator } from "../use-cases.js";

const defaultApiVersion = "2026-03-10";

export interface GitHubCredential {
  readonly scheme: "Bearer";
  readonly token: string;
}

export interface GitHubApiEndpoint {
  readonly host: string;
  readonly baseUrl: string;
}

export interface GitHubRestClientOptions {
  readonly authentication?: (host: string) => GitHubCredential | undefined;
  readonly endpoints?: readonly GitHubApiEndpoint[];
  readonly fetch?: typeof fetch;
  readonly apiVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly data: unknown;
  readonly etag?: string;
  readonly expiresAt: number;
  readonly headers: Headers;
}

interface GitHubResponse<T> {
  readonly data: T;
  readonly headers: Headers;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceControlError("invalid_response", "GitHub returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") throw new SourceControlError("invalid_response", `GitHub omitted ${field}.`);
  return value;
}

function numberField(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SourceControlError("invalid_response", `GitHub omitted ${field}.`);
  }
  return value;
}

function booleanField(input: Record<string, unknown>, field: string): boolean {
  const value = input[field];
  if (typeof value !== "boolean") throw new SourceControlError("invalid_response", `GitHub omitted ${field}.`);
  return value;
}

function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9]\d{0,8}$/u.test(cursor)) throw new SourceControlError("invalid_response", "The GitHub page cursor is invalid.");
  return Number(cursor);
}

function queryState(states: readonly string[] | undefined): string {
  if (!states || states.length !== 1) return "all";
  return states[0] === "merged" ? "closed" : states[0]!;
}

function rateLimit(headers: Headers): SourceControlRateLimit | undefined {
  const remainingHeader = headers.get("x-ratelimit-remaining");
  const limitHeader = headers.get("x-ratelimit-limit");
  const resetHeader = headers.get("x-ratelimit-reset");
  if (remainingHeader === null || limitHeader === null || resetHeader === null) return undefined;
  const remaining = Number(remainingHeader);
  const limit = Number(limitHeader);
  const reset = Number(resetHeader);
  if (![remaining, limit, reset].every(Number.isFinite)) return undefined;
  return { remaining, limit, resetsAt: new Date(reset * 1_000).toISOString() };
}

function nextPageCursor(headers: Headers): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    if (!/;\s*rel="next"\s*$/u.test(entry.trim())) continue;
    const target = entry.match(/^\s*<([^>]+)>/u)?.[1];
    if (!target) return undefined;
    try {
      const page = new URL(target).searchParams.get("page") ?? undefined;
      return page === undefined ? undefined : String(pageNumber(page));
    } catch (cause) {
      if (cause instanceof SourceControlError) throw cause;
      throw new SourceControlError("invalid_response", "GitHub returned an invalid pagination link.", { cause });
    }
  }
  return undefined;
}

function retryAt(headers: Headers, now: number): string | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return new Date(now + Math.max(0, seconds) * 1_000).toISOString();
    const parsed = Date.parse(retryAfter);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const resetHeader = headers.get("x-ratelimit-reset");
  if (resetHeader === null) return undefined;
  const reset = Number(resetHeader);
  return Number.isFinite(reset) ? new Date(reset * 1_000).toISOString() : undefined;
}

function errorForResponse(response: Response, now: number): SourceControlError {
  const requestId = response.headers.get("x-github-request-id") ?? undefined;
  const common = {
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
  };
  if (response.status === 401) return new SourceControlError("unauthorized", "GitHub authentication failed.", common);
  if (response.status === 404) return new SourceControlError("not_found", "The GitHub resource was not found.", common);
  if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) {
    const availableAt = retryAt(response.headers, now);
    return new SourceControlError("rate_limited", "GitHub rate limit reached.", {
      ...common,
      retryable: true,
      ...(availableAt === undefined ? {} : { retryAt: availableAt }),
    });
  }
  if (response.status === 403) return new SourceControlError("forbidden", "GitHub denied access to this resource.", common);
  if (response.status >= 500) {
    return new SourceControlError("unavailable", "GitHub is temporarily unavailable.", { ...common, retryable: true });
  }
  return new SourceControlError("invalid_response", `GitHub request failed with status ${response.status}.`, common);
}

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new DOMException("cancelled", "AbortError"));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new SourceControlError("timeout", `GitHub exceeded the ${timeoutMs} ms timeout.`, { retryable: true }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function credentialScope(token: string | undefined): Promise<string> {
  if (!token) return "anonymous";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `authenticated:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function endpointUrl(endpoint: GitHubApiEndpoint): URL {
  const host = normalizeRepositoryLocator({ service: "github", host: endpoint.host, owner: "owner", name: "repo" }).host;
  const url = new URL(endpoint.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`GitHub API endpoint for ${host} must be credential-free HTTPS.`);
  }
  return url;
}

function pathFor(locator: RepositoryLocator, suffix = ""): string {
  const normalized = normalizeRepositoryLocator(locator);
  return `/repos/${encodeURIComponent(normalized.owner)}/${encodeURIComponent(normalized.name)}${suffix}`;
}

function decodeRepository(locator: RepositoryLocator, value: unknown): SourceControlRepository {
  const input = record(value);
  const visibility = input.visibility;
  return {
    locator: {
      ...normalizeRepositoryLocator(locator),
      repositoryId: String(numberField(input, "id")),
    },
    url: stringField(input, "html_url"),
    visibility: visibility === "public" || visibility === "private" || visibility === "internal" ? visibility : "unknown",
    ...(typeof input.default_branch === "string" ? { defaultBranch: input.default_branch } : {}),
  };
}

function decodeIssue(value: unknown): SourceControlIssue | undefined {
  const input = record(value);
  if (input.pull_request !== undefined) return undefined;
  const state = stringField(input, "state");
  if (state !== "open" && state !== "closed") throw new SourceControlError("invalid_response", "GitHub returned an invalid Issue state.");
  const labels = Array.isArray(input.labels)
    ? input.labels.flatMap((label) => {
        if (typeof label === "string") return [label];
        if (!label || typeof label !== "object" || Array.isArray(label)) return [];
        const name = (label as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return {
    id: String(numberField(input, "id")),
    number: numberField(input, "number"),
    title: stringField(input, "title"),
    state,
    url: stringField(input, "html_url"),
    updatedAt: stringField(input, "updated_at"),
    labels,
  };
}

function decodePullRequest(value: unknown): SourceControlPullRequest {
  const input = record(value);
  const stateValue = stringField(input, "state");
  const merged = typeof input.merged_at === "string";
  const state = merged ? "merged" : stateValue;
  if (state !== "open" && state !== "closed" && state !== "merged") {
    throw new SourceControlError("invalid_response", "GitHub returned an invalid pull-request state.");
  }
  const head = record(input.head);
  const headUser = head.user && typeof head.user === "object" ? record(head.user) : undefined;
  return {
    id: String(numberField(input, "id")),
    number: numberField(input, "number"),
    title: stringField(input, "title"),
    state,
    draft: booleanField(input, "draft"),
    url: stringField(input, "html_url"),
    updatedAt: stringField(input, "updated_at"),
    head: {
      branch: stringField(head, "ref"),
      ...(headUser && typeof headUser.login === "string" ? { owner: headUser.login } : {}),
    },
    checks: "unknown",
    review: "unknown",
  };
}

export class GitHubRestClient implements SourceControlClient {
  private readonly authentication: ((host: string) => GitHubCredential | undefined) | undefined;
  private readonly fetcher: typeof fetch;
  private readonly apiVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly now: () => number;
  private readonly endpoints = new Map<string, URL>();
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: GitHubRestClientOptions = {}) {
    if (!Number.isFinite(options.requestTimeoutMs ?? 10_000) || (options.requestTimeoutMs ?? 10_000) <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive finite number.");
    }
    if (!Number.isFinite(options.cacheTtlMs ?? 15_000) || (options.cacheTtlMs ?? 15_000) < 0) {
      throw new RangeError("cacheTtlMs must be a non-negative finite number.");
    }
    if (!Number.isSafeInteger(options.cacheMaxEntries ?? 200) || (options.cacheMaxEntries ?? 200) < 1) {
      throw new RangeError("cacheMaxEntries must be a positive safe integer.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.apiVersion ?? defaultApiVersion)) {
      throw new TypeError("apiVersion must be a date-versioned GitHub REST API identifier.");
    }
    this.authentication = options.authentication;
    this.fetcher = options.fetch ?? fetch;
    this.apiVersion = options.apiVersion ?? defaultApiVersion;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 15_000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 200;
    this.now = options.now ?? Date.now;
    for (const endpoint of options.endpoints ?? [{ host: "github.com", baseUrl: "https://api.github.com" }]) {
      const url = endpointUrl(endpoint);
      const host = normalizeRepositoryLocator({ service: "github", host: endpoint.host, owner: "owner", name: "repo" }).host;
      this.endpoints.set(host, url);
    }
    if (this.endpoints.size === 0) throw new TypeError("At least one GitHub API endpoint must be configured.");
  }

  private endpoint(locator: RepositoryLocator): URL {
    const normalized = normalizeRepositoryLocator(locator);
    const endpoint = this.endpoints.get(normalized.host);
    if (!endpoint) throw new SourceControlError("unsupported_host", `GitHub host ${normalized.host} is not configured.`);
    return endpoint;
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async get<T>(locator: RepositoryLocator, path: string, options?: SourceControlRequestOptions): Promise<GitHubResponse<T>> {
    const normalized = normalizeRepositoryLocator(locator);
    const endpoint = this.endpoint(normalized);
    if (options?.signal?.aborted) {
      throw new SourceControlError("aborted", "The GitHub request was cancelled.", { cause: options.signal.reason });
    }
    const initialUrl = new URL(endpoint);
    const queryStart = path.indexOf("?");
    const requestPath = queryStart === -1 ? path : path.slice(0, queryStart);
    initialUrl.pathname = `${endpoint.pathname.replace(/\/$/u, "")}${requestPath}`;
    initialUrl.search = queryStart === -1 ? "" : path.slice(queryStart + 1);
    let credential: GitHubCredential | undefined;
    let key: string;
    try {
      credential = this.authentication?.(normalized.host);
      const scope = await credentialScope(credential?.token.trim() || undefined);
      if (options?.signal?.aborted) {
        throw new SourceControlError("aborted", "The GitHub request was cancelled.", { cause: options.signal.reason });
      }
      key = `${scope}\n${initialUrl.toString()}`;
    } catch (cause) {
      if (cause instanceof SourceControlError) throw cause;
      throw new SourceControlError("unavailable", "GitHub credentials are unavailable.", { cause });
    }
    const token = credential?.token.trim() || undefined;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return { data: cached.data as T, headers: new Headers(cached.headers) };
    }
    const deadline = createDeadline(options?.signal, this.requestTimeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": this.apiVersion,
      });
      if (credential && token) headers.set("Authorization", `${credential.scheme} ${token}`);
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(deadline.signal.reason);
        deadline.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const fetchRequest = this.fetcher(initialUrl, { method: "GET", headers, signal: deadline.signal, redirect: "follow" });
      const response = await Promise.race([fetchRequest, aborted]);
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== endpoint.origin) {
          throw new SourceControlError("invalid_response", "GitHub attempted a cross-origin redirect.");
        }
      }
      if (response.status === 304 && cached) {
        const responseHeaders = new Headers(cached.headers);
        response.headers.forEach((value, name) => responseHeaders.set(name, value));
        this.remember(key, { ...cached, headers: responseHeaders, expiresAt: this.now() + this.cacheTtlMs });
        return { data: cached.data as T, headers: new Headers(responseHeaders) };
      }
      if (!response.ok) throw errorForResponse(response, this.now());
      let data: unknown;
      try {
        data = await Promise.race([response.json(), aborted]);
      } catch (cause) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw new SourceControlError("invalid_response", "GitHub returned invalid JSON.", { cause });
      }
      const etag = response.headers.get("etag") ?? undefined;
      this.remember(key, {
        data,
        headers: new Headers(response.headers),
        expiresAt: this.now() + this.cacheTtlMs,
        ...(etag === undefined ? {} : { etag }),
      });
      return { data: data as T, headers: response.headers };
    } catch (error) {
      if (error instanceof SourceControlError) throw error;
      if (deadline.signal.aborted) {
        if (deadline.signal.reason instanceof SourceControlError) throw deadline.signal.reason;
        throw new SourceControlError("aborted", "The GitHub request was cancelled.", { cause: deadline.signal.reason });
      }
      throw new SourceControlError("unavailable", "GitHub could not be reached.", { retryable: true, cause: error });
    } finally {
      if (rejectAbort) deadline.signal.removeEventListener("abort", rejectAbort);
      deadline.dispose();
    }
  }

  async repository(locator: RepositoryLocator, options?: SourceControlRequestOptions): Promise<SourceControlRepository> {
    const response = await this.get<unknown>(locator, pathFor(locator), options);
    return decodeRepository(locator, response.data);
  }

  async pullRequest(locator: RepositoryLocator, number: number, options?: SourceControlRequestOptions): Promise<SourceControlPullRequest> {
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("pull request number must be a positive integer.");
    const response = await this.get<unknown>(locator, pathFor(locator, `/pulls/${number}`), options);
    return decodePullRequest(response.data);
  }

  async issues(
    locator: RepositoryLocator,
    request: IssuePageRequest = {},
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlIssue>> {
    boundedSourceControlRequest(request);
    const limit = request.limit ?? 30;
    const page = pageNumber(request.cursor);
    const params = new URLSearchParams({ state: queryState(request.states), per_page: String(limit), page: String(page), sort: "updated", direction: "desc" });
    const response = await this.get<unknown[]>(locator, `${pathFor(locator, "/issues")}?${params}`, options);
    if (!Array.isArray(response.data)) throw new SourceControlError("invalid_response", "GitHub returned an invalid Issue page.");
    const query = request.query?.toLocaleLowerCase();
    const decoded = response.data
      .map(decodeIssue)
      .filter((issue): issue is SourceControlIssue => issue !== undefined)
      .filter((issue) => !request.states || request.states.includes(issue.state))
      .filter((issue) => !query || issue.title.toLocaleLowerCase().includes(query));
    const observedRateLimit = rateLimit(response.headers);
    const nextCursor = nextPageCursor(response.headers);
    return {
      items: decoded,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(observedRateLimit === undefined ? {} : { rateLimit: observedRateLimit }),
    };
  }

  async pullRequests(
    locator: RepositoryLocator,
    request: PullRequestPageRequest = {},
    options?: SourceControlRequestOptions,
  ): Promise<SourceControlPage<SourceControlPullRequest>> {
    boundedSourceControlRequest(request);
    const limit = request.limit ?? 30;
    const page = pageNumber(request.cursor);
    const params = new URLSearchParams({ state: queryState(request.states), per_page: String(limit), page: String(page), sort: "updated", direction: "desc" });
    const response = await this.get<unknown[]>(locator, `${pathFor(locator, "/pulls")}?${params}`, options);
    if (!Array.isArray(response.data)) throw new SourceControlError("invalid_response", "GitHub returned an invalid pull-request page.");
    const query = request.query?.toLocaleLowerCase();
    const decoded = response.data
      .map(decodePullRequest)
      .filter((pullRequest) => !request.states || request.states.includes(pullRequest.state))
      .filter((pullRequest) => request.draft === undefined || request.draft === pullRequest.draft)
      .filter((pullRequest) => !query || pullRequest.title.toLocaleLowerCase().includes(query));
    const observedRateLimit = rateLimit(response.headers);
    const nextCursor = nextPageCursor(response.headers);
    return {
      items: decoded,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(observedRateLimit === undefined ? {} : { rateLimit: observedRateLimit }),
    };
  }
}
