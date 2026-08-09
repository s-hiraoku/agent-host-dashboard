import type { AgentHostClient } from "../client.js";
import { AgentHostError, toAgentHostError } from "../errors.js";

export interface ClientLease {
  readonly client: AgentHostClient;
  close(): void;
}

export interface ClientConnectionInput {
  readonly baseUrl: string;
  readonly credential: () => string | undefined;
}

export interface ClientConnector {
  open(input: ClientConnectionInput, signal: AbortSignal): Promise<ClientLease>;
}

export type SessionFailure = "unavailable" | "unauthorized" | "incompatible" | "error";

export function classifySessionFailure(error: unknown): { readonly kind: SessionFailure; readonly message: string } {
  const failure = toAgentHostError(error);
  if (failure.code === "unauthorized") return { kind: "unauthorized", message: failure.message };
  if (failure.code === "incompatible_version") return { kind: "incompatible", message: failure.message };
  if (failure.code === "connection_failed" || failure.code === "timeout") {
    return { kind: "unavailable", message: failure.message };
  }
  return { kind: "error", message: failure.message };
}

export class MemoryCredentialVault {
  #credential: string | undefined;

  replace(credential: string | undefined): void {
    this.#credential = credential?.trim() ? credential : undefined;
  }

  read = (): string | undefined => this.#credential;

  clear(): void {
    this.#credential = undefined;
  }
}

export function assertOpenSession(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentHostError("connection_failed", "The connection attempt was cancelled.", { cause: signal.reason });
  }
}
