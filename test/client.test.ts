import { describe, expect, it } from "vitest";
import { DefaultAgentHostClient } from "../src/client.js";
import { AgentHostError } from "../src/errors.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";

describe("DefaultAgentHostClient", () => {
  it("denies actions when a capability is unknown or unavailable", async () => {
    const transport = new MockAgentHostTransport();
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

    await expect(
      client.action({ id: "demo:read-only", capabilities: { read: true } }, { kind: "interrupt" }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(transport.actions).toHaveLength(0);
  });

  it("passes explicit semantic approval IDs to the transport", async () => {
    const transport = new MockAgentHostTransport();
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

    await client.action(
      { id: "demo:blocked", capabilities: { approve: true } },
      { kind: "approve", approvalId: "approval-demo-1", expectedRevision: 40 },
    );

    expect(transport.actions[0]?.action).toEqual({
      kind: "approve",
      approvalId: "approval-demo-1",
      expectedRevision: 40,
    });
  });

  it("rejects unsupported API versions before reading a snapshot", async () => {
    const transport = new MockAgentHostTransport();
    transport.apiInfo = { apiVersion: "2", features: [] };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

    await expect(client.discover()).rejects.toMatchObject({
      code: "incompatible_version",
      details: { supported: ["1"], received: "2" },
    });
  });

  it("times out requests and cancels their transport signal", async () => {
    const transport = new MockAgentHostTransport();
    transport.snapshot = (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"], requestTimeoutMs: 5 });

    await expect(client.snapshot()).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("propagates caller cancellation as a structured error", async () => {
    const transport = new MockAgentHostTransport();
    transport.snapshot = (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });
    const controller = new AbortController();
    const request = client.snapshot({}, { signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(request).rejects.toMatchObject({ code: "aborted" });
  });

  it("preserves structured transport errors", async () => {
    const transport = new MockAgentHostTransport();
    transport.detail = async () => {
      throw new AgentHostError("unauthorized", "Token expired.", { status: 401, requestId: "request-demo" });
    };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

    await expect(client.detail("demo:agent")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
      requestId: "request-demo",
    });
  });
});
