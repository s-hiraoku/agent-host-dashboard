import { describe, expect, it, vi } from "vitest";
import { GitHubRestClient } from "../../../src/repositories/github/github-rest-client.js";
import { demoRepository } from "../../../src/testing/repositories/fixtures.js";

const headers = {
  "content-type": "application/json",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-reset": "1768471200",
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers, ...init });
}

function issue(number: number, pullRequest = false) {
  return {
    id: 1_000 + number,
    number,
    title: `Sanitized issue ${number}`,
    state: "open",
    html_url: `https://github.com/example-labs/orbit/issues/${number}`,
    updated_at: "2026-01-15T09:00:00.000Z",
    labels: [{ name: "contract" }],
    ...(pullRequest ? { pull_request: { url: "https://api.github.com/pulls/1" } } : {}),
  };
}

function pullRequest(number: number, state: "open" | "closed", merged = false) {
  return {
    id: 2_000 + number,
    number,
    title: `Sanitized pull request ${number}`,
    state,
    draft: false,
    html_url: `https://github.com/example-labs/orbit/pull/${number}`,
    updated_at: "2026-01-15T09:00:00.000Z",
    merged_at: merged ? "2026-01-15T09:05:00.000Z" : null,
    head: { ref: `topic-${number}`, user: { login: "example-contributor" } },
  };
}

describe("GitHubRestClient", () => {
  it("accepts only explicit credential-free HTTPS API endpoints", () => {
    expect(() => new GitHubRestClient({ endpoints: [] })).toThrow(/At least one/);
    expect(() => new GitHubRestClient({
      endpoints: [{ host: "github.example", baseUrl: "http://github.example/api/v3" }],
    })).toThrow(/credential-free HTTPS/);
    expect(() => new GitHubRestClient({ requestTimeoutMs: 0 })).toThrow(/positive/);
    expect(() => new GitHubRestClient({ cacheMaxEntries: 0 })).toThrow(/positive/);
  });

  it("keeps requests on the configured origin when an endpoint path contains two slashes", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://ghe.example//repos/acme/widgets");
      return json({
        id: 123,
        html_url: "https://ghe.example/acme/widgets",
        visibility: "private",
        default_branch: "main",
      });
    });
    const client = new GitHubRestClient({
      endpoints: [{ host: "ghe.example", baseUrl: "https://ghe.example//" }],
      authentication: () => ({ scheme: "Bearer", token: "memory-only" }),
      fetch: fetcher,
    });

    await client.repository({ service: "github", host: "ghe.example", owner: "acme", name: "widgets" });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("injects an ephemeral bearer credential only after host validation", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const sent = new Headers(init?.headers);
      expect(sent.get("authorization")).toBe("Bearer transient-test-value");
      expect(sent.get("x-github-api-version")).toBe("2026-03-10");
      return json({
        id: 123,
        html_url: "https://github.com/example-labs/orbit",
        visibility: "public",
        default_branch: "main",
      });
    });
    const authentication = vi.fn(() => ({ scheme: "Bearer" as const, token: " transient-test-value " }));
    const client = new GitHubRestClient({ fetch: fetcher, authentication });

    await expect(client.repository(demoRepository.locator)).resolves.toMatchObject({
      locator: { repositoryId: "123" },
      defaultBranch: "main",
    });
    expect(authentication).toHaveBeenCalledWith("github.com");

    const foreign = { ...demoRepository.locator, host: "unconfigured.example" };
    await expect(client.repository(foreign)).rejects.toMatchObject({ code: "unsupported_host" });
    expect(authentication).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("selects credentials for the validated repository host", async () => {
    const authentication = vi.fn((host: string) => ({ scheme: "Bearer" as const, token: `${host}-token` }));
    const authorizations: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return json({ id: 123, html_url: `https://${url.host}/example-labs/orbit`, visibility: "private", default_branch: "main" });
    });
    const client = new GitHubRestClient({
      authentication,
      fetch: fetcher,
      endpoints: [
        { host: "github.com", baseUrl: "https://api.github.com" },
        { host: "github.example", baseUrl: "https://github.example/api/v3" },
      ],
    });

    await client.repository(demoRepository.locator);
    await client.repository({ ...demoRepository.locator, host: "github.example" });

    expect(authentication.mock.calls.map(([host]) => host)).toEqual(["github.com", "github.example"]);
    expect(authorizations).toEqual(["Bearer github.com-token", "Bearer github.example-token"]);
  });

  it("lists Issues without misclassifying pull requests returned by the Issues endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/repos/example-labs/orbit/issues");
      expect(url.searchParams.get("state")).toBe("open");
      expect(url.searchParams.get("per_page")).toBe("2");
      return json([issue(17), issue(42, true)], {
        headers: {
          ...headers,
          link: '<https://api.github.com/repos/example-labs/orbit/issues?state=open&per_page=2&page=2>; rel="next"',
        },
      });
    });
    const client = new GitHubRestClient({ fetch: fetcher, cacheTtlMs: 0 });

    await expect(client.issues(demoRepository.locator, { states: ["open"], limit: 2 })).resolves.toMatchObject({
      items: [{ number: 17, labels: ["contract"] }],
      nextCursor: "2",
      rateLimit: { remaining: 4999, limit: 5000 },
    });
  });

  it("decodes open, closed, and merged pull-request states without N+1 enrichment", async () => {
    const client = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json([
        pullRequest(42, "open"),
        pullRequest(38, "closed", true),
      ])),
      cacheTtlMs: 0,
    });

    const page = await client.pullRequests(demoRepository.locator, { states: ["open", "merged"] });

    expect(page.items.map((item) => [item.number, item.state, item.head.owner])).toEqual([
      [42, "open", "example-contributor"],
      [38, "merged", "example-contributor"],
    ]);
    expect(page.items.every((item) => item.checks === "unknown" && item.review === "unknown")).toBe(true);
  });

  it("loads an explicitly associated pull request by number", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("/repos/example-labs/orbit/pulls/42");
      return json(pullRequest(42, "open"));
    });
    const client = new GitHubRestClient({ fetch: fetcher, cacheTtlMs: 0 });

    await expect(client.pullRequest(demoRepository.locator, 42)).resolves.toMatchObject({ number: 42, state: "open" });
    await expect(client.pullRequest(demoRepository.locator, 0)).rejects.toThrow(/positive integer/);
  });

  it("uses memory-only TTL and ETag revalidation", async () => {
    let now = 1_000;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const requestHeaders = new Headers(init?.headers);
      if (requestHeaders.get("if-none-match") === '"fixture-etag"') {
        return new Response(null, { status: 304, headers });
      }
      return json({ id: 123, html_url: demoRepository.url, visibility: "public", default_branch: "main" }, {
        headers: { ...headers, etag: '"fixture-etag"' },
      });
    });
    const client = new GitHubRestClient({ fetch: fetcher, now: () => now, cacheTtlMs: 50 });

    await client.repository(demoRepository.locator);
    await client.repository(demoRepository.locator);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 51;
    await client.repository(demoRepository.locator);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"fixture-etag"');
  });

  it("does not reuse cached private data after an in-memory credential rotates", async () => {
    let token = "first-transient-token";
    const fetcher = vi.fn<typeof fetch>(async () => json({
      id: token === "first-transient-token" ? 123 : 456,
      html_url: demoRepository.url,
      visibility: "private",
      default_branch: "main",
    }));
    const client = new GitHubRestClient({
      fetch: fetcher,
      authentication: () => ({ scheme: "Bearer", token }),
      cacheTtlMs: 60_000,
    });

    await expect(client.repository(demoRepository.locator)).resolves.toMatchObject({ locator: { repositoryId: "123" } });
    token = "second-transient-token";
    await expect(client.repository(demoRepository.locator)).resolves.toMatchObject({ locator: { repositoryId: "456" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rechecks cancellation after credential scoping before serving a warm cache", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({
      id: 123,
      html_url: demoRepository.url,
      visibility: "private",
      default_branch: "main",
    }));
    const client = new GitHubRestClient({
      fetch: fetcher,
      authentication: () => ({ scheme: "Bearer", token: "transient-cache-token" }),
      cacheTtlMs: 60_000,
    });
    await client.repository(demoRepository.locator);
    let finishDigest: (value: ArrayBuffer) => void = () => undefined;
    const pendingDigest = new Promise<ArrayBuffer>((resolve) => { finishDigest = resolve; });
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async () => await pendingDigest);
    const controller = new AbortController();

    const pending = client.repository(demoRepository.locator, { signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    finishDigest(new Uint8Array(32).buffer);

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    digest.mockRestore();
  });

  it("maps authentication and rate-limit failures without exposing response bodies", async () => {
    const unauthorized = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json({ message: "private upstream detail" }, {
        status: 401,
        headers: { "x-github-request-id": "request-demo" },
      })),
      cacheTtlMs: 0,
    });
    await expect(unauthorized.repository(demoRepository.locator)).rejects.toMatchObject({
      code: "unauthorized",
      requestId: "request-demo",
      message: "GitHub authentication failed.",
    });

    const limited = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json({ message: "limit" }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1768471200" },
      })),
      cacheTtlMs: 0,
    });
    await expect(limited.repository(demoRepository.locator)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAt: "2026-01-15T10:00:00.000Z",
    });

    const secondaryLimited = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json({ message: "secondary limit" }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "10", "retry-after": "60" },
      })),
      cacheTtlMs: 0,
      now: () => Date.parse("2026-01-15T10:00:00.000Z"),
    });
    await expect(secondaryLimited.repository(demoRepository.locator)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAt: "2026-01-15T10:01:00.000Z",
    });

    const combinedHeaders = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json({ message: "secondary limit" }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": "1768474800", "retry-after": "60" },
      })),
      cacheTtlMs: 0,
      now: () => Date.parse("2026-01-15T10:00:00.000Z"),
    });
    await expect(combinedHeaders.repository(demoRepository.locator)).rejects.toMatchObject({
      code: "rate_limited",
      retryAt: "2026-01-15T10:01:00.000Z",
    });
  });

  it("uses browser-compatible redirects and rejects a cross-origin final URL", async () => {
    const redirected = json({ id: 123, html_url: demoRepository.url, visibility: "public", default_branch: "main" });
    Object.defineProperty(redirected, "url", { value: "https://elsewhere.example/repos/example-labs/orbit" });
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("follow");
      return redirected;
    });
    const client = new GitHubRestClient({ fetch: fetcher, cacheTtlMs: 0 });

    await expect(client.repository(demoRepository.locator)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("omits rate-limit metadata when GitHub does not supply all headers", async () => {
    const client = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(async () => json([issue(17)], { headers: { "x-ratelimit-remaining": "10" } })),
      cacheTtlMs: 0,
    });

    await expect(client.issues(demoRepository.locator)).resolves.not.toHaveProperty("rateLimit");
  });

  it("settles timeout and caller cancellation even when fetch ignores AbortSignal", async () => {
    const client = new GitHubRestClient({
      fetch: vi.fn<typeof fetch>(() => new Promise(() => undefined)),
      requestTimeoutMs: 5,
    });
    await expect(client.repository(demoRepository.locator)).rejects.toMatchObject({ code: "timeout", retryable: true });

    const controller = new AbortController();
    const pending = client.repository(demoRepository.locator, { signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("settles timeout while a custom response body reader ignores AbortSignal", async () => {
    const response = {
      ok: true,
      status: 200,
      url: "https://api.github.com/repos/example-labs/orbit",
      headers: new Headers(headers),
      json: () => new Promise<unknown>(() => undefined),
    } as Response;
    const client = new GitHubRestClient({ fetch: vi.fn<typeof fetch>(async () => response), requestTimeoutMs: 5 });

    await expect(client.repository(demoRepository.locator)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});
