export const agentStatuses = ["unknown", "idle", "working", "blocked", "done", "error"] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export const agentActions = ["prompt", "read", "interrupt", "approve", "reject"] as const;
export type AgentActionKind = (typeof agentActions)[number];

export type AgentCapabilities = Readonly<Partial<Record<AgentActionKind, true>>>;

export interface AgentProvenance {
  readonly source: string;
  readonly confidence?: "low" | "medium" | "high";
  readonly view?: "active" | "recent" | "historical" | "raw";
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: AgentStatus;
  readonly capabilities: AgentCapabilities;
  readonly cwd?: string;
  readonly lastActivityAt?: string;
  readonly project?: string;
  readonly provenance: AgentProvenance;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly kind: "command" | "file";
  readonly summary: string;
  readonly reason?: string;
  readonly command?: string;
  readonly path?: string;
}

export interface AgentDetail extends AgentSummary {
  readonly createdAt?: string;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly publicData?: Readonly<Record<string, unknown>>;
}

export interface AdapterHealth {
  readonly id: string;
  readonly label: string;
  readonly status: "starting" | "healthy" | "degraded" | "unavailable";
  readonly durationMs?: number;
  readonly agentCount?: number;
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface AgentFilter {
  readonly providers?: readonly string[];
  readonly statuses?: readonly AgentStatus[];
  readonly cwd?: string;
  readonly text?: string;
  readonly view?: "active" | "recent" | "historical" | "raw";
}

export interface AgentSort {
  readonly field: "name" | "provider" | "status" | "lastActivityAt";
  readonly direction: "asc" | "desc";
}

export interface AgentPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
  readonly filter?: AgentFilter;
  readonly sort?: AgentSort;
}

export interface AgentSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly revision: number;
  readonly nextCursor?: string;
  readonly total?: number;
}

export interface ApiInfo {
  readonly apiVersion: string;
  readonly serverVersion?: string;
  readonly features: readonly string[];
}

export type AgentAction =
  | { readonly kind: "prompt"; readonly text: string; readonly expectedRevision?: number }
  | { readonly kind: "read"; readonly expectedRevision?: number }
  | { readonly kind: "interrupt"; readonly expectedRevision?: number }
  | { readonly kind: "approve"; readonly approvalId: string; readonly expectedRevision?: number }
  | { readonly kind: "reject"; readonly approvalId: string; readonly expectedRevision?: number };

export interface ActionTarget {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
}

export interface AgentActionResult {
  readonly ok: true;
  readonly actionId: string;
  readonly revision?: number;
  readonly message?: string;
}

export type AgentEvent =
  | { readonly type: "agent.upserted"; readonly revision: number; readonly agent: AgentSummary }
  | { readonly type: "agent.removed"; readonly revision: number; readonly agentId: string }
  | { readonly type: "adapter.health"; readonly revision: number; readonly adapter: AdapterHealth }
  | { readonly type: "action.completed"; readonly revision: number; readonly agentId: string; readonly actionId: string; readonly ok: boolean }
  | { readonly type: "heartbeat"; readonly revision: number };

export function canPerform(capabilities: AgentCapabilities, action: AgentActionKind): boolean {
  return capabilities[action] === true;
}
