import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentHostClient } from "../client.js";
import type { ConnectionState } from "../connection.js";
import type {
  AdapterHealth,
  AgentAction,
  AgentActionResult,
  AgentDetail,
  AgentEvent,
  AgentPageRequest,
  AgentSnapshot,
  AgentSort,
  AgentStatus,
  AgentSummary,
} from "../domain.js";
import { toAgentHostError } from "../errors.js";
import { applyVisibleEvent, reconcileVisibleEvents } from "./use-cases.js";

const pageSize = 50;

export interface DashboardQuery {
  readonly text: string;
  readonly status: AgentStatus | "all";
  readonly provider: string;
  readonly sort: AgentSort;
}

export interface DashboardModel {
  readonly snapshot: AgentSnapshot | undefined;
  readonly detail: AgentDetail | undefined;
  readonly health: readonly AdapterHealth[];
  readonly connection: ConnectionState;
  readonly events: readonly AgentEvent[];
  readonly query: DashboardQuery;
  readonly selectedId: string | undefined;
  readonly page: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly actionResult: AgentActionResult | undefined;
  setQuery(query: DashboardQuery): void;
  select(agentId: string): void;
  nextPage(): void;
  previousPage(): void;
  refresh(): Promise<void>;
  perform(target: AgentDetail, action: AgentAction): Promise<AgentActionResult>;
}

function requestFor(query: DashboardQuery, cursor: string | undefined): AgentPageRequest {
  return {
    limit: pageSize,
    ...(cursor === undefined ? {} : { cursor }),
    filter: {
      ...(query.text.trim() ? { text: query.text.trim() } : {}),
      ...(query.status === "all" ? {} : { statuses: [query.status] }),
      ...(query.provider ? { providers: [query.provider] } : {}),
    },
    sort: query.sort,
  };
}

function matchesQuery(agent: AgentSummary, query: DashboardQuery): boolean {
  const text = query.text.trim().toLocaleLowerCase();
  return (
    (query.status === "all" || agent.status === query.status) &&
    (!query.provider || agent.provider === query.provider) &&
    (!text || [agent.name, agent.provider, agent.cwd, agent.project].some((value) => value?.toLocaleLowerCase().includes(text)))
  );
}

export function useDashboard(client: AgentHostClient): DashboardModel {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [detail, setDetail] = useState<AgentDetail>();
  const [health, setHealth] = useState<readonly AdapterHealth[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting", attempt: 0 });
  const [events, setEvents] = useState<readonly AgentEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQueryState] = useState<DashboardQuery>({
    text: "",
    status: "all",
    provider: "",
    sort: { field: "status", direction: "asc" },
  });
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionResult, setActionResult] = useState<AgentActionResult>();
  const queryRef = useRef(query);
  const cursorRef = useRef<string | undefined>(undefined);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const eventBuffer = useRef<readonly AgentEvent[]>([]);

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    try {
      const [nextSnapshot, nextHealth] = await Promise.all([
        client.snapshot(requestFor(queryRef.current, cursorRef.current), { signal: controller.signal }),
        client.adapterHealth({ signal: controller.signal }),
      ]);
      if (generation !== requestGeneration.current) return;
      const reconciledSnapshot = reconcileVisibleEvents(
        nextSnapshot,
        eventBuffer.current,
        (agent) => matchesQuery(agent, queryRef.current),
      );
      setSnapshot(reconciledSnapshot);
      setHealth(nextHealth);
      setError(undefined);
      setSelectedId((current) => current ?? nextSnapshot.agents[0]?.id);
    } catch (failure) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setError(toAgentHostError(failure).message);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    let active = true;
    const hostConnection = client.connect({
      onState: (value) => {
        if (active) {
          setConnection(value);
          if (value.status === "connected") setError(undefined);
        }
      },
      onSnapshot: () => {
        if (active) void load();
      },
      onEvent: (event) => {
        if (!active) return;
        eventBuffer.current = [...eventBuffer.current, event].slice(-500);
        setEvents((current) => [event, ...current].slice(0, 100));
        setSnapshot((current) =>
          current ? applyVisibleEvent(current, event, (agent) => matchesQuery(agent, queryRef.current)) : current,
        );
        if (event.type === "adapter.health") {
          setHealth((current) => [event.adapter, ...current.filter((adapter) => adapter.id !== event.adapter.id)]);
        }
      },
      onError: (failure) => {
        if (active) setError(failure.message);
      },
    });
    return () => {
      active = false;
      hostConnection.close();
    };
  }, [client, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    const controller = new AbortController();
    void client
      .detail(selectedId, { signal: controller.signal })
      .then(setDetail)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(toAgentHostError(failure).message);
      });
    return () => controller.abort();
  }, [client, selectedId, snapshot?.revision]);

  const setQuery = useCallback(
    (nextQuery: DashboardQuery) => {
      queryRef.current = nextQuery;
      cursorRef.current = undefined;
      setQueryState(nextQuery);
      setCursors([undefined]);
      setPage(0);
      void load();
    },
    [load],
  );

  const nextPage = useCallback(() => {
    if (!snapshot?.nextCursor) return;
    const nextPage = page + 1;
    cursorRef.current = snapshot.nextCursor;
    setCursors((current) => [...current.slice(0, nextPage), snapshot.nextCursor]);
    setPage(nextPage);
    void load();
  }, [load, page, snapshot?.nextCursor]);

  const previousPage = useCallback(() => {
    if (page === 0) return;
    const nextPage = page - 1;
    cursorRef.current = cursors[nextPage];
    setPage(nextPage);
    void load();
  }, [cursors, load, page]);

  const perform = useCallback(
    async (target: AgentDetail, action: AgentAction) => {
      const result = await client.action({ id: target.id, capabilities: target.capabilities }, action);
      setActionResult(result);
      return result;
    },
    [client],
  );

  return useMemo(
    () => ({
      snapshot,
      detail,
      health,
      connection,
      events,
      query,
      selectedId,
      page,
      hasPrevious: page > 0,
      hasNext: Boolean(snapshot?.nextCursor),
      loading,
      error,
      actionResult,
      setQuery,
      select: setSelectedId,
      nextPage,
      previousPage,
      refresh: load,
      perform,
    }),
    [
      actionResult,
      connection,
      detail,
      error,
      events,
      health,
      load,
      loading,
      nextPage,
      page,
      perform,
      previousPage,
      query,
      selectedId,
      snapshot,
    ],
  );
}
