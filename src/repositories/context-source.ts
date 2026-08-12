import type { RequestOptions } from "../transport.js";
import type { RepositoryContextResult } from "./domain.js";

export interface RepositoryContextSource {
  forAgent(agentId: string, options?: RequestOptions): Promise<RepositoryContextResult>;
}
