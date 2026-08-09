import { describe, expect, it, vi } from "vitest";
import { AgentHostError } from "../src/errors.js";
import { FetchHttpChannel } from "../src/http/fetch-channel.js";

describe("FetchHttpChannel", () => {
  it("injects a bearer token only in the Authorization header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const channel = new FetchHttpChannel({
      baseUrl: "http://127.0.0.1:4777",
      authentication: () => ({ scheme: "Bearer", token: "transient-demo-secret" }),
      fetch,
    });

    await channel.request({ path: "/v1/example" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4777/v1/example");
    expect(String(url)).not.toContain("transient-demo-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer transient-demo-secret");
  });

  it("uses same-origin proxy paths by default", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const channel = new FetchHttpChannel({ fetch });

    await channel.request({ path: "/v1/example" });

    expect(fetch.mock.calls[0]?.[0]).toBe("/agent-host/v1/example");
  });

  it("refuses insecure remote endpoints and URLs carrying secrets", () => {
    expect(() => new FetchHttpChannel({ baseUrl: "http://agents.example.test" })).toThrow(AgentHostError);
    expect(() => new FetchHttpChannel({ baseUrl: "http://127.0.0.1:4777?token=secret" })).toThrow(
      /query parameters/,
    );
    expect(
      () => new FetchHttpChannel({ baseUrl: "https://agents.example.test", allowRemoteHttps: true }),
    ).not.toThrow();
    expect(() => new FetchHttpChannel({ baseUrl: "//agents.example.test" })).toThrow(/one slash/);
    expect(() => new FetchHttpChannel({ baseUrl: "/agent-host?token=secret" })).toThrow(/query parameters/);
    expect(() => new FetchHttpChannel({ baseUrl: "/agent-host#fragment" })).toThrow(/fragments/);
  });

  it("maps authorization responses to structured errors without logging bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "invalid_token", message: "redacted" }), {
        status: 401,
        headers: { "x-request-id": "request-demo" },
      }),
    );
    const channel = new FetchHttpChannel({ fetch });

    await expect(channel.request({ path: "/v1/private" })).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
      requestId: "request-demo",
    });
  });

  it("classifies a non-JSON authorization failure before parsing its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("<html>unauthorized</html>", {
        status: 401,
        headers: { "content-type": "text/html", "x-request-id": "request-html" },
      }),
    );
    const channel = new FetchHttpChannel({ fetch });

    await expect(channel.request({ path: "/v1/private" })).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
      requestId: "request-html",
    });
  });

  it("requires an event-stream content type while allowing parameters", async () => {
    const validFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    );
    const valid = new FetchHttpChannel({ fetch: validFetch });
    const frames = [];
    for await (const frame of valid.events({ path: "/v1/events" })) frames.push(frame);
    expect(frames).toEqual([{ data: "ok" }]);

    const invalidFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const invalid = new FetchHttpChannel({ fetch: invalidFetch });
    await expect(invalid.events({ path: "/v1/events" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
