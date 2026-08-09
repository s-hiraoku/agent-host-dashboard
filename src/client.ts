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
import { canPerform } from "./domain.js";
import { AgentHostError, toAgentHostError } from "./errors.js";
import type { ConnectionObserver, ConnectionOptions, AgentHostConnection } from "./connection.js";
import { connectAgentHost } from "./connection.js";
import type { AgentHostTransport, EventStreamOptions, RequestOptions } from "./transport.js";

export interface AgentHostClient {
  discover(options?: RequestOptions): Promise<ApiInfo>;
  snapshot(request?: AgentPageRequest, options?: RequestOptions): Promise<AgentSnapshot>;
  detail(agentId: string, options?: RequestOptions): Promise<AgentDetail>;
  adapterHealth(options?: RequestOptions): Promise<readonly AdapterHealth[]>;
  action(target: ActionTarget, action: AgentAction, options?: RequestOptions): Promise<AgentActionResult>;
  events(options: EventStreamOptions): AsyncIterable<AgentEvent>;
  connect(observer: ConnectionObserver, options?: ConnectionOptions): AgentHostConnection;
}

export interface AgentHostClientOptions {
  readonly requestTimeoutMs?: number;
  readonly supportedApiVersions: readonly string[];
}

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new DOMException("The request was cancelled.", "AbortError"));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new AgentHostError("timeout", `The request exceeded the ${timeoutMs} ms timeout.`, { retryable: true }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export class DefaultAgentHostClient implements AgentHostClient {
  private readonly requestTimeoutMs: number;
  private readonly supportedApiVersions: ReadonlySet<string>;
  private trustedApiInfo: ApiInfo | undefined;

  constructor(
    private readonly transport: AgentHostTransport,
    options: AgentHostClientOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.supportedApiVersions = new Set(options.supportedApiVersions);
  }

  private async request<T>(operation: (options: RequestOptions) => Promise<T>, options?: RequestOptions): Promise<T> {
    const deadline = combineSignals(options?.signal, this.requestTimeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      if (deadline.signal.aborted) throw toAgentHostError(deadline.signal.reason);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(toAgentHostError(deadline.signal.reason));
        deadline.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      return await Promise.race([operation({ signal: deadline.signal }), aborted]);
    } catch (error) {
      if (deadline.signal.aborted) throw toAgentHostError(deadline.signal.reason);
      throw toAgentHostError(error);
    } finally {
      if (rejectAbort) deadline.signal.removeEventListener("abort", rejectAbort);
      deadline.dispose();
    }
  }

  async discover(options?: RequestOptions): Promise<ApiInfo> {
    if (options?.signal?.aborted) throw toAgentHostError(options.signal.reason);
    if (this.trustedApiInfo) return this.trustedApiInfo;
    const info = await this.request((requestOptions) => this.transport.discover(requestOptions), options);
    if (!this.supportedApiVersions.has(info.apiVersion)) {
      throw new AgentHostError("incompatible_version", `Unsupported agent-host API version: ${info.apiVersion}.`, {
        details: { supported: [...this.supportedApiVersions], received: info.apiVersion },
      });
    }
    this.trustedApiInfo = info;
    return info;
  }

  async snapshot(request: AgentPageRequest = {}, options?: RequestOptions): Promise<AgentSnapshot> {
    await this.discover(options);
    return await this.request((requestOptions) => this.transport.snapshot(request, requestOptions), options);
  }

  async detail(agentId: string, options?: RequestOptions): Promise<AgentDetail> {
    await this.discover(options);
    return await this.request((requestOptions) => this.transport.detail(agentId, requestOptions), options);
  }

  async adapterHealth(options?: RequestOptions): Promise<readonly AdapterHealth[]> {
    await this.discover(options);
    return await this.request((requestOptions) => this.transport.adapterHealth(requestOptions), options);
  }

  async action(target: ActionTarget, action: AgentAction, options?: RequestOptions): Promise<AgentActionResult> {
    if (!canPerform(target.capabilities, action.kind)) {
      throw new AgentHostError("capability_unavailable", `Agent ${target.id} does not support ${action.kind}.`);
    }
    await this.discover(options);
    return await this.request((requestOptions) => this.transport.action(target, action, requestOptions), options);
  }

  async *events(options: EventStreamOptions): AsyncIterable<AgentEvent> {
    await this.discover(options.signal === undefined ? undefined : { signal: options.signal });
    yield* this.transport.events(options);
  }

  connect(observer: ConnectionObserver, options?: ConnectionOptions): AgentHostConnection {
    return connectAgentHost(this, observer, options);
  }
}
