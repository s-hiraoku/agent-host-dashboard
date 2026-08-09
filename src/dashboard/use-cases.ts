import type { AgentEvent, AgentSnapshot, AgentStatus, AgentSummary } from "../domain.js";

export const statusOrder: readonly AgentStatus[] = ["blocked", "error", "working", "idle", "done", "unknown"];

export interface StatusMetric {
  readonly status: AgentStatus;
  readonly count: number;
  readonly urgent: boolean;
}

export function statusMetrics(snapshot: AgentSnapshot | undefined): readonly StatusMetric[] {
  return statusOrder.map((status) => ({
    status,
    count:
      snapshot?.facets?.byStatus[status] ?? snapshot?.agents.filter((agent) => agent.status === status).length ?? 0,
    urgent: status === "blocked" || status === "error",
  }));
}

export function providerMetrics(snapshot: AgentSnapshot | undefined): readonly [string, number][] {
  if (snapshot?.facets) {
    return Object.entries(snapshot.facets.byProvider).sort((left, right) => right[1] - left[1]);
  }
  const counts = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) counts.set(agent.provider, (counts.get(agent.provider) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]);
}

function updateVisibleFacets(
  snapshot: AgentSnapshot,
  previous: AgentSummary,
  next: AgentSummary | undefined,
): AgentSnapshot["facets"] {
  if (!snapshot.facets) return undefined;
  const byStatus: Partial<Record<AgentStatus, number>> = { ...snapshot.facets.byStatus };
  const byProvider: Record<string, number> = { ...snapshot.facets.byProvider };
  byStatus[previous.status] = Math.max(0, (byStatus[previous.status] ?? 0) - 1);
  byProvider[previous.provider] = Math.max(0, (byProvider[previous.provider] ?? 0) - 1);
  if (next) {
    byStatus[next.status] = (byStatus[next.status] ?? 0) + 1;
    byProvider[next.provider] = (byProvider[next.provider] ?? 0) + 1;
  }
  return { byStatus, byProvider };
}

export function applyVisibleEvent(
  snapshot: AgentSnapshot,
  event: AgentEvent,
  matches: (agent: AgentSummary) => boolean = () => true,
): AgentSnapshot {
  if (event.revision <= snapshot.revision) return snapshot;
  if (event.type === "agent.upserted") {
    const index = snapshot.agents.findIndex((agent) => agent.id === event.agent.id);
    if (index === -1) return { ...snapshot, revision: event.revision };
    const agents = [...snapshot.agents];
    const previous = agents[index]!;
    if (!matches(event.agent)) {
      agents.splice(index, 1);
      const facets = updateVisibleFacets(snapshot, previous, undefined);
      return {
        ...snapshot,
        agents,
        revision: event.revision,
        ...(snapshot.total === undefined ? {} : { total: Math.max(0, snapshot.total - 1) }),
        ...(facets === undefined ? {} : { facets }),
      };
    }
    agents[index] = event.agent;
    const facets = updateVisibleFacets(snapshot, previous, event.agent);
    return { ...snapshot, agents, revision: event.revision, ...(facets === undefined ? {} : { facets }) };
  }
  if (event.type === "agent.removed") {
    return {
      ...snapshot,
      agents: snapshot.agents.filter((agent) => agent.id !== event.agentId),
      revision: event.revision,
    };
  }
  return { ...snapshot, revision: event.revision };
}

export function findAttentionAgent(agents: readonly AgentSummary[]): AgentSummary | undefined {
  return [...agents].sort((left, right) => {
    const status = statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status);
    if (status !== 0) return status;
    return String(right.lastActivityAt ?? "").localeCompare(String(left.lastActivityAt ?? ""));
  })[0];
}

export function formatActivity(value: string | undefined, now = Date.now()): string {
  if (!value) return "No activity";
  const delta = Math.max(0, now - Date.parse(value));
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1_000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
