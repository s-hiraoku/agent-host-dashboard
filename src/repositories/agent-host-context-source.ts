import type { AgentHostWireProtocol } from "../http/protocol.js";
import type { HttpChannel } from "../http/types.js";
import { toAgentHostError } from "../errors.js";
import type { RequestOptions } from "../transport.js";
import type { RepositoryContextSource } from "./context-source.js";
import type { RepositoryContextResult } from "./domain.js";

export class AgentHostRepositoryContextSource implements RepositoryContextSource {
  private capabilityProbe: Promise<boolean> | undefined;

  constructor(
    private readonly channel: HttpChannel,
    private readonly protocol: AgentHostWireProtocol,
  ) {}

  private hostSupported(): Promise<boolean> {
    this.capabilityProbe ??= this.protocol.repositoryCapability(this.channel)
      .then((capability) => capability !== undefined)
      .catch((error: unknown) => {
        this.capabilityProbe = undefined;
        throw error;
      });
    return this.capabilityProbe;
  }

  async forAgent(agentId: string, options?: RequestOptions): Promise<RepositoryContextResult> {
    if (options?.signal?.aborted) throw toAgentHostError(options.signal.reason);
    try {
      if (!await this.hostSupported()) {
        return { state: "unsupported", reason: "Host does not publish repository associations." };
      }
      return await this.protocol.repositoryContext(this.channel, agentId, options);
    } catch (error) {
      const failure = toAgentHostError(error);
      if (failure.code === "aborted") throw failure;
      if (failure.code === "not_found") {
        return { state: "unavailable", reason: "The selected agent was not found.", retryable: false };
      }
      return {
        state: "unavailable",
        reason: failure.message,
        retryable: failure.retryable || failure.code === "unauthorized" || failure.code === "rate_limited",
      };
    }
  }
}
