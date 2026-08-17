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
import type { RepositoryContextResult } from "../repositories/domain.js";
import type { AgentHostTransport, EventStreamOptions, RequestOptions } from "../transport.js";
import type { HttpChannel } from "./types.js";

export interface RepositoryAssociationCapability {
  readonly versions: readonly string[];
  readonly maxItems: number;
  readonly replay: boolean;
}

/**
 * The only layer allowed to know agent-host endpoint paths and wire fields.
 * The v1 codec implements confirmed agent-host wire fields behind this boundary.
 * UI code must never import or infer those fields directly.
 */
export interface AgentHostWireProtocol {
  discover(channel: HttpChannel, options?: RequestOptions): Promise<ApiInfo>;
  snapshot(channel: HttpChannel, request: AgentPageRequest, options?: RequestOptions): Promise<AgentSnapshot>;
  detail(channel: HttpChannel, agentId: string, options?: RequestOptions): Promise<AgentDetail>;
  adapterHealth(channel: HttpChannel, options?: RequestOptions): Promise<readonly AdapterHealth[]>;
  repositoryCapability(channel: HttpChannel, options?: RequestOptions): Promise<RepositoryAssociationCapability | undefined>;
  repositoryContext(channel: HttpChannel, agentId: string, options?: RequestOptions): Promise<RepositoryContextResult>;
  action(
    channel: HttpChannel,
    target: ActionTarget,
    action: AgentAction,
    options?: RequestOptions,
  ): Promise<AgentActionResult>;
  events(channel: HttpChannel, options: EventStreamOptions): AsyncIterable<AgentEvent>;
}

export class HttpAgentHostTransport implements AgentHostTransport {
  constructor(
    private readonly channel: HttpChannel,
    private readonly protocol: AgentHostWireProtocol,
  ) {}

  discover(options?: RequestOptions) {
    return this.protocol.discover(this.channel, options);
  }

  snapshot(request: AgentPageRequest, options?: RequestOptions) {
    return this.protocol.snapshot(this.channel, request, options);
  }

  detail(agentId: string, options?: RequestOptions) {
    return this.protocol.detail(this.channel, agentId, options);
  }

  adapterHealth(options?: RequestOptions) {
    return this.protocol.adapterHealth(this.channel, options);
  }

  repositoryCapability(options?: RequestOptions) {
    return this.protocol.repositoryCapability(this.channel, options);
  }

  repositoryContext(agentId: string, options?: RequestOptions) {
    return this.protocol.repositoryContext(this.channel, agentId, options);
  }

  action(target: ActionTarget, action: AgentAction, options?: RequestOptions) {
    return this.protocol.action(this.channel, target, action, options);
  }

  events(options: EventStreamOptions) {
    return this.protocol.events(this.channel, options);
  }
}
