import type {
  ActionTarget,
  AdapterHealth,
  AgentAction,
  AgentActionResult,
  AgentDetail,
  AgentEvent,
  AgentPageRequest,
  AgentSnapshot,
  ApiInfo,
} from "../domain.js";
import { AgentHostError } from "../errors.js";
import type { AgentHostTransport, EventStreamOptions, RequestOptions } from "../transport.js";
import { createDemoSnapshot, demoAdapterHealth } from "./fixtures.js";

export class MockAgentHostTransport implements AgentHostTransport {
  apiInfo: ApiInfo = { apiVersion: "1", serverVersion: "demo", features: ["events-after-revision"] };
  currentSnapshot: AgentSnapshot = createDemoSnapshot();
  snapshots: AgentSnapshot[] = [];
  health: readonly AdapterHealth[] = demoAdapterHealth;
  eventStreams: Array<readonly AgentEvent[] | AgentHostError> = [];
  readonly actions: Array<{ target: ActionTarget; action: AgentAction }> = [];

  async discover(_options?: RequestOptions): Promise<ApiInfo> {
    return this.apiInfo;
  }

  async snapshot(_request: AgentPageRequest, _options?: RequestOptions): Promise<AgentSnapshot> {
    const snapshot = this.snapshots.shift() ?? this.currentSnapshot;
    this.currentSnapshot = snapshot;
    return snapshot;
  }

  async detail(agentId: string, _options?: RequestOptions): Promise<AgentDetail> {
    const agent = this.currentSnapshot.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new AgentHostError("not_found", `Unknown demo agent: ${agentId}.`, { status: 404 });
    return {
      ...agent,
      pendingApprovals: "pendingApprovals" in agent && Array.isArray(agent.pendingApprovals) ? agent.pendingApprovals : [],
    };
  }

  async adapterHealth(_options?: RequestOptions): Promise<readonly AdapterHealth[]> {
    return this.health;
  }

  async action(target: ActionTarget, action: AgentAction, _options?: RequestOptions): Promise<AgentActionResult> {
    this.actions.push({ target, action });
    return { ok: true, actionId: `demo-action-${this.actions.length}`, revision: this.currentSnapshot.revision + 1 };
  }

  async *events(options: EventStreamOptions): AsyncIterable<AgentEvent> {
    if (options.signal?.aborted) throw options.signal.reason;
    const stream = this.eventStreams.shift() ?? [];
    if (stream instanceof AgentHostError) throw stream;
    for (const event of stream) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (event.revision > options.afterRevision) yield event;
    }
  }
}
