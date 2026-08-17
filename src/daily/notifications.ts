import type { AgentEvent } from "../domain.js";
import type { NotificationPreferences } from "./preferences.js";

export type DashboardNotificationPermission = NotificationPermission | "unsupported";
export type DashboardNotificationKind = "blocked" | "completed" | "error";

export interface DashboardNotification {
  readonly kind: DashboardNotificationKind;
  readonly agentId: string;
  readonly agentName: string;
  readonly provider: string;
  readonly projectId?: string;
  readonly projectName?: string;
}

export interface NotificationGateway {
  permission(): DashboardNotificationPermission;
  requestPermission(): Promise<DashboardNotificationPermission>;
  show(title: string, options: NotificationOptions, onClick?: () => void): void;
}

export interface NotificationCoordinator {
  runOnce(key: string, operation: () => void): Promise<void>;
  close(): void;
}

interface NotificationChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export class BrowserNotificationGateway implements NotificationGateway {
  permission(): DashboardNotificationPermission {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  }

  async requestPermission(): Promise<DashboardNotificationPermission> {
    return typeof Notification === "undefined" ? "unsupported" : await Notification.requestPermission();
  }

  show(title: string, options: NotificationOptions, onClick?: () => void): void {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notification = new Notification(title, options);
    if (onClick) notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  }
}

type CoordinationMessage =
  | { readonly type: "contend"; readonly key: string; readonly tabId: string }
  | { readonly type: "delivered"; readonly key: string };

function coordinationMessage(value: unknown): CoordinationMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.type === "contend" && typeof input.key === "string" && typeof input.tabId === "string") {
    return { type: "contend", key: input.key, tabId: input.tabId };
  }
  if (input.type === "delivered" && typeof input.key === "string") return { type: "delivered", key: input.key };
  return undefined;
}

export class BrowserNotificationCoordinator implements NotificationCoordinator {
  private readonly tabId: string;
  private readonly contenders = new Map<string, Set<string>>();
  private readonly delivered = new Set<string>();
  private readonly channel: NotificationChannel | undefined;
  private closed = false;

  constructor(options: { readonly tabId?: string; readonly channel?: NotificationChannel; readonly settleMs?: number } = {}) {
    this.tabId = options.tabId ?? crypto.randomUUID();
    this.settleMs = options.settleMs ?? 75;
    this.channel = options.channel ?? (typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("agent-host-dashboard.notifications.v1"));
    if (this.channel) {
      this.channel.onmessage = (event) => {
        const message = coordinationMessage(event.data);
        if (!message) return;
        if (message.type === "delivered") {
          this.contenders.delete(message.key);
          this.rememberDelivered(message.key);
        } else {
          const peers = this.contenders.get(message.key) ?? new Set<string>();
          peers.add(message.tabId);
          this.contenders.set(message.key, peers);
        }
      };
    }
  }

  private readonly settleMs: number;

  private rememberDelivered(key: string): void {
    this.delivered.add(key);
    if (this.delivered.size <= 500) return;
    for (const deliveredKey of this.delivered) {
      this.delivered.delete(deliveredKey);
      if (this.delivered.size <= 250) break;
    }
  }

  async runOnce(key: string, operation: () => void): Promise<void> {
    if (!this.channel) {
      if (this.closed || this.delivered.has(key)) return;
      this.rememberDelivered(key);
      operation();
      return;
    }
    const contenders = this.contenders.get(key) ?? new Set<string>();
    contenders.add(this.tabId);
    this.contenders.set(key, contenders);
    this.channel.postMessage({ type: "contend", key, tabId: this.tabId } satisfies CoordinationMessage);
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    if (this.closed) return;
    if (this.delivered.has(key)) return;
    const owner = [...(this.contenders.get(key) ?? [this.tabId])].sort()[0];
    if (owner !== this.tabId) return;
    this.contenders.delete(key);
    this.rememberDelivered(key);
    this.channel.postMessage({ type: "delivered", key } satisfies CoordinationMessage);
    operation();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.contenders.clear();
    if (this.channel) this.channel.onmessage = null;
    this.channel?.close();
  }
}

export function notificationFromEvent(event: AgentEvent): DashboardNotification | undefined {
  if (event.type !== "agent.upserted") return undefined;
  const kind = event.agent.status === "blocked"
    ? "blocked"
    : event.agent.status === "done"
      ? "completed"
      : event.agent.status === "error"
        ? "error"
        : undefined;
  if (!kind) return undefined;
  return {
    kind,
    agentId: event.agent.id,
    agentName: event.agent.name,
    provider: event.agent.provider,
    ...(event.agent.project ? { projectId: event.agent.project.id, projectName: event.agent.project.name } : {}),
  };
}

export function shouldNotify(
  notification: DashboardNotification,
  preferences: NotificationPreferences,
  mutedProviders: ReadonlySet<string>,
  mutedProjects: ReadonlySet<string>,
): boolean {
  return preferences.enabled
    && preferences[notification.kind]
    && !mutedProviders.has(notification.provider)
    && (!notification.projectId || !mutedProjects.has(notification.projectId));
}
