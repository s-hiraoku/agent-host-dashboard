import {
  Activity,
  AlertTriangle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Code2,
  Command,
  HeartPulse,
  Pause,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldAlert,
  TerminalSquare,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentHostClient } from "./client.js";
import type { ConnectionState } from "./connection.js";
import { agentActions, type AgentAction, type AgentDetail, type AgentStatus, type ApprovalRequest } from "./domain.js";
import { useDashboard, type DashboardQuery } from "./dashboard/use-dashboard.js";
import { formatActivity, providerMetrics, statusMetrics } from "./dashboard/use-cases.js";

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

export function App({ client, now = Date.now }: { readonly client: AgentHostClient; readonly now?: () => number }) {
  const model = useDashboard(client);
  const [scenario, setScenario] = useState<DemoScenario>("live");
  const displayConnection = scenarioStates[scenario] ?? model.connection;
  const metrics = statusMetrics(model.snapshot);
  const providers = providerMetrics(model.snapshot);
  const currentTime = now();

  useEffect(() => {
    if (scenario !== "blocked" && scenario !== "error") return;
    if (model.query.status !== scenario) {
      model.setQuery(updateQuery(model.query, { status: scenario }));
      return;
    }
    const match = model.snapshot?.agents.find((agent) => agent.status === scenario);
    if (match && model.selectedId !== match.id) model.select(match.id);
  }, [model.query, model.select, model.selectedId, model.setQuery, model.snapshot?.agents, scenario]);

  const rawPublicJson = useMemo(
    () => JSON.stringify(model.detail ? { ...model.detail, publicData: model.detail.publicData ?? {} } : null, null, 2),
    [model.detail],
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to agent workspace</a>
      <header className="topbar">
        <div className="brand"><Server aria-hidden="true" /><div><span>Agent Host</span><strong>Console</strong></div></div>
        <ConnectionBanner state={displayConnection} onRetry={() => void model.refresh()} />
        <label className="scenario-control">
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
        </label>
      </header>

      <section className="summary-strip" aria-labelledby="summary-heading">
        <div className="total-metric"><p className="eyebrow" id="summary-heading">Current scope</p><strong>{model.snapshot?.total?.toLocaleString() ?? "—"}</strong><span>agents</span></div>
        {metrics.map((metric) => (
          <button key={metric.status} type="button" className={`summary-metric ${metric.urgent ? "urgent" : ""}`} onClick={() => model.setQuery(updateQuery(model.query, { status: metric.status }))}>
            <StatusBadge status={metric.status} /><strong>{metric.count.toLocaleString()}</strong>
          </button>
        ))}
        <div className="adapter-summary"><HeartPulse aria-hidden="true" /><div><strong>{model.health.filter((item) => item.status === "healthy").length}/{model.health.length}</strong><span>adapters healthy</span></div></div>
      </section>

      <main id="main-content" tabIndex={-1} className="workspace">
        <section className="agent-rail panel" aria-labelledby="agents-heading">
          <div className="rail-heading"><div><p className="eyebrow">Attention queue</p><h1 id="agents-heading">Agents</h1></div><button type="button" className="icon-button" onClick={() => void model.refresh()} aria-label="Refresh agents"><RefreshCw /></button></div>
          <div className="filters">
            <label className="search-field"><span className="visually-hidden">Search agents</span><Search aria-hidden="true" /><input value={model.query.text} onChange={(event) => model.setQuery(updateQuery(model.query, { text: event.target.value }))} placeholder="Search agents" /></label>
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
                <button type="button" className={`agent-row ${agent.id === model.selectedId ? "selected" : ""}`} onClick={() => model.select(agent.id)} aria-current={agent.id === model.selectedId ? "true" : undefined}>
                  <span className="agent-row-top"><strong>{agent.name}</strong><StatusBadge status={agent.status} /></span>
                  <span className="agent-row-meta"><span>{agent.provider}</span><span>{agent.project ?? "No project"}</span><span>{formatActivity(agent.lastActivityAt, currentTime)}</span></span>
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
      {model.error && <div className="global-error" role="alert"><AlertTriangle />{model.error}<button type="button" onClick={() => void model.refresh()}>Retry</button></div>}
    </div>
  );
}
