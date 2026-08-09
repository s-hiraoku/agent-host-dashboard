import { describe, expect, it, vi } from "vitest";
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

  it("rejects unsupported API versions before any direct protocol operation", async () => {
    const transport = new MockAgentHostTransport();
    transport.apiInfo = { apiVersion: "2", features: [] };
    const snapshot = vi.spyOn(transport, "snapshot");
    const action = vi.spyOn(transport, "action");
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

    await expect(client.snapshot()).rejects.toMatchObject({
      code: "incompatible_version",
      details: { supported: ["1"], received: "2" },
    });
    await expect(
      client.action({ id: "demo", capabilities: { read: true } }, { kind: "read" }),
    ).rejects.toMatchObject({ code: "incompatible_version" });
    await expect(client.events({ afterRevision: 0 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "incompatible_version",
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
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

  it("settles a timeout even when the transport ignores cancellation", async () => {
    const transport = new MockAgentHostTransport();
    transport.snapshot = () => new Promise(() => undefined);
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
