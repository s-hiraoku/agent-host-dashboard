export type AgentHostErrorCode =
  | "aborted"
  | "capability_unavailable"
  | "connection_failed"
  | "incompatible_version"
  | "invalid_response"
  | "not_found"
  | "rate_limited"
  | "revision_gap"
  | "timeout"
  | "unauthorized"
  | "unsupported"
  | "unknown";

export interface AgentHostErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class AgentHostError extends Error {
  readonly code: AgentHostErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: AgentHostErrorCode, message: string, options: AgentHostErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AgentHostError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export function toAgentHostError(error: unknown): AgentHostError {
  if (error instanceof AgentHostError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AgentHostError("aborted", "The request was cancelled.", { cause: error });
  }
  return new AgentHostError("unknown", error instanceof Error ? error.message : "An unknown error occurred.", {
    cause: error,
  });
}
