import { describe, expect, it } from "vitest";
import { AgentHostError } from "../../src/errors.js";
import { AgentHostV1Protocol } from "../../src/http/v1-protocol.js";
import type { HttpChannel, HttpRequest, HttpResponse, SseFrame, SseRequest } from "../../src/http/types.js";
import { AgentHostRepositoryContextSource } from "../../src/repositories/agent-host-context-source.js";

class RecordingChannel implements HttpChannel {
  readonly requests: HttpRequest[] = [];
  responses: Array<unknown | AgentHostError> = [];

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next instanceof AgentHostError) throw next;
    return { status: 200, headers: new Headers({ "cache-control": "private, no-store" }), body: next as T };
  }

  async *events(_request: SseRequest): AsyncIterable<SseFrame> {}
}

const capability = {
  apiVersion: "1",
  capabilities: {
    repositoryAssociations: { status: "supported", versions: ["1"], maxItems: 100, replay: false },
  },
};

describe("AgentHostRepositoryContextSource", () => {
  it("treats a missing capability endpoint as host-unsupported", async () => {
    const channel = new RecordingChannel();
    channel.responses = [new AgentHostError("not_found", "route not found", { status: 404 })];
    const source = new AgentHostRepositoryContextSource(channel, new AgentHostV1Protocol());

    await expect(source.forAgent("demo:working")).resolves.toEqual({
      state: "unsupported",
      reason: "Host does not publish repository associations.",
    });
    expect(channel.requests).toEqual([expect.objectContaining({ path: "/v1/capabilities" })]);
  });

  it("maps github named associations and preserves stale/partial qualifiers", async () => {
    const channel = new RecordingChannel();
    channel.responses = [
      capability,
      {
        apiVersion: "1",
        associationVersion: "1",
        revision: 9,
        agentId: "demo:done",
        state: "ready",
        freshness: "stale",
        complete: false,
        associations: [{
          kind: "candidate",
          reason: "adapter_heuristic",
          repository: {
            forge: "github",
            host: "github.com",
            coordinates: { kind: "named", owner: "example-labs", name: "orbit" },
            webUrl: "https://github.com/example-labs/orbit",
            visibility: "private",
          },
          provenance: { source: "adapter-heuristic", confidence: "medium" },
        }, {
          kind: "confirmed",
          repository: {
            forge: "github",
            host: "github.com",
            coordinates: { kind: "opaque", value: "R_opaque" },
            webUrl: "https://github.com/example-labs/hidden",
          },
          provenance: { source: "adapter-authoritative", confidence: "high" },
        }],
      },
    ];
    const source = new AgentHostRepositoryContextSource(channel, new AgentHostV1Protocol());

    await expect(source.forAgent("demo:done")).resolves.toMatchObject({
      state: "ready",
      freshness: "stale",
      complete: false,
      revision: 9,
      associations: [{
        kind: "candidate",
        reason: "adapter_heuristic",
        repository: { service: "github", host: "github.com", owner: "example-labs", name: "orbit" },
      }],
    });
  });

  it("does not treat auth failures as unsupported", async () => {
    const channel = new RecordingChannel();
    channel.responses = [new AgentHostError("unauthorized", "rejected", { status: 401 })];
    const source = new AgentHostRepositoryContextSource(channel, new AgentHostV1Protocol());

    await expect(source.forAgent("demo:working")).resolves.toEqual({
      state: "unavailable",
      reason: "rejected",
      retryable: true,
    });
  });
});
