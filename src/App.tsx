import {
  Activity,
  AlertTriangle,
  Ban,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Clock3,
  Code2,
  Command,
  HeartPulse,
  LayoutDashboard,
  LockKeyhole,
  Pause,
  RefreshCw,
  Search,
  Settings,
  Send,
  Server,
  ShieldAlert,
  Stethoscope,
  TerminalSquare,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentHostClient } from "./client.js";
import type { ConnectionState } from "./connection.js";
import { agentActions, type AgentAction, type AgentDetail, type AgentStatus, type ApprovalRequest } from "./domain.js";
import { useDashboard, type DashboardActionRecord, type DashboardQuery } from "./dashboard/use-dashboard.js";
import { formatActivity, providerMetrics, statusMetrics } from "./dashboard/use-cases.js";
import { notificationFromEvent, shouldNotify, type DashboardNotificationPermission, type NotificationCoordinator, type NotificationGateway } from "./daily/notifications.js";
import { agentColumns, densities, type DashboardPreferences } from "./daily/preferences.js";

type DemoScenario = "live" | "disconnected" | "stale" | "unauthorized" | "incompatible" | "blocked" | "error";

const scenarioStates: Partial<Record<DemoScenario, ConnectionState>> = {
  disconnected: { status: "disconnected", attempt: 0, reason: "The local host is not reachable." },
  stale: { status: "stale", attempt: 1, revision: 43, reason: "A revision gap was detected; resyncing snapshot." },
  unauthorized: { status: "unauthorized", attempt: 0, reason: "The connection token was rejected." },
  incompatible: { status: "incompatible", attempt: 0, reason: "Host API v2 is outside the supported range." },
};

const statusIcons: Record<AgentStatus, ReactNode> = {
  blocked: <Pause aria-hidden="true" />,
  error: <CircleX aria-hidden="true" />,
  working: <Activity aria-hidden="true" />,
  idle: <Circle aria-hidden="true" />,
  done: <CircleCheck aria-hidden="true" />,
  unknown: <Circle aria-hidden="true" />,
};

function StatusBadge({ status }: { readonly status: AgentStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {statusIcons[status]}
      <span>{status}</span>
    </span>
  );
}

function ConnectionBanner({ state, onRetry }: { readonly state: ConnectionState; readonly onRetry: () => void }) {
  const copy: Record<ConnectionState["status"], { icon: ReactNode; label: string; action?: string }> = {
    connecting: { icon: <RefreshCw aria-hidden="true" />, label: "Connecting to local agent-host" },
    connected: { icon: <Wifi aria-hidden="true" />, label: "Live connection" },
    reconnecting: { icon: <RefreshCw aria-hidden="true" />, label: `Reconnecting · attempt ${state.attempt}` },
    stale: { icon: <AlertTriangle aria-hidden="true" />, label: "Snapshot is stale · resync in progress", action: "Resync" },
    disconnected: { icon: <WifiOff aria-hidden="true" />, label: "Host disconnected", action: "Retry" },
    unauthorized: { icon: <ShieldAlert aria-hidden="true" />, label: "Authentication required", action: "Review connection" },
    incompatible: { icon: <Ban aria-hidden="true" />, label: "Incompatible API version", action: "View compatibility" },
  };
  const item = copy[state.status];
  return (
    <div className={`connection-banner connection-${state.status}`} role={state.status === "unauthorized" ? "alert" : "status"}>
      <span className="connection-label">{item.icon}{item.label}</span>
      {state.reason && <span className="connection-reason">{state.reason}</span>}
      {state.revision !== undefined && <span className="mono muted">rev {state.revision}</span>}
      {item.action && <button type="button" className="text-button" onClick={onRetry}>{item.action}</button>}
    </div>
  );
}

interface PendingConfirmation {
  readonly title: string;
  readonly label: string;
  readonly tone: "primary" | "danger" | "approval";
  readonly target: AgentDetail;
  readonly action: AgentAction;
  readonly body: ReactNode;
}

function ConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly pending: PendingConfirmation | undefined;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (confirmation: PendingConfirmation) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (pending && !dialog.open) {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!pending && dialog.open) {
      dialog.close();
      triggerRef.current?.focus();
    }
  }, [pending]);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
    >
      {pending && (
        <div className="dialog-body">
          <div className="dialog-heading">
            <div>
              <p className="eyebrow">Confirm explicit action</p>
              <h2 id="confirm-title">{pending.title}</h2>
            </div>
            <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel confirmation"><X /></button>
          </div>
          <dl className="context-grid">
            <div><dt>Target agent</dt><dd>{pending.target.name}</dd></div>
            <div><dt>Agent ID</dt><dd className="mono">{pending.target.id}</dd></div>
            <div><dt>Working directory</dt><dd className="mono">{pending.target.cwd ?? "Not reported"}</dd></div>
          </dl>
          <div className="confirmation-context">{pending.body}</div>
          <p className="keyboard-warning" id="confirm-description">Enter and Escape never approve or reject a request. Choose an explicit button.</p>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="button" className={`confirm-button tone-${pending.tone}`} disabled={busy} onClick={() => onConfirm(pending)}>
              {pending.label}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

function ApprovalContext({ approval }: { readonly approval: ApprovalRequest }) {
  return (
    <div className="approval-context">
      <div className="approval-title"><Command aria-hidden="true" /><strong>{approval.summary}</strong></div>
      {approval.reason && <p>{approval.reason}</p>}
      {approval.command && <div><span className="field-label">Command</span><code>{approval.command}</code></div>}
      {approval.path && <div><span className="field-label">File</span><code>{approval.path}</code></div>}
    </div>
  );
}

function ActionPanel({ detail, perform }: { readonly detail: AgentDetail | undefined; readonly perform: (target: AgentDetail, action: AgentAction) => Promise<unknown> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingConfirmation>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const draft = detail ? drafts[detail.id] ?? "" : "";

  const execute = (target: AgentDetail, action: AgentAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPending(undefined);
    void perform(target, action)
      .then(() => {
        setMessage(`${action.kind} completed for ${target.name}.`);
        if (action.kind === "prompt") setDrafts((current) => ({ ...current, [target.id]: "" }));
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Action failed."))
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  if (!detail) return <aside className="action-panel panel"><div className="empty-state">Select an agent to inspect available actions.</div></aside>;

  return (
    <aside className="action-panel panel" aria-labelledby="actions-heading" aria-busy={busy}>
      <div className="panel-heading">
        <div><p className="eyebrow">Selected target</p><h2 id="actions-heading">Actions</h2></div>
        <StatusBadge status={detail.status} />
      </div>
      <div className="target-context">
        <strong>{detail.name}</strong>
        <span className="mono muted">{detail.id}</span>
        <span className="mono">{detail.cwd ?? "cwd not reported"}</span>
      </div>

      {detail.pendingApprovals.map((approval) => (
        <section className="approval-card" key={approval.id} aria-labelledby={`approval-${approval.id}`}>
          <div className="approval-title"><ShieldAlert aria-hidden="true" /><h3 id={`approval-${approval.id}`}>Pending approval</h3></div>
          <ApprovalContext approval={approval} />
          <div className="approval-actions">
            {detail.capabilities.reject && (
              <button type="button" className="reject-button" disabled={busy} onClick={() => setPending({
                title: "Reject this request?",
                label: "Reject request",
                tone: "danger",
                target: detail,
                action: { kind: "reject", approvalId: approval.id },
                body: <ApprovalContext approval={approval} />,
              })}><X aria-hidden="true" />Reject</button>
            )}
            {detail.capabilities.approve && (
              <button type="button" className="approve-button" disabled={busy} onClick={() => setPending({
                title: "Approve this exact request?",
                label: "Approve request",
                tone: "approval",
                target: detail,
                action: { kind: "approve", approvalId: approval.id },
                body: <ApprovalContext approval={approval} />,
              })}><Check aria-hidden="true" />Approve</button>
            )}
          </div>
        </section>
      ))}

      {detail.capabilities.prompt && (
        <section className="action-section">
          <label htmlFor="prompt-draft">Prompt</label>
          <p className="hint" id="prompt-hint">Draft stays with this agent during live updates and reconnects.</p>
          <textarea
            id="prompt-draft"
            aria-describedby="prompt-hint"
            value={draft}
            onChange={(event) => setDrafts((current) => ({ ...current, [detail.id]: event.target.value }))}
            placeholder="Describe the next task…"
            rows={5}
          />
          <button type="button" className="primary-button" disabled={busy || !draft.trim()} onClick={() => setPending({
            title: "Send this prompt?",
            label: "Send prompt",
            tone: "primary",
            target: detail,
            action: { kind: "prompt", text: draft.trim() },
            body: <div><span className="field-label">Prompt</span><p className="prompt-preview">{draft.trim()}</p></div>,
          })}><Send aria-hidden="true" />Review and send</button>
        </section>
      )}

      <div className="safe-actions">
        {detail.capabilities.read && <button type="button" className="secondary-button" disabled={busy} onClick={() => void execute(detail, { kind: "read" })}><TerminalSquare />Read output</button>}
        {detail.capabilities.interrupt && <button type="button" className="danger-button" disabled={busy} onClick={() => setPending({
          title: "Interrupt the selected agent?",
          label: "Interrupt agent",
          tone: "danger",
          target: detail,
          action: { kind: "interrupt" },
          body: <p>This asks the host to stop the active operation for this exact agent.</p>,
        })}><Ban />Interrupt</button>}
      </div>

      {message && <p className="action-message" aria-live="polite">{message}</p>}
      <ConfirmDialog pending={pending} busy={busy} onCancel={() => setPending(undefined)} onConfirm={(confirmation) => execute(confirmation.target, confirmation.action)} />
    </aside>
  );
}

function updateQuery(query: DashboardQuery, patch: Partial<DashboardQuery>): DashboardQuery {
  return { ...query, ...patch };
}

export interface DailyDriverControls {
  readonly preferences: DashboardPreferences;
  readonly onPreferencesChange: (update: DashboardPreferences | ((current: DashboardPreferences) => DashboardPreferences)) => void;
  readonly onReconnect: () => void;
  readonly onTerminalFailure: () => void;
  readonly onClearPreferences: () => void;
  readonly notificationGateway: NotificationGateway;
  readonly notificationCoordinator: NotificationCoordinator;
  readonly notificationNamespace: string;
  readonly environmentNotice?: string;
}

function SettingsSurface({ controls, onWorkspace, notificationPermission, onRequestNotifications, providers, projects, mutedProviders, mutedProjects, onToggleProvider, onToggleProject }: {
  readonly controls: DailyDriverControls;
  readonly onWorkspace: () => void;
  readonly notificationPermission: DashboardNotificationPermission;
  readonly onRequestNotifications: () => void;
  readonly providers: readonly string[];
  readonly projects: readonly string[];
  readonly mutedProviders: ReadonlySet<string>;
  readonly mutedProjects: ReadonlySet<string>;
  readonly onToggleProvider: (provider: string) => void;
  readonly onToggleProject: (project: string) => void;
}) {
  const update = (patch: Partial<DashboardPreferences>) => controls.onPreferencesChange((current) => ({ ...current, ...patch }));
  const updateNotifications = (patch: Partial<DashboardPreferences["notifications"]>) => controls.onPreferencesChange((current) => ({ ...current, notifications: { ...current.notifications, ...patch } }));
  return (
    <main id="main-content" tabIndex={-1} className="settings-workspace">
      <header className="settings-heading"><div><p className="eyebrow">Daily-driver preferences</p><h1>Settings</h1></div><button className="secondary-button" type="button" onClick={onWorkspace}><LayoutDashboard />Workspace</button></header>
      <section className="settings-card" aria-labelledby="appearance-heading">
        <div><p className="eyebrow">Appearance</p><h2 id="appearance-heading">Density and agent columns</h2></div>
        <label htmlFor="density-setting"><span>Density</span><select id="density-setting" value={controls.preferences.density} onChange={(event) => update({ density: event.target.value as DashboardPreferences["density"] })}>{densities.map((density) => <option key={density} value={density}>{density}</option>)}</select></label>
        <fieldset><legend>Visible agent columns</legend>{agentColumns.map((column) => <label key={column}><input type="checkbox" checked={controls.preferences.columns.includes(column)} onChange={(event) => controls.onPreferencesChange((current) => ({ ...current, columns: event.target.checked ? [...current.columns, column] : current.columns.filter((item) => item !== column) }))} />{column}</label>)}</fieldset>
      </section>
      <section className="settings-card" aria-labelledby="notification-heading">
        <div><p className="eyebrow">Attention notifications</p><h2 id="notification-heading">Blocked, completed, and error events</h2><p>Only new semantic events can notify. Initial snapshots and resyncs stay silent.</p></div>
        <div className="notification-permission"><Bell aria-hidden="true" /><span>Browser permission: <strong>{notificationPermission}</strong></span>{notificationPermission !== "granted" && notificationPermission !== "unsupported" && <button type="button" className="secondary-button" onClick={onRequestNotifications}>Enable desktop notifications</button>}</div>
        <fieldset disabled={notificationPermission !== "granted"}><legend>Notification types</legend>
          <label><input type="checkbox" checked={controls.preferences.notifications.enabled} onChange={(event) => updateNotifications({ enabled: event.target.checked })} />Notifications enabled</label>
          <label><input type="checkbox" checked={controls.preferences.notifications.blocked} onChange={(event) => updateNotifications({ blocked: event.target.checked })} />Blocked agents</label>
          <label><input type="checkbox" checked={controls.preferences.notifications.completed} onChange={(event) => updateNotifications({ completed: event.target.checked })} />Completed agents</label>
          <label><input type="checkbox" checked={controls.preferences.notifications.error} onChange={(event) => updateNotifications({ error: event.target.checked })} />Agent errors</label>
        </fieldset>
        <details><summary>Provider and project controls · this session only</summary>
          <p className="hint">Scopes accumulate as they are observed in this session and remain in memory. Project enumeration may be incomplete until agent-host exposes safe public facets.</p>
          <div className="notification-scopes"><fieldset><legend>Providers</legend>{providers.map((provider) => <label key={provider}><input type="checkbox" checked={!mutedProviders.has(provider)} onChange={() => onToggleProvider(provider)} />{provider}</label>)}</fieldset><fieldset><legend>Projects</legend>{projects.map((project) => <label key={project}><input type="checkbox" checked={!mutedProjects.has(project)} onChange={() => onToggleProject(project)} />{project}</label>)}</fieldset></div>
        </details>
      </section>
      <section className="settings-card" aria-labelledby="connection-settings-heading">
        <div><p className="eyebrow">Connection</p><h2 id="connection-settings-heading">Local agent-host</h2></div>
        <dl><div><dt>Endpoint</dt><dd className="mono">{controls.preferences.endpoint}</dd></div><div><dt>Credential</dt><dd>Memory only · cleared on disconnect or reload</dd></div></dl>
        <button className="danger-button" type="button" onClick={controls.onReconnect}>Change connection</button>
      </section>
      <section className="settings-card"><div><p className="eyebrow">Keyboard-first operation</p><h2>Shortcuts</h2></div><dl><div><dt className="mono">/</dt><dd>Focus agent search from the workspace</dd></div><div><dt>Tab / Shift+Tab</dt><dd>Move through semantic controls and explicit action review</dd></div></dl></section>
    </main>
  );
}

function PrivacySurface({ onWorkspace, onClear }: { readonly onWorkspace: () => void; readonly onClear: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="settings-workspace">
      <header className="settings-heading"><div><p className="eyebrow">Local data boundary</p><h1>Privacy</h1></div><button className="secondary-button" type="button" onClick={onWorkspace}><LayoutDashboard />Workspace</button></header>
      <section className="settings-card privacy-card">
        <LockKeyhole aria-hidden="true" />
        <div><h2>Only non-secret preferences persist</h2><p>Endpoint, semantic filters, sort, density, columns, saved view names, and global notification-type toggles may be stored locally. Credentials, provider/project scopes, recent agents, action history, prompt drafts, commands, cwd values, raw JSON, and agent snapshots are never persisted.</p></div>
      </section>
      <section className="settings-card">
        <div><p className="eyebrow">Reset</p><h2>Clear local dashboard data</h2><p>This removes saved views and appearance choices from storage. The current workspace stays in memory until reload; the active credential is cleared when you change connection.</p></div>
        <button className="danger-button" type="button" onClick={onClear}>Clear local preferences</button>
      </section>
    </main>
  );
}

interface RecentAgent {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly project?: string;
  readonly status: AgentStatus;
}

function ActivitySurface({ recentAgents, actionHistory, onWorkspace, onSelect, onClear }: { readonly recentAgents: readonly RecentAgent[]; readonly actionHistory: readonly DashboardActionRecord[]; readonly onWorkspace: () => void; readonly onSelect: (agentId: string) => void; readonly onClear: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="settings-workspace">
      <header className="settings-heading"><div><p className="eyebrow">Session memory</p><h1>Activity</h1></div><div className="surface-actions"><button className="secondary-button" type="button" onClick={onClear}>Clear session activity</button><button className="secondary-button" type="button" onClick={onWorkspace}><LayoutDashboard />Workspace</button></div></header>
      <section className="settings-card" aria-labelledby="recent-heading"><div><p className="eyebrow">Recently inspected</p><h2 id="recent-heading">Recent agents</h2><p>Kept only for this browser session.</p></div><ol className="activity-list">{recentAgents.length ? recentAgents.map((agent) => <li key={agent.id}><button type="button" onClick={() => onSelect(agent.id)}><span><strong>{agent.name}</strong><small>{agent.provider}{agent.project ? ` · ${agent.project}` : ""}</small></span><StatusBadge status={agent.status} /></button></li>) : <li className="empty-state">No agents inspected yet.</li>}</ol></section>
      <section className="settings-card" aria-labelledby="history-heading"><div><p className="eyebrow">Explicit operations</p><h2 id="history-heading">Action history</h2><p>Prompt text, commands, approval payloads, and error bodies are excluded.</p></div><ol className="activity-list action-history">{actionHistory.length ? actionHistory.map((entry) => <li key={entry.id}><div><span><strong>{entry.kind}</strong> · {entry.agentName}</span><small className="mono">{entry.occurredAt} · {entry.outcome}{entry.errorCode ? ` · ${entry.errorCode}` : ""}</small></div></li>) : <li className="empty-state">No actions performed in this session.</li>}</ol></section>
    </main>
  );
}

function DiagnosticsSurface({ model, onWorkspace }: { readonly model: ReturnType<typeof useDashboard>; readonly onWorkspace: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="settings-workspace">
      <header className="settings-heading"><div><p className="eyebrow">Public boundary health</p><h1>Diagnostics</h1></div><button className="secondary-button" type="button" onClick={onWorkspace}><LayoutDashboard />Workspace</button></header>
      <section className="settings-card diagnostics-grid" aria-labelledby="protocol-heading"><div><p className="eyebrow">Compatibility</p><h2 id="protocol-heading">Versioned API</h2></div><dl><div><dt>API version</dt><dd>{model.apiInfo?.apiVersion ?? "Discovering"}</dd></div><div><dt>Server version</dt><dd>{model.apiInfo?.serverVersion ?? "Not reported"}</dd></div><div><dt>Features</dt><dd>{model.apiInfo?.features.join(", ") || "None reported"}</dd></div></dl></section>
      <section className="settings-card diagnostics-grid"><div><p className="eyebrow">Live state</p><h2>Connection and revision</h2></div><dl><div><dt>Connection</dt><dd>{model.connection.status}</dd></div><div><dt>Revision</dt><dd>{model.snapshot?.revision ?? model.connection.revision ?? "—"}</dd></div><div><dt>Buffered events</dt><dd>{model.events.length}</dd></div><div><dt>Adapter health</dt><dd>{model.health.map((adapter) => `${adapter.label}: ${adapter.status}`).join(" · ") || "No adapters reported"}</dd></div></dl></section>
      <section className="settings-card privacy-card"><LockKeyhole aria-hidden="true" /><div><h2>Sanitized diagnostics only</h2><p>No credential, prompt, command, cwd, raw agent JSON, private error body, or provider-native metadata is included on this screen.</p></div></section>
    </main>
  );
}

export function App({ client, now = Date.now, dailyDriver, showDemoControls = true }: { readonly client: AgentHostClient; readonly now?: () => number; readonly dailyDriver?: DailyDriverControls; readonly showDemoControls?: boolean }) {
  const onQueryChange = useCallback((query: DashboardQuery) => {
    if (!dailyDriver) return;
    dailyDriver.onPreferencesChange((current) => ({
      ...current,
      query: { status: query.status, provider: query.provider, sort: query.sort },
    }));
  }, [dailyDriver]);
  const model = useDashboard(client, {
    ...(dailyDriver ? { initialQuery: { text: "", ...dailyDriver.preferences.query }, onQueryChange } : {}),
  });
  const [scenario, setScenario] = useState<DemoScenario>("live");
  const [surface, setSurface] = useState<"workspace" | "settings" | "activity" | "diagnostics" | "privacy">("workspace");
  const [notificationPermission, setNotificationPermission] = useState<DashboardNotificationPermission>(() => dailyDriver?.notificationGateway.permission() ?? "unsupported");
  const [mutedProviders, setMutedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [mutedProjects, setMutedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [recentAgents, setRecentAgents] = useState<readonly RecentAgent[]>([]);
  const [observedProviders, setObservedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [observedProjects, setObservedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const seenNotificationEvents = useRef(new Set<string>());
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const previousSurface = useRef(surface);
  const displayConnection = scenarioStates[scenario] ?? model.connection;
  const displayError = model.error === displayConnection.reason ? undefined : model.error;
  const metrics = statusMetrics(model.snapshot);
  const providers = providerMetrics(model.snapshot);
  const currentTime = now();

  const notificationProviders = useMemo(() => [...observedProviders].sort(), [observedProviders]);
  const notificationProjects = useMemo(() => [...observedProjects].sort(), [observedProjects]);

  const rememberAgent = (agent: RecentAgent) => setRecentAgents((current) => [agent, ...current.filter((candidate) => candidate.id !== agent.id)].slice(0, 12));

  useEffect(() => {
    if (scenario !== "blocked" && scenario !== "error") return;
    if (model.query.status !== scenario) {
      model.setQuery(updateQuery(model.query, { status: scenario }));
      return;
    }
    const match = model.snapshot?.agents.find((agent) => agent.status === scenario);
    if (match && model.selectedId !== match.id) model.select(match.id);
  }, [model.query, model.select, model.selectedId, model.setQuery, model.snapshot?.agents, scenario]);

  useEffect(() => {
    const agents = [
      ...(model.snapshot?.agents ?? []),
      ...model.events.flatMap((event) => event.type === "agent.upserted" ? [event.agent] : []),
    ];
    setObservedProviders((current) => new Set([...current, ...Object.keys(model.snapshot?.facets?.byProvider ?? {}), ...agents.map((agent) => agent.provider)]));
    setObservedProjects((current) => new Set([...current, ...agents.flatMap((agent) => agent.project ? [agent.project] : [])]));
  }, [model.events, model.snapshot?.agents, model.snapshot?.facets?.byProvider]);

  useEffect(() => {
    for (const event of [...model.notificationEvents].reverse()) {
      const subject = event.type === "agent.upserted" ? event.agent.id : event.type === "agent.removed" || event.type === "action.completed" ? event.agentId : event.type === "adapter.health" ? event.adapter.id : "host";
      const key = `${event.revision}:${event.type}:${subject}`;
      if (seenNotificationEvents.current.has(key)) continue;
      seenNotificationEvents.current.add(key);
      const notification = notificationFromEvent(event);
      if (!dailyDriver || notificationPermission !== "granted" || !notification || !shouldNotify(notification, dailyDriver.preferences.notifications, mutedProviders, mutedProjects)) continue;
      const label = notification.kind === "completed" ? "completed" : `is ${notification.kind}`;
      const publicCoordinationKey = `${dailyDriver.notificationNamespace}:${event.revision}:${notification.kind}`;
      void dailyDriver.notificationCoordinator.runOnce(publicCoordinationKey, () => dailyDriver.notificationGateway.show(`${notification.agentName} ${label}`, {
        body: [notification.provider, notification.project].filter(Boolean).join(" · "),
        tag: publicCoordinationKey,
      }, () => {
        void client.detail(notification.agentId).then((detail) => {
          rememberAgent(detail);
          model.select(notification.agentId);
          setSurface("workspace");
        }).catch(() => undefined);
      }));
    }
    if (seenNotificationEvents.current.size > 500) seenNotificationEvents.current = new Set([...seenNotificationEvents.current].slice(-250));
  }, [dailyDriver, model.notificationEvents, mutedProjects, mutedProviders, notificationPermission]);

  const requestNotifications = () => {
    if (!dailyDriver) return;
    void dailyDriver.notificationGateway.requestPermission().then((permission) => {
      setNotificationPermission(permission);
      if (permission === "granted") dailyDriver.onPreferencesChange((current) => ({ ...current, notifications: { ...current.notifications, enabled: true } }));
    });
  };

  const toggleScope = (setter: (value: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void, value: string) => setter((current) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });

  const goWorkspace = () => setSurface("workspace");

  useEffect(() => {
    if (surface === "workspace" && previousSurface.current !== "workspace") workspaceRef.current?.focus();
    previousSurface.current = surface;
  }, [surface]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (surface === "workspace" && event.key === "/" && !editable) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [surface]);

  const rawPublicJson = useMemo(
    () => JSON.stringify(model.detail ? { ...model.detail, publicData: model.detail.publicData ?? {} } : null, null, 2),
    [model.detail],
  );

  const saveCurrentView = () => {
    if (!dailyDriver) return;
    dailyDriver.onPreferencesChange((current) => {
      if (current.savedViews.length >= 12) return current;
      const sequence = current.savedViews.length + 1;
      return {
        ...current,
        savedViews: [...current.savedViews, {
          id: `view-${Date.now()}-${sequence}`,
          name: `View ${sequence} · ${model.query.status === "all" ? "all statuses" : model.query.status}`,
          status: model.query.status,
          provider: model.query.provider,
          sort: model.query.sort,
        }],
      };
    });
  };

  return (
    <div className={`app-shell density-${dailyDriver?.preferences.density ?? "comfortable"}`}>
      <a className="skip-link" href="#main-content">Skip to agent workspace</a>
      <header className="topbar">
        <div className="brand"><Server aria-hidden="true" /><div><span>Agent Host</span><strong>Console</strong></div></div>
        <ConnectionBanner state={displayConnection} onRetry={() => {
          if (dailyDriver && (displayConnection.status === "unauthorized" || displayConnection.status === "incompatible")) dailyDriver.onTerminalFailure();
          else if (displayConnection.status === "disconnected") model.reconnect();
          else void model.refresh();
        }} />
        {dailyDriver && <nav className="utility-nav" aria-label="Dashboard sections"><button type="button" aria-current={surface === "workspace" ? "page" : undefined} onClick={goWorkspace}><LayoutDashboard />Workspace</button><button type="button" aria-current={surface === "activity" ? "page" : undefined} onClick={() => setSurface("activity")}><Clock3 />Activity</button><button type="button" aria-current={surface === "diagnostics" ? "page" : undefined} onClick={() => setSurface("diagnostics")}><Stethoscope />Diagnostics</button><button type="button" aria-current={surface === "settings" ? "page" : undefined} onClick={() => setSurface("settings")}><Settings />Settings</button><button type="button" aria-current={surface === "privacy" ? "page" : undefined} onClick={() => setSurface("privacy")}><LockKeyhole />Privacy</button></nav>}
        {showDemoControls && <label className="scenario-control">
          <span>Demo state</span>
          <select value={scenario} onChange={(event) => setScenario(event.target.value as DemoScenario)}>
            <option value="live">Live</option>
            <option value="blocked">Blocked focus</option>
            <option value="error">Error focus</option>
            <option value="disconnected">Disconnected</option>
            <option value="stale">Stale / resync</option>
            <option value="unauthorized">Unauthorized</option>
            <option value="incompatible">Incompatible</option>
          </select>
        </label>}
      </header>
      {dailyDriver?.environmentNotice && <div className="environment-notice" role="status"><ShieldAlert aria-hidden="true" />{dailyDriver.environmentNotice}</div>}

      {surface === "settings" && dailyDriver && <SettingsSurface controls={dailyDriver} onWorkspace={goWorkspace} notificationPermission={notificationPermission} onRequestNotifications={requestNotifications} providers={notificationProviders} projects={notificationProjects} mutedProviders={mutedProviders} mutedProjects={mutedProjects} onToggleProvider={(provider) => toggleScope(setMutedProviders, provider)} onToggleProject={(project) => toggleScope(setMutedProjects, project)} />}
      {surface === "activity" && dailyDriver && <ActivitySurface recentAgents={recentAgents} actionHistory={model.actionHistory} onWorkspace={goWorkspace} onSelect={(agentId) => { model.select(agentId); goWorkspace(); }} onClear={() => { setRecentAgents([]); model.clearActionHistory(); }} />}
      {surface === "diagnostics" && dailyDriver && <DiagnosticsSurface model={model} onWorkspace={goWorkspace} />}
      {surface === "privacy" && dailyDriver && <PrivacySurface onWorkspace={goWorkspace} onClear={dailyDriver.onClearPreferences} />}
      <div hidden={surface !== "workspace"}>
        <section className="summary-strip" aria-labelledby="summary-heading">
        <div className="total-metric"><p className="eyebrow" id="summary-heading">Current scope</p><strong>{model.snapshot?.total?.toLocaleString() ?? "—"}</strong><span>agents</span></div>
        {metrics.map((metric) => (
          <button key={metric.status} type="button" className={`summary-metric ${metric.urgent ? "urgent" : ""}`} onClick={() => model.setQuery(updateQuery(model.query, { status: metric.status }))}>
            <StatusBadge status={metric.status} /><strong>{metric.count.toLocaleString()}</strong>
          </button>
        ))}
        <div className="adapter-summary"><HeartPulse aria-hidden="true" /><div><strong>{model.health.filter((item) => item.status === "healthy").length}/{model.health.length}</strong><span>adapters healthy</span></div></div>
      </section>

      <main ref={workspaceRef} id={surface === "workspace" ? "main-content" : undefined} tabIndex={-1} className="workspace">
        <section className="agent-rail panel" aria-labelledby="agents-heading">
          <div className="rail-heading"><div><p className="eyebrow">Attention queue</p><h1 id="agents-heading">Agents</h1></div><button type="button" className="icon-button" onClick={() => void model.refresh()} aria-label="Refresh agents"><RefreshCw /></button></div>
          <div className="filters">
            {dailyDriver && <div className="saved-view-row"><label><span>Saved view</span><select defaultValue="" onChange={(event) => { const view = dailyDriver.preferences.savedViews.find((candidate) => candidate.id === event.target.value); if (view) model.setQuery({ text: "", status: view.status, provider: view.provider, sort: view.sort }); }}><option value="">Current filters</option>{dailyDriver.preferences.savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label><button type="button" onClick={saveCurrentView}>Save view</button></div>}
            <label className="search-field"><span className="visually-hidden">Search agents</span><Search aria-hidden="true" /><input ref={searchRef} aria-keyshortcuts="/" value={model.query.text} onChange={(event) => model.setQuery(updateQuery(model.query, { text: event.target.value }))} placeholder="Search agents" /></label>
            <div className="filter-row">
              <label><span>Status</span><select value={model.query.status} onChange={(event) => model.setQuery(updateQuery(model.query, { status: event.target.value as AgentStatus | "all" }))}><option value="all">All</option>{metrics.map((metric) => <option key={metric.status} value={metric.status}>{metric.status}</option>)}</select></label>
              <label><span>Provider</span><select value={model.query.provider} onChange={(event) => model.setQuery(updateQuery(model.query, { provider: event.target.value }))}><option value="">All</option>{providers.map(([provider]) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
            </div>
            <div className="provider-breakdown" aria-label="Provider summary">
              {providers.slice(0, 4).map(([provider, count]) => (
                <button key={provider} type="button" aria-pressed={model.query.provider === provider} onClick={() => model.setQuery(updateQuery(model.query, { provider: model.query.provider === provider ? "" : provider }))}>
                  <span>{provider}</span><strong>{count}</strong>
                </button>
              ))}
            </div>
            <label className="sort-control"><span>Sort</span><select value={`${model.query.sort.field}:${model.query.sort.direction}`} onChange={(event) => {
              const [field, direction] = event.target.value.split(":") as [DashboardQuery["sort"]["field"], DashboardQuery["sort"]["direction"]];
              model.setQuery(updateQuery(model.query, { sort: { field, direction } }));
            }}><option value="status:asc">Attention first</option><option value="lastActivityAt:desc">Last activity</option><option value="name:asc">Name A–Z</option><option value="provider:asc">Provider</option></select></label>
          </div>
          <div className="result-meta"><span>{model.loading ? "Updating…" : `${model.snapshot?.agents.length ?? 0} shown of ${model.snapshot?.total ?? 0}`}</span><span className="mono">rev {model.snapshot?.revision ?? "—"}</span></div>
          <ul className="agent-list">
            {model.snapshot?.agents.map((agent) => (
              <li key={agent.id}>
                <button type="button" className={`agent-row ${agent.id === model.selectedId ? "selected" : ""}`} onClick={() => { rememberAgent(agent); model.select(agent.id); }} aria-current={agent.id === model.selectedId ? "true" : undefined}>
                  <span className="agent-row-top"><strong>{agent.name}</strong><StatusBadge status={agent.status} /></span>
                  <span className="agent-row-meta">{(!dailyDriver || dailyDriver.preferences.columns.includes("provider")) && <span>{agent.provider}</span>}{(!dailyDriver || dailyDriver.preferences.columns.includes("project")) && <span>{agent.project ?? "No project"}</span>}{(!dailyDriver || dailyDriver.preferences.columns.includes("activity")) && <span>{formatActivity(agent.lastActivityAt, currentTime)}</span>}</span>
                </button>
              </li>
            ))}
          </ul>
          {!model.snapshot?.agents.length && <div className="empty-state">No agents match the current filters.</div>}
          <nav className="pagination" aria-label="Agent pages">
            <button type="button" onClick={model.previousPage} disabled={!model.hasPrevious}><ChevronLeft />Previous</button>
            <span>Page {model.page + 1}</span>
            <button type="button" onClick={model.nextPage} disabled={!model.hasNext}>Next<ChevronRight /></button>
          </nav>
        </section>

        <section className="observation-panel panel" aria-labelledby="agent-heading">
          {model.detail ? (
            <>
              <header className="agent-header">
                <div><p className="eyebrow">Observed agent</p><h2 id="agent-heading">{model.detail.name}</h2><span className="mono muted">{model.detail.id}</span></div>
                <StatusBadge status={model.detail.status} />
              </header>
              <dl className="agent-facts">
                <div><dt>Provider</dt><dd>{model.detail.provider}</dd></div>
                <div><dt>Project</dt><dd>{model.detail.project ?? "Not reported"}</dd></div>
                <div><dt>Source</dt><dd>{model.detail.provenance.source} · {model.detail.provenance.confidence ?? "unknown"}</dd></div>
                <div className="wide"><dt>Working directory</dt><dd className="mono">{model.detail.cwd ?? "Not reported"}</dd></div>
                <div><dt>Last activity</dt><dd>{formatActivity(model.detail.lastActivityAt, currentTime)}</dd></div>
              </dl>
              <div className="capability-row"><span className="field-label">Public capabilities</span><div>{agentActions.filter((action) => model.detail?.capabilities[action]).map((action) => <span className="capability" key={action}>{action}</span>)}</div></div>
              <section className="timeline" aria-labelledby="timeline-heading">
                <div className="section-heading"><div><p className="eyebrow">Semantic stream</p><h3 id="timeline-heading">Live events</h3></div><span className="live-indicator"><Activity aria-hidden="true" />Live</span></div>
                <ol>
                  {model.events.length ? model.events.map((event, index) => (
                    <li key={`${event.revision}-${index}`}><span className="event-revision mono">r{event.revision}</span><span className="event-icon"><Code2 aria-hidden="true" /></span><div><strong>{event.type}</strong><p>{event.type === "agent.upserted" ? event.agent.name : event.type === "adapter.health" ? event.adapter.label : "Semantic host event"}</p></div></li>
                  )) : <li className="empty-event"><Activity aria-hidden="true" /><span>Waiting for semantic events. Selection and scroll remain stable.</span></li>}
                </ol>
              </section>
              <section className="adapter-health" aria-labelledby="health-heading">
                <div className="section-heading"><div><p className="eyebrow">Discovery plane</p><h3 id="health-heading">Adapter health</h3></div></div>
                <ul>{model.health.map((adapter) => <li key={adapter.id}><span className={`health-dot health-${adapter.status}`} aria-hidden="true" /><div><strong>{adapter.label}</strong><span>{adapter.status}</span></div><span className="mono">{adapter.durationMs ?? "—"} ms</span>{adapter.error && <span className="health-error">{adapter.error.message}</span>}</li>)}</ul>
              </section>
              <details className="developer-panel"><summary><Code2 aria-hidden="true" /><span>Developer panel</span><small>public API JSON</small></summary><pre>{rawPublicJson}</pre></details>
            </>
          ) : <div className="empty-state">Select an agent to inspect its public details.</div>}
        </section>

        <ActionPanel detail={model.detail} perform={model.perform} />
        </main>
      </div>
      {displayError && <div className="global-error" role="alert"><AlertTriangle />{displayError}<button type="button" onClick={() => void model.refresh()}>Retry</button></div>}
    </div>
  );
}
