import type { AgentSort, AgentStatus } from "../domain.js";
import { localProjectIdPattern } from "../domain.js";
import { normalizeAgentHostBaseUrl } from "../http/fetch-channel.js";

export const preferenceStorageKey = "agent-host-dashboard.preferences";

export const densities = ["compact", "comfortable"] as const;
export type Density = (typeof densities)[number];
export const agentColumns = ["provider", "project", "activity"] as const;
export type AgentColumn = (typeof agentColumns)[number];

export interface PersistedQuery {
  readonly status: AgentStatus | "all";
  readonly provider: string;
  readonly sort: AgentSort;
}

export interface SavedView extends PersistedQuery {
  readonly id: string;
  readonly name: string;
}

export interface DashboardPreferences {
  readonly version: 4;
  readonly endpoint: string;
  readonly density: Density;
  readonly columns: readonly AgentColumn[];
  readonly query: PersistedQuery;
  readonly savedViews: readonly SavedView[];
  readonly notifications: NotificationPreferences;
}

export interface NotificationPreferences {
  readonly enabled: boolean;
  readonly blocked: boolean;
  readonly completed: boolean;
  readonly error: boolean;
  readonly suppressedProjectIds: readonly string[];
}

export interface PreferenceStore {
  load(): DashboardPreferences;
  save(preferences: DashboardPreferences): void;
  clear(): void;
}

const statuses = new Set<AgentStatus | "all">(["all", "unknown", "idle", "working", "blocked", "done", "error"]);
const sortFields = new Set<AgentSort["field"]>(["name", "provider", "status", "lastActivityAt"]);
const sortDirections = new Set<AgentSort["direction"]>(["asc", "desc"]);
const defaultSort: AgentSort = { field: "status", direction: "asc" };

export const defaultPreferences: DashboardPreferences = {
  version: 4,
  endpoint: "http://127.0.0.1:4777/",
  density: "comfortable",
  columns: [...agentColumns],
  query: { status: "all", provider: "", sort: defaultSort },
  savedViews: [],
  notifications: { enabled: false, blocked: true, completed: true, error: true, suppressedProjectIds: [] },
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.length <= maximum ? value : "";
}

function safeSort(value: unknown): AgentSort {
  const input = record(value);
  const field = input?.field;
  const direction = input?.direction;
  return typeof field === "string" && sortFields.has(field as AgentSort["field"])
    && typeof direction === "string" && sortDirections.has(direction as AgentSort["direction"])
    ? { field: field as AgentSort["field"], direction: direction as AgentSort["direction"] }
    : defaultSort;
}

function safeQuery(value: unknown): PersistedQuery {
  const input = record(value);
  const status = input?.status;
  return {
    status: typeof status === "string" && statuses.has(status as AgentStatus | "all") ? status as AgentStatus | "all" : "all",
    provider: safeText(input?.provider, 100),
    sort: safeSort(input?.sort),
  };
}

function safeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) return defaultPreferences.endpoint;
  try {
    return normalizeAgentHostBaseUrl(value);
  } catch {
    return defaultPreferences.endpoint;
  }
}

function safeSavedViews(value: unknown): readonly SavedView[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const views: SavedView[] = [];
  for (const candidate of value.slice(0, 12)) {
    const input = record(candidate);
    const id = safeText(input?.id, 64);
    const name = safeText(input?.name, 40).trim();
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !name || ids.has(id)) continue;
    ids.add(id);
    views.push({ id, name, ...safeQuery(input) });
  }
  return views;
}

function safeProjectIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, 50)) {
    if (typeof candidate === "string" && localProjectIdPattern().test(candidate)) ids.add(candidate);
  }
  return [...ids];
}

export function sanitizePreferences(value: unknown): DashboardPreferences {
  const input = record(value);
  if (!input || (input.version !== 1 && input.version !== 2 && input.version !== 3 && input.version !== 4)) return defaultPreferences;
  const columns = Array.isArray(input.columns)
    ? [...new Set(input.columns.filter((column): column is AgentColumn =>
      typeof column === "string" && agentColumns.includes(column as AgentColumn),
    ))]
    : [...agentColumns];
  const density = typeof input.density === "string" && densities.includes(input.density as Density)
    ? input.density as Density
    : defaultPreferences.density;
  const notifications = input.version === 3 || input.version === 4
    ? {
        enabled: record(input.notifications)?.enabled === true,
        blocked: record(input.notifications)?.blocked !== false,
        completed: record(input.notifications)?.completed !== false,
        error: record(input.notifications)?.error !== false,
        suppressedProjectIds: input.version === 4 ? safeProjectIds(record(input.notifications)?.suppressedProjectIds) : [],
      }
    : defaultPreferences.notifications;
  return {
    version: 4,
    endpoint: safeEndpoint(input.endpoint),
    density,
    columns,
    query: safeQuery(input.query),
    savedViews: input.version === 2 || input.version === 3 || input.version === 4 ? safeSavedViews(input.savedViews) : [],
    notifications,
  };
}

export class LocalPreferenceStore implements PreferenceStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage) {}

  load(): DashboardPreferences {
    try {
      const serialized = this.storage.getItem(preferenceStorageKey);
      if (!serialized || serialized.length > 32_768) return defaultPreferences;
      return sanitizePreferences(JSON.parse(serialized));
    } catch {
      return defaultPreferences;
    }
  }

  save(preferences: DashboardPreferences): void {
    try {
      this.storage.setItem(preferenceStorageKey, JSON.stringify(sanitizePreferences(preferences)));
    } catch {
      // Storage can be unavailable in hardened browser profiles; preferences remain in memory.
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(preferenceStorageKey);
    } catch {
      // Clearing an unavailable store is already effectively complete.
    }
  }
}

export class MemoryPreferenceStore implements PreferenceStore {
  private preferences: DashboardPreferences;

  constructor(initial: DashboardPreferences = defaultPreferences) {
    this.preferences = sanitizePreferences(initial);
  }

  load(): DashboardPreferences {
    return this.preferences;
  }

  save(preferences: DashboardPreferences): void {
    this.preferences = sanitizePreferences(preferences);
  }

  clear(): void {
    this.preferences = defaultPreferences;
  }
}
