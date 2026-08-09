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
} from "./domain.js";

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface EventStreamOptions extends RequestOptions {
  readonly afterRevision: number;
}

export interface AgentHostTransport {
  discover(options?: RequestOptions): Promise<ApiInfo>;
  snapshot(request: AgentPageRequest, options?: RequestOptions): Promise<AgentSnapshot>;
  detail(agentId: string, options?: RequestOptions): Promise<AgentDetail>;
  adapterHealth(options?: RequestOptions): Promise<readonly AdapterHealth[]>;
  action(target: ActionTarget, action: AgentAction, options?: RequestOptions): Promise<AgentActionResult>;
  events(options: EventStreamOptions): AsyncIterable<AgentEvent>;
}
