import type { AgentEvent, AgentSnapshot, AgentStatus, AgentSummary } from "../domain.js";
import { AgentHostError } from "../errors.js";

export const statusOrder: readonly AgentStatus[] = ["blocked", "error", "working", "idle", "done", "unknown"];

export interface StatusMetric {
  readonly status: AgentStatus;
  readonly count: number | undefined;
  readonly urgent: boolean;
}

export interface BoundedEventBuffer {
  readonly entries: readonly { readonly ordinal: number; readonly event: AgentEvent }[];
  readonly droppedThroughOrdinal: number;
}

export function appendBoundedEvent(
  buffer: BoundedEventBuffer,
  ordinal: number,
  event: AgentEvent,
  limit = 500,
): BoundedEventBuffer {
  const entries = [...buffer.entries, { ordinal, event }];
  const overflow = Math.max(0, entries.length - limit);
  return {
    entries: overflow ? entries.slice(overflow) : entries,
    droppedThroughOrdinal: overflow ? entries[overflow - 1]!.ordinal : buffer.droppedThroughOrdinal,
  };
}

export function replayableEvents(buffer: BoundedEventBuffer, afterOrdinal: number): readonly AgentEvent[] {
  if (buffer.droppedThroughOrdinal > afterOrdinal) {
    throw new AgentHostError(
      "revision_gap",
      "Live updates outpaced the bounded snapshot replay buffer. Refresh to resynchronize.",
      { retryable: true },
    );
  }
  return buffer.entries.filter((entry) => entry.ordinal > afterOrdinal).map((entry) => entry.event);
}

export function statusMetrics(snapshot: AgentSnapshot | undefined): readonly StatusMetric[] {
  const completePage = snapshot !== undefined && snapshot.total === snapshot.agents.length;
  return statusOrder.map((status) => ({
    status,
    count: snapshot?.facets?.byStatus[status]
      ?? (completePage ? snapshot.agents.filter((agent) => agent.status === status).length : undefined),
    urgent: status === "blocked" || status === "error",
  }));
}

export function providerMetrics(snapshot: AgentSnapshot | undefined): readonly (readonly [string, number | undefined])[] {
  if (snapshot?.facets) {
    return Object.entries(snapshot.facets.byProvider)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }
  const counts = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) counts.set(agent.provider, (counts.get(agent.provider) ?? 0) + 1);
  const completePage = snapshot !== undefined && snapshot.total === snapshot.agents.length;
  return [...counts]
    .map(([provider, count]) => [provider, completePage ? count : undefined] as const)
    .sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]));
}

function eventMetadata(event: AgentEvent): Pick<AgentSnapshot, "revision" | "eventSequence"> {
  return {
    revision: event.revision,
    ...(event.sequence === undefined ? {} : { eventSequence: event.sequence }),
  };
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
  return { byStatus, byProvider, ...(snapshot.facets.revision === undefined ? {} : { revision: snapshot.facets.revision }) };
}

function invalidateFacets(snapshot: AgentSnapshot, event: AgentEvent, totalDelta = 0): AgentSnapshot {
  const { facets: _facets, ...withoutFacets } = snapshot;
  return {
    ...withoutFacets,
    ...eventMetadata(event),
    ...(snapshot.total === undefined ? {} : { total: Math.max(0, snapshot.total + totalDelta) }),
  };
}

export function applyVisibleEvent(
  snapshot: AgentSnapshot,
  event: AgentEvent,
  matches: (agent: AgentSummary) => boolean = () => true,
): AgentSnapshot {
  if (event.sequence !== undefined) {
    if (snapshot.eventSequence !== undefined && event.sequence <= snapshot.eventSequence) return snapshot;
    if (event.revision < snapshot.revision) return snapshot;
  } else if (event.revision <= snapshot.revision) return snapshot;
  if (event.type === "agent.upserted") {
    const index = snapshot.agents.findIndex((agent) => agent.id === event.agent.id);
    if (index === -1) return invalidateFacets(snapshot, event);
    const agents = [...snapshot.agents];
    const previous = agents[index]!;
    if (!matches(event.agent)) {
      agents.splice(index, 1);
      const facets = updateVisibleFacets(snapshot, previous, undefined);
      return {
        ...snapshot,
        agents,
        ...eventMetadata(event),
        ...(snapshot.total === undefined ? {} : { total: Math.max(0, snapshot.total - 1) }),
        ...(facets === undefined ? {} : { facets }),
      };
    }
    agents[index] = event.agent;
    const facets = updateVisibleFacets(snapshot, previous, event.agent);
    return { ...snapshot, agents, ...eventMetadata(event), ...(facets === undefined ? {} : { facets }) };
  }
  if (event.type === "agent.removed") {
    const previous = snapshot.agents.find((agent) => agent.id === event.agentId);
    if (!previous) return invalidateFacets(snapshot, event, -1);
    const facets = updateVisibleFacets(snapshot, previous, undefined);
    return {
      ...snapshot,
      agents: snapshot.agents.filter((agent) => agent.id !== event.agentId),
      ...eventMetadata(event),
      ...(snapshot.total === undefined ? {} : { total: Math.max(0, snapshot.total - 1) }),
      ...(facets === undefined ? {} : { facets }),
    };
  }
  return { ...snapshot, ...eventMetadata(event) };
}

export function reconcileVisibleEvents(
  snapshot: AgentSnapshot,
  events: readonly AgentEvent[],
  matches: (agent: AgentSummary) => boolean = () => true,
): AgentSnapshot {
  return events
    .filter((event) => event.revision > snapshot.revision)
    .sort((left, right) =>
      left.revision - right.revision
      || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER))
    .reduce((current, event) => applyVisibleEvent(current, event, matches), snapshot);
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
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "No activity";
  const delta = Math.max(0, now - parsed);
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1_000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
