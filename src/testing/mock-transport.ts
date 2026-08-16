import type {
  ActionTarget,
  AdapterHealth,
  AgentAction,
  AgentActionResult,
  AgentDetail,
  AgentEvent,
  AgentPageRequest,
  AgentSnapshot,
  AgentStatus,
  ApiInfo,
} from "../domain.js";
import { AgentHostError } from "../errors.js";
import type { AgentHostTransport, EventStreamOptions, RequestOptions } from "../transport.js";
import { createDemoSnapshot, demoAdapterHealth, demoAgents } from "./fixtures.js";

export class MockAgentHostTransport implements AgentHostTransport {
  apiInfo: ApiInfo = { apiVersion: "1", serverVersion: "demo", features: ["events-after-revision", "facets", "sort"] };
  currentSnapshot: AgentSnapshot = createDemoSnapshot();
  readonly details = new Map<string, AgentDetail>(demoAgents.map((agent) => [agent.id, agent]));
  snapshots: AgentSnapshot[] = [];
  health: readonly AdapterHealth[] = demoAdapterHealth;
  eventStreams: Array<readonly AgentEvent[] | AgentHostError> = [];
  eventStreamGate: Promise<void> | undefined;
  holdEventStreams = false;
  activeEventStreams = 0;
  completedEventStreams = 0;
  readonly actions: Array<{ target: ActionTarget; action: AgentAction }> = [];
  actionGate: Promise<void> | undefined;

  async discover(_options?: RequestOptions): Promise<ApiInfo> {
    return this.apiInfo;
  }

  async snapshot(request: AgentPageRequest, _options?: RequestOptions): Promise<AgentSnapshot> {
    const snapshot = this.snapshots.shift() ?? this.currentSnapshot;
    this.currentSnapshot = snapshot;
    const normalizedText = request.filter?.text?.trim().toLocaleLowerCase();
    const matchesText = (agent: AgentSnapshot["agents"][number]) =>
      !normalizedText
      || [agent.name, agent.provider, agent.cwd, agent.project?.name]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase().includes(normalizedText));
    const matchesProvider = (agent: AgentSnapshot["agents"][number]) =>
      !request.filter?.providers || request.filter.providers.includes(agent.provider);
    const matchesStatus = (agent: AgentSnapshot["agents"][number]) =>
      !request.filter?.statuses || request.filter.statuses.includes(agent.status);
    const matchesCwd = (agent: AgentSnapshot["agents"][number]) =>
      !request.filter?.cwd || agent.cwd?.includes(request.filter.cwd);
    const scoped = snapshot.agents.filter((agent) => matchesText(agent) && matchesCwd(agent));
    const agents = scoped.filter((agent) => matchesProvider(agent) && matchesStatus(agent));
    if (request.sort) {
      const { field, direction } = request.sort;
      const attentionPriority = { blocked: 0, error: 1, working: 2, idle: 3, done: 4, unknown: 5 } as const;
      agents.sort((left, right) => {
        const compared =
          field === "status"
            ? attentionPriority[left.status] - attentionPriority[right.status]
            : field === "lastActivityAt"
              ? String(left.lastActivityAt ?? "").localeCompare(String(right.lastActivityAt ?? ""))
              : String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
        return direction === "asc" ? compared : -compared;
      });
    }
    const offset = Number.parseInt(request.cursor ?? "0", 10);
    const limit = request.limit ?? 50;
    const page = agents.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const byStatus: Partial<Record<AgentStatus, number>> = {};
    const byProvider: Record<string, number> = {};
    for (const agent of scoped.filter(matchesProvider)) byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;
    for (const agent of scoped.filter(matchesStatus)) byProvider[agent.provider] = (byProvider[agent.provider] ?? 0) + 1;
    return {
      agents: page,
      revision: snapshot.revision,
      total: agents.length,
      facets: { revision: snapshot.revision, byStatus, byProvider },
      sort: request.sort ?? { field: "status", direction: "asc" },
      ...(nextOffset < agents.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async detail(agentId: string, _options?: RequestOptions): Promise<AgentDetail> {
    const summary = this.currentSnapshot.agents.find((candidate) => candidate.id === agentId);
    if (!summary) throw new AgentHostError("not_found", `Unknown demo agent: ${agentId}.`, { status: 404 });
    const recordedDetail = this.details.get(agentId);
    const recordedApprovals =
      recordedDetail && Array.isArray(recordedDetail.pendingApprovals) ? recordedDetail.pendingApprovals : [];
    return {
      ...recordedDetail,
      ...summary,
      pendingApprovals:
        recordedApprovals.length > 0
          ? recordedApprovals
          : summary.status === "blocked" && summary.capabilities.approve
          ? summary.id === "demo:agent-0008"
            ? [
                {
                  id: `approval-${summary.id}`,
                  kind: "file",
                  summary: "File change request",
                  actionable: true,
                  files: [
                    { path: "src/agent.js", kind: "update" },
                    { path: "test/agent.test.js", kind: "add" },
                  ],
                  fileCount: 2,
                  truncated: false,
                },
              ]
            : [
              {
                id: `approval-${summary.id}`,
                kind: "command",
                summary: "Run the project verification suite",
                reason: "Confirm the selected change before continuing",
                command: "npm run check",
              },
            ]
          : [],
    };
  }

  async adapterHealth(_options?: RequestOptions): Promise<readonly AdapterHealth[]> {
    return this.health;
  }

  async action(target: ActionTarget, action: AgentAction, _options?: RequestOptions): Promise<AgentActionResult> {
    this.actions.push({ target, action });
    await this.actionGate;
    return { ok: true, actionId: `demo-action-${this.actions.length}`, revision: this.currentSnapshot.revision + 1 };
  }

  async *events(options: EventStreamOptions): AsyncIterable<AgentEvent> {
    if (options.signal?.aborted) throw options.signal.reason;
    this.activeEventStreams += 1;
    try {
      await this.eventStreamGate;
      if (options.signal?.aborted) throw options.signal.reason;
      const stream = this.eventStreams.shift() ?? [];
      if (stream instanceof AgentHostError) throw stream;
      for (const event of stream) {
        if (options.signal?.aborted) throw options.signal.reason;
        const isAfterCursor =
          event.sequence === undefined
            ? event.revision > options.afterRevision
            : event.revision >= options.afterRevision;
        if (isAfterCursor) yield event;
      }
      if (this.holdEventStreams && options.signal) {
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) resolve();
          else options.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      this.activeEventStreams -= 1;
      this.completedEventStreams += 1;
    }
  }
}
