import {
  agentStatuses,
  fileChangeKinds,
  localProjectIdPattern,
  type AdapterHealth,
  type AgentAction,
  type AgentActionResult,
  type AgentCapabilities,
  type AgentDetail,
  type AgentEvent,
  type AgentPageRequest,
  type AgentProject,
  type AgentSnapshot,
  type AgentSort,
  type AgentStatus,
  type AgentSummary,
  type ApiInfo,
  type ApprovalFile,
  type ApprovalRequest,
  type FileChangeKind,
} from "../domain.js";
import { AgentHostError, toAgentHostError } from "../errors.js";
import type { EventStreamOptions, RequestOptions } from "../transport.js";
import type { AgentHostWireProtocol, RepositoryAssociationCapability } from "./protocol.js";
import type { HttpChannel, SseFrame } from "./types.js";
import type { GitHubRepositoryLocator, RepositoryAssociation, RepositoryContextResult } from "../repositories/domain.js";

const API_VERSION = "1";
const FEATURES = [
  "adapter-health",
  "cursor-pagination",
  "facets",
  "filter",
  "idempotent-actions",
  "sort",
  "sse-sequence",
] as const;
const statuses = new Set<string>(agentStatuses);
const confidences = new Set(["low", "medium", "high"]);
const views = new Set(["active", "recent", "historical", "raw"]);
const fileKinds = new Set<string>(fileChangeKinds);
const associationKinds = new Set(["confirmed", "candidate"]);
const provenanceSources = new Set(["adapter-authoritative", "user-declared", "adapter-heuristic"]);
const candidateReasons = new Set(["repository_match", "branch_match", "adapter_heuristic"]);
const REPOSITORY_ASSOCIATION_VERSION = "1";
const MAX_REPOSITORY_ASSOCIATIONS = 100;
const wireSorts = {
  name: "name",
  provider: "provider",
  status: "attention",
  lastActivityAt: "activity",
} as const;
const fromWireSort: Record<string, AgentSort["field"]> = {
  attention: "status",
  status: "status",
  name: "name",
  provider: "provider",
  activity: "lastActivityAt",
};
const controlOrBidi = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

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

function opaqueRevision(value: unknown, label: string): number | string {
  if (typeof value === "number") return nonNegativeInteger(value, label);
  const text = optionalString(value);
  if (!text || text.length > 200 || controlOrBidi.test(text)) invalid(label);
  return text;
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

function project(value: unknown): AgentProject | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "agent project");
  const id = string(input.id, "project id");
  const name = string(input.name, "project name");
  const scope = string(input.scope, "project scope");
  if (scope !== "local" || !localProjectIdPattern().test(id)) invalid("agent project");
  return { id, name, scope: "local" };
}

function publicApprovalPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || controlOrBidi.test(value)) return undefined;
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/u.test(portable)) return undefined;
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  const normalized = segments.join("/");
  return normalized.length <= 240 ? normalized : undefined;
}

function fileChangeContext(value: unknown): { files: readonly ApprovalFile[]; fileCount: number; truncated: boolean } | undefined {
  const input = record(value, "approval context");
  if (optionalString(input.kind) !== "file-change") return undefined;
  if (!Array.isArray(input.files) || input.files.length === 0) return undefined;
  const files: ApprovalFile[] = [];
  for (const entry of input.files) {
    const file = record(entry, "approval file");
    const path = publicApprovalPath(file.path);
    const kind = optionalString(file.kind);
    if (!path || !kind || !fileKinds.has(kind)) return undefined;
    files.push({ path, kind: kind as FileChangeKind });
  }
  const bounded = files.slice(0, 20);
  const fileCount = typeof input.fileCount === "number" && Number.isSafeInteger(input.fileCount) && input.fileCount >= files.length
    ? input.fileCount
    : files.length;
  return {
    files: bounded,
    fileCount,
    truncated: input.truncated === true || files.length > bounded.length || fileCount > bounded.length,
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
  const associatedProject = project(input.project);
  return {
    id,
    name: optionalString(input.name) ?? id,
    provider: string(input.provider, "agent provider"),
    status: status(input.status),
    capabilities: capabilities(input.capabilities),
    ...(cwd ? { cwd } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(associatedProject ? { project: associatedProject } : {}),
    provenance: {
      source,
      ...(confidence && confidences.has(confidence) ? { confidence: confidence as "low" | "medium" | "high" } : {}),
      ...(view && views.has(view) ? { view: view as "active" | "recent" | "historical" | "raw" } : {}),
    },
  };
}

function approval(value: unknown): ApprovalRequest {
  const input = record(value, "approval request");
  const id = string(input.approvalId, "approval id");
  const command = optionalString(input.command);
  const reason = optionalString(input.reason);
  const hostActionable = typeof input.actionable === "boolean" ? input.actionable : undefined;
  const contextPresent = input.context !== undefined;
  const context = contextPresent ? fileChangeContext(input.context) : undefined;

  if (context) {
    return {
      id,
      kind: "file",
      summary: reason ?? "File change request",
      ...(reason ? { reason } : {}),
      actionable: hostActionable !== false,
      files: context.files,
      fileCount: context.fileCount,
      truncated: context.truncated,
    };
  }

  if (contextPresent || hostActionable === true && !command) {
    return {
      id,
      kind: "other",
      summary: reason ?? command ?? "Approval request",
      ...(reason ? { reason } : {}),
      ...(command ? { command } : {}),
      actionable: false,
    };
  }

  if (command) {
    return {
      id,
      kind: "command",
      summary: reason ?? command,
      ...(reason ? { reason } : {}),
      command,
      ...(hostActionable !== undefined ? { actionable: hostActionable } : {}),
    };
  }

  return {
    id,
    kind: "other",
    summary: reason ?? "Approval request",
    ...(reason ? { reason } : {}),
    ...(hostActionable !== undefined ? { actionable: hostActionable } : {}),
  };
}

function snapshotSort(page: JsonRecord): AgentSort | undefined {
  const sort = optionalString(page.sort);
  const direction = optionalString(page.direction);
  if (!sort && !direction) return undefined;
  const field = sort ? fromWireSort[sort] : undefined;
  if (!field || (direction !== "asc" && direction !== "desc")) invalid("page sort");
  return { field, direction };
}

function snapshotFacets(value: unknown, revision: number): AgentSnapshot["facets"] | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "snapshot facets");
  const facetRevision = opaqueRevision(input.revision, "facet revision");
  if (typeof facetRevision === "number" && facetRevision !== revision) {
    throw new AgentHostError("revision_gap", "Facet revision does not match the snapshot revision.", {
      retryable: true,
      details: { expected: revision, received: facetRevision },
    });
  }
  if (!Array.isArray(input.providers) || !Array.isArray(input.statuses)) invalid("snapshot facets");
  const byProvider: Record<string, number> = {};
  for (const entry of input.providers) {
    const item = record(entry, "provider facet");
    byProvider[string(item.value, "provider facet value")] = nonNegativeInteger(item.count, "provider facet count");
  }
  const byStatus: Partial<Record<AgentStatus, number>> = {};
  for (const entry of input.statuses) {
    const item = record(entry, "status facet");
    byStatus[status(item.value)] = nonNegativeInteger(item.count, "status facet count");
  }
  return { revision: facetRevision, byStatus, byProvider };
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

function optionalRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function httpsWebUrl(value: unknown, host: string): string | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname.toLowerCase() !== host
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function safeCoordinate(value: string, allowSlash: boolean): boolean {
  if (/[\u0000-\u001f\u007f\\?#]/u.test(value) || /^\s|\s$/u.test(value)) return false;
  if (!allowSlash && value.includes("/")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function githubLocator(value: unknown): GitHubRepositoryLocator | undefined {
  const input = optionalRecord(value);
  if (!input) return undefined;
  const forge = optionalString(input.forge)?.toLowerCase();
  const host = optionalString(input.host)?.toLowerCase();
  if (forge !== "github" || !host || host.length > 253 || !/^[a-z0-9.-]+$/u.test(host) || host.startsWith(".") || host.endsWith(".")) {
    return undefined;
  }
  const coordinates = optionalRecord(input.coordinates);
  if (!coordinates || optionalString(coordinates.kind) !== "named") return undefined;
  const owner = optionalString(coordinates.owner);
  const name = optionalString(coordinates.name);
  if (!owner || !name || owner.length > 160 || name.length > 100 || !safeCoordinate(owner, true) || !safeCoordinate(name, false)) {
    return undefined;
  }
  if (!httpsWebUrl(input.webUrl, host)) return undefined;
  const repositoryId = optionalString(input.repositoryId);
  return {
    service: "github",
    host,
    owner,
    name,
    ...(repositoryId && repositoryId.length <= 128 ? { repositoryId } : {}),
  };
}

function wireAssociation(value: unknown, agentId: string): RepositoryAssociation | undefined {
  const input = optionalRecord(value);
  if (!input) return undefined;
  const kind = optionalString(input.kind);
  if (!kind || !associationKinds.has(kind)) return undefined;
  const repository = githubLocator(input.repository);
  if (!repository) return undefined;
  const provenanceInput = optionalRecord(input.provenance);
  const source = optionalString(provenanceInput?.source);
  const confidence = optionalString(provenanceInput?.confidence);
  if (!source || !provenanceSources.has(source) || !confidence || !confidences.has(confidence)) return undefined;
  if (kind === "confirmed" && (source === "adapter-heuristic" || confidence !== "high")) return undefined;
  if (kind === "candidate" && confidence === "high") return undefined;

  let checkout: { readonly branch?: string; readonly worktree?: string } | undefined;
  if (input.checkout !== undefined) {
    const checkoutInput = optionalRecord(input.checkout);
    if (!checkoutInput) return undefined;
    const branch = optionalString(checkoutInput.branch);
    let worktree: string | undefined;
    if (checkoutInput.worktree !== undefined) {
      const worktreeInput = optionalRecord(checkoutInput.worktree);
      const id = optionalString(worktreeInput?.id);
      if (!id || id.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined;
      worktree = id;
    }
    if (branch && branch.length > 255) return undefined;
    if (!branch && !worktree) return undefined;
    checkout = { ...(branch ? { branch } : {}), ...(worktree ? { worktree } : {}) };
  }

  if (kind === "candidate") {
    const reason = optionalString(input.reason);
    if (!reason || !candidateReasons.has(reason) || input.pullRequest !== undefined) return undefined;
    const provenance = { source, confidence: confidence as "low" | "medium" };
    if (reason === "branch_match") {
      if (!checkout?.branch) return undefined;
      return {
        kind: "candidate",
        agentId,
        repository,
        provenance,
        reason,
        checkout: { ...checkout, branch: checkout.branch },
      };
    }
    if (reason === "repository_match") {
      return {
        kind: "candidate",
        agentId,
        repository,
        provenance,
        reason,
        ...(checkout ? { checkout } : {}),
      };
    }
    return {
      kind: "candidate",
      agentId,
      repository,
      provenance,
      reason: "adapter_heuristic",
      ...(checkout ? { checkout } : {}),
    };
  }

  let pullRequest: { readonly number: number } | undefined;
  if (input.pullRequest !== undefined) {
    const pr = optionalRecord(input.pullRequest);
    if (!pr || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1) return undefined;
    pullRequest = { number: pr.number };
  }
  return {
    kind: "confirmed",
    agentId,
    repository,
    provenance: { source, confidence: "high" },
    ...(checkout ? { checkout } : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
}

function repositoryContextResult(body: JsonRecord, agentId: string): RepositoryContextResult {
  const state = optionalString(body.state);
  if (state === "unsupported") {
    return { state: "unsupported", reason: optionalString(body.reason) ?? "adapter_not_supported" };
  }
  if (state === "unavailable") {
    const error = optionalRecord(body.error);
    return {
      state: "unavailable",
      reason: optionalString(error?.code) ?? "repository_associations_unavailable",
      retryable: error?.retryable !== false,
    };
  }
  if (state !== "ready") invalid("repository association state");
  const reportedAgent = optionalString(body.agentId);
  if (reportedAgent && reportedAgent !== agentId) invalid("repository association agent id");
  const source = Array.isArray(body.associations) ? body.associations : undefined;
  const associations: RepositoryAssociation[] = [];
  let dropped = source === undefined;
  for (const item of (source ?? []).slice(0, MAX_REPOSITORY_ASSOCIATIONS)) {
    const association = wireAssociation(item, agentId);
    if (!association) {
      dropped = true;
      continue;
    }
    associations.push(association);
  }
  if ((source?.length ?? 0) > MAX_REPOSITORY_ASSOCIATIONS) dropped = true;
  const freshness = optionalString(body.freshness);
  const revision = typeof body.revision === "number" ? nonNegativeInteger(body.revision, "repository revision") : undefined;
  return {
    state: "ready",
    associations,
    freshness: freshness === "stale" ? "stale" : "current",
    complete: body.complete !== false && !dropped,
    ...(revision === undefined ? {} : { revision }),
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
  if (frame.event === "agent.repository-associations.changed") {
    if (input.agent !== undefined || input.repository !== undefined || input.associations !== undefined) {
      invalid("repository association event");
    }
    return {
      type: "agent.repository-associations.changed",
      revision,
      sequence,
      agentId: string(input.agentId, "repository association agent id"),
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
    const query = new URLSearchParams();
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    if (request.cursor !== undefined) query.set("cursor", request.cursor);
    for (const provider of request.filter?.providers ?? []) query.append("provider", provider);
    for (const agentStatus of request.filter?.statuses ?? []) query.append("status", agentStatus);
    if (request.filter?.cwd) query.set("cwd", request.filter.cwd);
    if (request.filter?.text) query.set("q", request.filter.text);
    if (request.filter?.view) query.set("view", request.filter.view);
    if (request.sort) {
      query.set("sort", wireSorts[request.sort.field]);
      query.set("direction", request.sort.direction);
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await channel.request({ path: `/v1/agents${suffix}`, ...(options?.signal ? { signal: options.signal } : {}) });
    const body = record(response.body, "agent list response");
    assertVersion(body);
    if (!Array.isArray(body.agents)) invalid("agent list");
    const page = record(body.page, "agent page");
    const nextCursor = optionalString(page.nextCursor);
    const revision = nonNegativeInteger(body.revision, "snapshot revision");
    const sort = snapshotSort(page);
    const facets = snapshotFacets(body.facets, revision);
    return {
      agents: body.agents.map(summary),
      revision,
      total: nonNegativeInteger(page.total, "agent total"),
      ...(nextCursor ? { nextCursor } : {}),
      ...(sort ? { sort } : {}),
      ...(facets ? { facets } : {}),
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

  async repositoryCapability(channel: HttpChannel, options?: RequestOptions): Promise<RepositoryAssociationCapability | undefined> {
    try {
      const response = await channel.request({ path: "/v1/capabilities", ...(options?.signal ? { signal: options.signal } : {}) });
      const body = record(response.body, "capabilities response");
      assertVersion(body);
      const capabilities = record(body.capabilities, "capabilities");
      if (capabilities.repositoryAssociations === undefined) return undefined;
      const capability = record(capabilities.repositoryAssociations, "repository association capability");
      if (optionalString(capability.status) !== "supported" || !Array.isArray(capability.versions)) return undefined;
      const versions = capability.versions.filter((value): value is string => typeof value === "string");
      if (!versions.includes(REPOSITORY_ASSOCIATION_VERSION)) return undefined;
      return {
        versions,
        maxItems: typeof capability.maxItems === "number"
          ? nonNegativeInteger(capability.maxItems, "repository association max items")
          : MAX_REPOSITORY_ASSOCIATIONS,
        replay: capability.replay === true,
      };
    } catch (error) {
      const failure = toAgentHostError(error);
      if (failure.code === "not_found") return undefined;
      throw failure;
    }
  }

  async repositoryContext(channel: HttpChannel, agentId: string, options?: RequestOptions): Promise<RepositoryContextResult> {
    const response = await channel.request({
      path: `/v1/agents/${encodeURIComponent(agentId)}/repository-associations?version=${REPOSITORY_ASSOCIATION_VERSION}`,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const body = record(response.body, "repository association response");
    assertVersion(body);
    return repositoryContextResult(body, agentId);
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
