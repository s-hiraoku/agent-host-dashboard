import { describe, expect, it } from "vitest";
import { MockRepositoryContextSource, MockSourceControlClient } from "../../src/testing/repositories/mock-clients.js";
import { demoRepository } from "../../src/testing/repositories/fixtures.js";
import { SourceControlError, toSourceControlError } from "../../src/repositories/source-control.js";

describe("sanitized repository clients", () => {
  it("keeps repository association separate from AgentHostClient wire behavior", async () => {
    const source = new MockRepositoryContextSource();

    await expect(source.forAgent("demo:orbit-review")).resolves.toMatchObject({
      state: "ready",
      associations: [{ kind: "confirmed", pullRequest: { number: 42 } }],
    });
    await expect(source.forAgent("demo:unassociated")).resolves.toMatchObject({ state: "ready", associations: [] });
  });

  it("lists bounded, filtered Issue and PR pages", async () => {
    const client = new MockSourceControlClient();

    await expect(client.issues(demoRepository.locator, { states: ["open"], limit: 1 })).resolves.toMatchObject({
      totalCount: 1,
      items: [{ number: 17, state: "open" }],
    });
    await expect(client.pullRequests(demoRepository.locator, { states: ["open"], draft: false })).resolves.toMatchObject({
      totalCount: 1,
      items: [{ number: 42, checks: "passing", review: "approved" }],
    });
    await expect(client.pullRequest(demoRepository.locator, 42)).resolves.toMatchObject({ number: 42, title: "Harden parser boundary" });
    await expect(client.pullRequests(demoRepository.locator, { query: "INVESTIGATE" })).resolves.toMatchObject({
      items: [{ number: 41 }],
    });
    await expect(client.pullRequests(demoRepository.locator, { limit: 101 })).rejects.toThrow(/1 to 100/);
  });

  it("returns source-control failures independently from repository context state", async () => {
    const client = new MockSourceControlClient();
    const missing = { service: "github" as const, host: "github.com", owner: "example-labs", name: "missing" };

    await expect(client.repository(missing)).rejects.toMatchObject({ code: "not_found", status: 404 });

    const rateLimit = new SourceControlError("rate_limited", "Try later.", {
      status: 429,
      retryable: true,
      retryAt: "2026-01-15T10:00:00.000Z",
    });
    expect(toSourceControlError(rateLimit)).toBe(rateLimit);
    expect(rateLimit).toMatchObject({ code: "rate_limited", status: 429, retryable: true });
  });

  it("honors cancellation without accepting credentials in the public API", async () => {
    const client = new MockSourceControlClient();
    const controller = new AbortController();
    controller.abort();

    await expect(client.pullRequests(demoRepository.locator, {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(toSourceControlError(new DOMException("cancelled", "AbortError"))).toMatchObject({ code: "aborted" });
    expect(Object.keys(client)).not.toContain("token");
  });
});
