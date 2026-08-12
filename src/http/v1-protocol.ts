import {
  agentStatuses,
  type AdapterHealth,
  type AgentAction,
  type AgentActionResult,
  type AgentCapabilities,
  type AgentDetail,
  type AgentEvent,
  type AgentPageRequest,
  type AgentSnapshot,
  type AgentStatus,
  type AgentSummary,
  type ApiInfo,
  type ApprovalRequest,
} from "../domain.js";
import { AgentHostError, toAgentHostError } from "../errors.js";
import type { EventStreamOptions, RequestOptions } from "../transport.js";
import type { AgentHostWireProtocol } from "./protocol.js";
import type { HttpChannel, SseFrame } from "./types.js";

const API_VERSION = "1";
const FEATURES = [
  "adapter-health",
  "cursor-pagination",
  "filter",
  "fixed-attention-order",
  "idempotent-actions",
  "sse-sequence",
] as const;
const statuses = new Set<string>(agentStatuses);
const confidences = new Set(["low", "medium", "high"]);
const views = new Set(["active", "recent", "historical", "raw"]);

type JsonRecord = Record<string, unknown>;

function invalid(label: string): never {
  throw new AgentHostError("invalid_response", `agent-host returned an invalid ${label}.`);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(label);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(label);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result) || result < 0) invalid(label);
  return result;
}

function assertVersion(value: JsonRecord): void {
  const version = string(value.apiVersion, "API version");
  if (version !== API_VERSION) {
    throw new AgentHostError("incompatible_version", `Unsupported agent-host API version: ${version}.`, {
      details: { supported: [API_VERSION], received: version },
    });
  }
}

function status(value: unknown): AgentStatus {
  const result = string(value, "agent status");
  if (!statuses.has(result)) invalid("agent status");
  return result as AgentStatus;
}

function capabilities(value: unknown): AgentCapabilities {
  const input = record(value, "agent capabilities");
  return {
    ...(input.prompt === true ? { prompt: true } : {}),
    ...(input.read === true ? { read: true } : {}),
    ...(input.interrupt === true ? { interrupt: true } : {}),
    ...(input.approve === true ? { approve: true } : {}),
    ...(input.reject === true ? { reject: true } : {}),
  };
}

function summary(value: unknown): AgentSummary {
  const input = record(value, "agent summary");
  const id = string(input.id, "agent id");
  const source = string(input.source, "agent source");
  const discovery = input.discovery === undefined ? undefined : record(input.discovery, "agent discovery");
  const confidence = optionalString(discovery?.confidence);
  const view = optionalString(discovery?.visibility);
  const cwd = optionalString(input.cwd);
  const lastActivityAt = optionalString(input.lastActivityAt);
  return {
    id,
    name: optionalString(input.name) ?? id,
    provider: string(input.provider, "agent provider"),
    status: status(input.status),
    capabilities: capabilities(input.capabilities),
    ...(cwd ? { cwd } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    provenance: {
      source,
      ...(confidence && confidences.has(confidence) ? { confidence: confidence as "low" | "medium" | "high" } : {}),
      ...(view && views.has(view) ? { view: view as "active" | "recent" | "historical" | "raw" } : {}),
    },
  };
}

function approval(value: unknown): ApprovalRequest {
  const input = record(value, "approval request");
  const command = optionalString(input.command);
  const path = optionalString(input.path);
  const reason = optionalString(input.reason);
  return {
    id: string(input.approvalId, "approval id"),
    kind: command ? "command" : path ? "file" : "other",
    summary: reason ?? command ?? "Approval request",
    ...(reason ? { reason } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
  };
}

function detail(value: unknown): AgentDetail {
  const input = record(value, "agent detail");
  const pending = input.pendingApprovals;
  if (!Array.isArray(pending)) invalid("pending approvals");
  const publicData = Object.fromEntries(
    ["sessionId", "target", "pid", "tty", "activeTurnId", "discovery"]
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
  const createdAt = optionalString(input.discoveredAt);
  return {
    ...summary(input),
    ...(createdAt ? { createdAt } : {}),
    pendingApprovals: pending.map(approval),
    ...(Object.keys(publicData).length ? { publicData } : {}),
  };
}

function health(value: unknown): AdapterHealth {
  const input = record(value, "adapter health");
  const id = string(input.id, "adapter id");
  const wireStatus = string(input.status, "adapter status");
  if (!["loading", "healthy", "error", "timeout"].includes(wireStatus)) invalid("adapter status");
  const lastSuccessAt = optionalString(input.lastSuccessAt);
  const lastAttemptAt = optionalString(input.lastAttemptAt);
  const mappedStatus = wireStatus === "loading"
    ? "starting"
    : wireStatus === "healthy"
      ? "healthy"
      : lastSuccessAt
        ? "degraded"
        : "unavailable";
  const wireError = input.error == null ? undefined : record(input.error, "adapter error");
  return {
    id,
    label: id,
    status: mappedStatus,
    ...(typeof input.durationMs === "number" ? { durationMs: finiteNumber(input.durationMs, "adapter duration") } : {}),
    ...(typeof input.agentCount === "number" ? { agentCount: nonNegativeInteger(input.agentCount, "adapter agent count") } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(wireError ? {
      error: {
        code: string(wireError.code, "adapter error code"),
        message: string(wireError.message, "adapter error message"),
        retryable: wireStatus === "error" || wireStatus === "timeout",
      },
    } : {}),
  };
}

function parseFrame(frame: SseFrame): JsonRecord {
  try {
    return record(JSON.parse(frame.data), "SSE event");
  } catch (error) {
    if (error instanceof AgentHostError) throw error;
    throw new AgentHostError("invalid_response", "agent-host returned invalid SSE JSON.", { cause: error });
  }
}

function event(frame: SseFrame, input: JsonRecord, sequence: number): AgentEvent | undefined {
  const revision = nonNegativeInteger(input.snapshotRevision, "event snapshot revision");
  if (frame.event === "agent.discovered" || frame.event === "agent.updated") {
    return { type: "agent.upserted", revision, sequence, agent: summary(input.agent) };
  }
  if (frame.event === "agent.removed") {
    return { type: "agent.removed", revision, sequence, agentId: string(input.agentId, "removed agent id") };
  }
  if (frame.event === "adapter.health") {
    return { type: "adapter.health", revision, sequence, adapter: health(input.adapter) };
  }
  if (frame.event === "audit.action" && input.phase === "completed") {
    if (typeof input.ok !== "boolean") invalid("action audit outcome");
    return {
      type: "action.completed",
      revision,
      sequence,
      agentId: string(input.agentId, "action agent id"),
      actionId: string(input.requestId, "action request id"),
      ok: input.ok,
    };
  }
  return undefined;
}

function actionPayload(action: AgentAction): JsonRecord {
  if (action.expectedRevision !== undefined) {
    throw new AgentHostError("unsupported", "Agent-host API v1 does not support action revision preconditions.");
  }
  if (action.kind === "prompt") return { text: action.text };
  if (action.kind === "approve" || action.kind === "reject") return { approvalId: action.approvalId };
  return {};
}

export interface AgentHostV1ProtocolOptions {
  readonly createIdempotencyKey?: () => string;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export class AgentHostV1Protocol implements AgentHostWireProtocol {
  private readonly createIdempotencyKey: () => string;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AgentHostV1ProtocolOptions = {}) {
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", abort, { once: true });
    }));
  }

  async discover(channel: HttpChannel, options?: RequestOptions): Promise<ApiInfo> {
    const response = await channel.request({ path: "/v1/adapters", ...(options?.signal ? { signal: options.signal } : {}) });
    const body = record(response.body, "discovery response");
    assertVersion(body);
    return { apiVersion: API_VERSION, features: FEATURES };
  }

  async snapshot(channel: HttpChannel, request: AgentPageRequest, options?: RequestOptions): Promise<AgentSnapshot> {
    if (request.sort && (request.sort.field !== "status" || request.sort.direction !== "asc")) {
      throw new AgentHostError("unsupported", "Agent-host API v1 exposes fixed attention ordering only.");
    }
    const query = new URLSearchParams();
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    if (request.cursor !== undefined) query.set("cursor", request.cursor);
    for (const provider of request.filter?.providers ?? []) query.append("provider", provider);
    for (const agentStatus of request.filter?.statuses ?? []) query.append("status", agentStatus);
    if (request.filter?.cwd) query.set("cwd", request.filter.cwd);
    if (request.filter?.text) query.set("q", request.filter.text);
    if (request.filter?.view) query.set("view", request.filter.view);
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await channel.request({ path: `/v1/agents${suffix}`, ...(options?.signal ? { signal: options.signal } : {}) });
    const body = record(response.body, "agent list response");
    assertVersion(body);
    if (!Array.isArray(body.agents)) invalid("agent list");
    const page = record(body.page, "agent page");
    const nextCursor = optionalString(page.nextCursor);
    return {
      agents: body.agents.map(summary),
      revision: nonNegativeInteger(body.revision, "snapshot revision"),
      total: nonNegativeInteger(page.total, "agent total"),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async detail(channel: HttpChannel, agentId: string, options?: RequestOptions): Promise<AgentDetail> {
    const response = await channel.request({ path: `/v1/agents/${encodeURIComponent(agentId)}`, ...(options?.signal ? { signal: options.signal } : {}) });
    const body = record(response.body, "agent detail response");
    assertVersion(body);
    return detail(body.agent);
  }

  async adapterHealth(channel: HttpChannel, options?: RequestOptions): Promise<readonly AdapterHealth[]> {
    const response = await channel.request({ path: "/v1/adapters", ...(options?.signal ? { signal: options.signal } : {}) });
    const body = record(response.body, "adapter response");
    assertVersion(body);
    if (!Array.isArray(body.adapters)) invalid("adapter list");
    return body.adapters.map(health);
  }

  async action(
    channel: HttpChannel,
    target: { readonly id: string },
    action: AgentAction,
    options?: RequestOptions,
  ): Promise<AgentActionResult> {
    const actionId = this.createIdempotencyKey();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(actionId)) {
      throw new AgentHostError("unsupported", "The action idempotency-key provider returned an invalid key.");
    }
    const request = {
      path: `/v1/agents/${encodeURIComponent(target.id)}/${action.kind}`,
      method: "POST",
      headers: { "idempotency-key": actionId },
      body: actionPayload(action),
      ...(options?.signal ? { signal: options.signal } : {}),
    } as const;
    let response;
    try {
      response = await channel.request(request);
    } catch (error) {
      const failure = toAgentHostError(error);
      if (!failure.retryable || options?.signal?.aborted) throw failure;
      if (failure.code === "rate_limited") {
        const value = failure.details?.retryAfter;
        const seconds = typeof value === "string" ? Number(value) : Number.NaN;
        if (Number.isFinite(seconds) && seconds > 0) await this.sleep(seconds * 1_000, options?.signal);
      }
      response = await channel.request(request);
    }
    const body = record(response.body, "action response");
    assertVersion(body);
    const result = record(body.result, "action result");
    if (result.ok !== true) invalid("action result");
    if (string(result.agentId, "action agent id") !== target.id || string(result.action, "action kind") !== action.kind) {
      invalid("action target");
    }
    return { ok: true, actionId };
  }

  async *events(channel: HttpChannel, options: EventStreamOptions): AsyncIterable<AgentEvent> {
    let ready = false;
    let expectedSequence: number | undefined;
    for await (const frame of channel.events({ path: "/v1/events", ...(options.signal ? { signal: options.signal } : {}) })) {
      const body = parseFrame(frame);
      assertVersion(body);
      if (!ready) {
        if (frame.event !== "ready") invalid("SSE ready event");
        const revision = nonNegativeInteger(body.revision, "ready revision");
        expectedSequence = nonNegativeInteger(body.sequence, "ready sequence");
        ready = true;
        if (revision !== options.afterRevision) {
          throw new AgentHostError("revision_gap", "The event stream snapshot changed before the ready handshake.", {
            retryable: true,
            details: { expected: options.afterRevision, received: revision },
          });
        }
        continue;
      }
      const sequence = nonNegativeInteger(body.sequence, "event sequence");
      if (expectedSequence === undefined || sequence !== expectedSequence + 1) {
        throw new AgentHostError("revision_gap", "The event stream sequence is not contiguous.", {
          retryable: true,
          details: { expected: (expectedSequence ?? -1) + 1, received: sequence },
        });
      }
      expectedSequence = sequence;
      const decoded = event(frame, body, sequence);
      if (decoded) yield decoded;
    }
    if (!ready) {
      throw new AgentHostError("connection_failed", "The event stream closed before the ready handshake.", {
        retryable: true,
      });
    }
  }
}
