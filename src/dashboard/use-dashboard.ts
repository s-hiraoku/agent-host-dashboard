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
  ApiInfo,
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
  readonly apiInfo: ApiInfo | undefined;
  readonly snapshot: AgentSnapshot | undefined;
  readonly detail: AgentDetail | undefined;
  readonly health: readonly AdapterHealth[];
  readonly connection: ConnectionState;
  readonly events: readonly AgentEvent[];
  readonly notificationEvents: readonly AgentEvent[];
  readonly query: DashboardQuery;
  readonly selectedId: string | undefined;
  readonly page: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly actionResult: AgentActionResult | undefined;
  readonly actionHistory: readonly DashboardActionRecord[];
  setQuery(query: DashboardQuery): void;
  select(agentId: string): void;
  nextPage(): void;
  previousPage(): void;
  refresh(): Promise<void>;
  perform(target: AgentDetail, action: AgentAction): Promise<AgentActionResult>;
  clearActionHistory(): void;
}

export interface DashboardActionRecord {
  readonly id: string;
  readonly occurredAt: string;
  readonly agentName: string;
  readonly kind: AgentAction["kind"];
  readonly outcome: "completed" | "failed";
  readonly errorCode?: string;
}

export interface DashboardOptions {
  readonly initialQuery?: DashboardQuery;
  readonly onQueryChange?: (query: DashboardQuery) => void;
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

export function useDashboard(client: AgentHostClient, options: DashboardOptions = {}): DashboardModel {
  const [apiInfo, setApiInfo] = useState<ApiInfo>();
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [detail, setDetail] = useState<AgentDetail>();
  const [health, setHealth] = useState<readonly AdapterHealth[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({ status: "connecting", attempt: 0 });
  const [events, setEvents] = useState<readonly AgentEvent[]>([]);
  const [notificationEvents, setNotificationEvents] = useState<readonly AgentEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQueryState] = useState<DashboardQuery>(options.initialQuery ?? {
    text: "",
    status: "all",
    provider: "",
    sort: { field: "status", direction: "asc" },
  });
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [actionResult, setActionResult] = useState<AgentActionResult>();
  const [actionHistory, setActionHistory] = useState<readonly DashboardActionRecord[]>([]);
  const actionSequence = useRef(0);
  const queryRef = useRef(query);
  const cursorRef = useRef<string | undefined>(undefined);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const eventBuffer = useRef<readonly AgentEvent[]>([]);
  const knownStatuses = useRef(new Map<string, AgentStatus>());
  const snapshotReady = useRef(false);

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    try {
      const [nextApiInfo, nextSnapshot, nextHealth] = await Promise.all([
        client.discover({ signal: controller.signal }),
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
      for (const agent of reconciledSnapshot.agents) knownStatuses.current.set(agent.id, agent.status);
      snapshotReady.current = true;
      setApiInfo(nextApiInfo);
      setHealth(nextHealth);
      setOperationError(undefined);
      setSelectedId((current) => current ?? nextSnapshot.agents[0]?.id);
    } catch (failure) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setOperationError(toAgentHostError(failure).message);
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
          if (value.status === "connected") setConnectionError(undefined);
        }
      },
      onSnapshot: (authoritativeSnapshot) => {
        if (active) {
          knownStatuses.current = new Map(authoritativeSnapshot.agents.map((agent) => [agent.id, agent.status]));
          snapshotReady.current = true;
          void load();
        }
      },
      onEvent: (event) => {
        if (!active) return;
        if (event.type === "agent.upserted") {
          const previousStatus = knownStatuses.current.get(event.agent.id);
          knownStatuses.current.set(event.agent.id, event.agent.status);
          const attentionStatus = event.agent.status === "blocked" || event.agent.status === "done" || event.agent.status === "error";
          if (snapshotReady.current && previousStatus !== undefined && attentionStatus && previousStatus !== event.agent.status) {
            setNotificationEvents((current) => [event, ...current].slice(0, 100));
          }
        } else if (event.type === "agent.removed") {
          knownStatuses.current.delete(event.agentId);
        }
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
        if (active) setConnectionError(failure.message);
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
      .then((value) => {
        setDetail(value);
        setOperationError(undefined);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setOperationError(toAgentHostError(failure).message);
      });
    return () => controller.abort();
  }, [client, selectedId, snapshot?.revision]);

  const setQuery = useCallback(
    (nextQuery: DashboardQuery) => {
      queryRef.current = nextQuery;
      options.onQueryChange?.(nextQuery);
      cursorRef.current = undefined;
      setQueryState(nextQuery);
      setCursors([undefined]);
      setPage(0);
      void load();
    },
    [load, options.onQueryChange],
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
      actionSequence.current += 1;
      const base = {
        id: `action-${actionSequence.current}`,
        occurredAt: new Date().toISOString(),
        agentName: target.name,
        kind: action.kind,
      } as const;
      try {
        const result = await client.action({ id: target.id, capabilities: target.capabilities }, action);
        setActionResult(result);
        const record: DashboardActionRecord = { ...base, outcome: "completed" };
        setActionHistory((current) => [record, ...current].slice(0, 100));
        return result;
      } catch (error) {
        const failure = toAgentHostError(error);
        const record: DashboardActionRecord = { ...base, outcome: "failed", errorCode: failure.code };
        setActionHistory((current) => [record, ...current].slice(0, 100));
        throw error;
      }
    },
    [client],
  );

  return useMemo(
    () => ({
      apiInfo,
      snapshot,
      detail,
      health,
      connection,
      events,
      notificationEvents,
      query,
      selectedId,
      page,
      hasPrevious: page > 0,
      hasNext: Boolean(snapshot?.nextCursor),
      loading,
      error: operationError ?? connectionError,
      actionResult,
      actionHistory,
      setQuery,
      select: setSelectedId,
      nextPage,
      previousPage,
      refresh: load,
      perform,
      clearActionHistory: () => setActionHistory([]),
    }),
    [
      actionResult,
      actionHistory,
      apiInfo,
      connection,
      detail,
      connectionError,
      events,
      health,
      load,
      loading,
      nextPage,
      notificationEvents,
      operationError,
      page,
      perform,
      previousPage,
      query,
      selectedId,
      snapshot,
    ],
  );
}
