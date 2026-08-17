import { KeyRound, LockKeyhole, RotateCcw, Server, ShieldAlert, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { App } from "../App.js";
import { normalizeAgentHostBaseUrl } from "../http/fetch-channel.js";
import type { RepositoryContextSource } from "../repositories/context-source.js";
import type { SourceControlClient } from "../repositories/source-control.js";
import { BrowserNotificationCoordinator, BrowserNotificationGateway, type NotificationCoordinator, type NotificationGateway } from "./notifications.js";
import { defaultPreferences, type DashboardPreferences, type PreferenceStore } from "./preferences.js";
import {
  MemoryCredentialVault,
  classifySessionFailure,
  type ClientConnector,
  type ClientLease,
  type SessionFailure,
  type SourceControlClientFactory,
} from "./session.js";

const failureCopy: Record<SessionFailure, { readonly icon: ReactNode; readonly title: string; readonly guidance: string }> = {
  unavailable: { icon: <WifiOff aria-hidden="true" />, title: "Local host is not reachable", guidance: "Start agent-host, confirm the loopback endpoint, then retry." },
  unauthorized: { icon: <KeyRound aria-hidden="true" />, title: "Authentication failed", guidance: "The credential was cleared. Enter the current token and connect again." },
  incompatible: { icon: <ShieldAlert aria-hidden="true" />, title: "API version is incompatible", guidance: "Update the dashboard or agent-host until their supported API versions overlap." },
  error: { icon: <ShieldAlert aria-hidden="true" />, title: "Connection could not be opened", guidance: "Review the endpoint and retry. No credential was retained." },
};

async function notificationNamespaceFor(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function DailyDriverShell({ connector, preferenceStore, environmentNotice, notificationGateway, notificationCoordinator, repositoryContext, sourceControl, sourceControlFactory }: { readonly connector: ClientConnector; readonly preferenceStore: PreferenceStore; readonly environmentNotice?: string; readonly notificationGateway?: NotificationGateway; readonly notificationCoordinator?: NotificationCoordinator; readonly repositoryContext?: RepositoryContextSource; readonly sourceControl?: SourceControlClient; readonly sourceControlFactory?: SourceControlClientFactory }) {
  const [preferences, setPreferences] = useState(() => preferenceStore.load());
  const [lease, setLease] = useState<ClientLease>();
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<{ readonly kind: SessionFailure; readonly message: string }>();
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [notificationNamespace, setNotificationNamespace] = useState<string>();
  const [activeNotificationCoordinator, setActiveNotificationCoordinator] = useState<NotificationCoordinator | undefined>(() => notificationCoordinator);
  const [activeSourceControl, setActiveSourceControl] = useState<SourceControlClient | undefined>(() => sourceControl);
  const [sourceControlConnected, setSourceControlConnected] = useState(false);
  const [sourceControlError, setSourceControlError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const activeCredentialVault = useRef<MemoryCredentialVault | undefined>(undefined);
  const sourceControlCredentialVault = useRef<MemoryCredentialVault | undefined>(undefined);
  const notifications = useRef(notificationGateway ?? new BrowserNotificationGateway());
  const leaseRef = useRef<ClientLease | undefined>(undefined);
  const activeEndpoint = useRef<string | undefined>(undefined);
  const preferenceSavePending = useRef(false);
  const attempt = useRef<{ readonly generation: number; readonly controller: AbortController; readonly vault?: MemoryCredentialVault }>({ generation: 0, controller: new AbortController() });

  useEffect(() => {
    leaseRef.current = lease;
  }, [lease]);

  useEffect(() => {
    if (!preferenceSavePending.current) return;
    preferenceSavePending.current = false;
    preferenceStore.save(preferences);
  }, [preferenceStore, preferences]);

  useEffect(() => () => {
    attempt.current.controller.abort();
    attempt.current.vault?.clear();
    leaseRef.current?.close();
    activeCredentialVault.current?.clear();
    sourceControlCredentialVault.current?.clear();
  }, []);

  useEffect(() => {
    if (notificationCoordinator) {
      setActiveNotificationCoordinator(notificationCoordinator);
      return;
    }
    const coordinator = new BrowserNotificationCoordinator();
    setActiveNotificationCoordinator(coordinator);
    return () => coordinator.close();
  }, [notificationCoordinator]);

  const updatePreferences = (update: DashboardPreferences | ((current: DashboardPreferences) => DashboardPreferences)) => {
    preferenceSavePending.current = true;
    setPreferences(update);
  };

  const connectSourceControl = (credential: string) => {
    if (!sourceControlFactory) return;
    const nextVault = new MemoryCredentialVault();
    nextVault.replace(credential);
    if (!nextVault.read()) {
      nextVault.clear();
      setSourceControlError("Enter a GitHub access token for this session.");
      return;
    }
    try {
      const nextClient = sourceControlFactory(nextVault.read);
      sourceControlCredentialVault.current?.clear();
      sourceControlCredentialVault.current = nextVault;
      setActiveSourceControl(nextClient);
      setSourceControlConnected(true);
      setSourceControlError(undefined);
    } catch {
      nextVault.clear();
      setSourceControlError("The GitHub connection could not be configured.");
    }
  };

  const disconnectSourceControl = () => {
    sourceControlCredentialVault.current?.clear();
    sourceControlCredentialVault.current = undefined;
    setActiveSourceControl(sourceControl);
    setSourceControlConnected(false);
    setSourceControlError(undefined);
  };

  const failSourceControlAuthentication = useCallback(() => {
    sourceControlCredentialVault.current?.clear();
    sourceControlCredentialVault.current = undefined;
    setActiveSourceControl(sourceControl);
    setSourceControlConnected(false);
    setSourceControlError("GitHub authentication failed. Enter a current token and try again.");
  }, [sourceControl]);

  const resetConnection = () => {
    attempt.current.controller.abort();
    attempt.current.vault?.clear();
    setShowOnboarding(true);
    setConnecting(false);
    setFailure(undefined);
  };

  const resetFailedConnection = () => {
    attempt.current.controller.abort();
    attempt.current.vault?.clear();
    leaseRef.current?.close();
    leaseRef.current = undefined;
    activeCredentialVault.current?.clear();
    activeCredentialVault.current = undefined;
    activeEndpoint.current = undefined;
    setNotificationNamespace(undefined);
    setLease(undefined);
    setShowOnboarding(true);
    setConnecting(false);
    setFailure(undefined);
  };

  const cancelAttempt = () => {
    const generation = attempt.current.generation + 1;
    attempt.current.controller.abort();
    attempt.current.vault?.clear();
    attempt.current = { generation, controller: new AbortController() };
    setConnecting(false);
    setFailure(undefined);
  };

  const returnToWorkspace = () => {
    cancelAttempt();
    setShowOnboarding(false);
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = formRef.current;
    if (!form || connecting) return;
    const data = new FormData(form);
    const tokenInput = form.elements.namedItem("credential") as HTMLInputElement | null;
    const endpointInput = form.elements.namedItem("endpoint") as HTMLInputElement | null;
    let rawCredential = typeof data.get("credential") === "string" ? String(data.get("credential")) : "";
    let rawEndpoint = typeof data.get("endpoint") === "string" ? String(data.get("endpoint")) : "";
    data.delete("credential");
    data.delete("endpoint");
    if (tokenInput) tokenInput.value = "";

    let baseUrl: string;
    try {
      baseUrl = normalizeAgentHostBaseUrl(rawEndpoint);
      rawEndpoint = "";
    } catch (error) {
      rawEndpoint = "";
      if (endpointInput) endpointInput.value = preferences.endpoint;
      setFailure(classifySessionFailure(error));
      return;
    }

    const generation = attempt.current.generation + 1;
    attempt.current.controller.abort();
    const controller = new AbortController();
    const attemptVault = new MemoryCredentialVault();
    attemptVault.replace(rawCredential);
    rawCredential = "";
    attempt.current = { generation, controller, vault: attemptVault };
    setConnecting(true);
    setFailure(undefined);
    let openedLease: ClientLease | undefined;
    try {
      openedLease = await connector.open({ baseUrl, credential: attemptVault.read }, controller.signal);
      await openedLease.client.discover({ signal: controller.signal });
      const nextNotificationNamespace = await notificationNamespaceFor(baseUrl);
      if (attempt.current.generation !== generation || controller.signal.aborted) {
        attemptVault.clear();
        openedLease.close();
        return;
      }
      const previousLease = leaseRef.current;
      leaseRef.current = openedLease;
      previousLease?.close();
      activeCredentialVault.current?.clear();
      activeCredentialVault.current = attemptVault;
      attempt.current = { generation, controller };
      if (activeEndpoint.current !== undefined && activeEndpoint.current !== baseUrl) {
        setWorkspaceGeneration((current) => current + 1);
      }
      activeEndpoint.current = baseUrl;
      setNotificationNamespace(nextNotificationNamespace);
      updatePreferences((current) => ({ ...current, endpoint: baseUrl }));
      setLease(openedLease);
      setShowOnboarding(false);
    } catch (error) {
      openedLease?.close();
      attemptVault.clear();
      if (attempt.current.generation !== generation || controller.signal.aborted) return;
      setFailure(classifySessionFailure(error));
    } finally {
      if (attempt.current.generation === generation) setConnecting(false);
    }
  };

  const copy = failure ? failureCopy[failure.kind] : undefined;
  return (
    <>
      {lease && activeNotificationCoordinator && notificationNamespace && <div hidden={showOnboarding}><App key={workspaceGeneration} client={lease.client} showDemoControls={false} {...(lease.repositoryContext ?? repositoryContext ? { repositoryContext: lease.repositoryContext ?? repositoryContext } : {})} {...(activeSourceControl ? { sourceControl: activeSourceControl } : {})} dailyDriver={{
        preferences,
        onPreferencesChange: updatePreferences,
        onReconnect: resetConnection,
        onTerminalFailure: resetFailedConnection,
        onClearPreferences: () => {
          preferenceSavePending.current = false;
          preferenceStore.clear();
          setPreferences(defaultPreferences);
        },
        ...(environmentNotice ? { environmentNotice } : {}),
        notificationGateway: notifications.current,
        notificationCoordinator: activeNotificationCoordinator,
        notificationNamespace,
        sourceControlSession: sourceControlFactory ? {
          status: sourceControlConnected ? "connected" : "disconnected",
          onConnect: connectSourceControl,
          onDisconnect: disconnectSourceControl,
          onAuthenticationFailure: failSourceControlAuthentication,
          ...(sourceControlError ? { error: sourceControlError } : {}),
        } : sourceControl ? { status: "fixture" } : { status: "unsupported" },
      }} /></div>}
      {showOnboarding && <main className="onboarding-shell">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <div className="onboarding-brand"><Server aria-hidden="true" /><span>Agent Host Console</span></div>
        {environmentNotice && <div className="environment-notice onboarding-notice" role="status"><ShieldAlert aria-hidden="true" />{environmentNotice}</div>}
        <p className="eyebrow">First external client</p>
        <h1 id="onboarding-title">{copy?.title ?? "Connect to your local agent-host"}</h1>
        <p className="onboarding-intro">Observe, evaluate, and operate agents through the public HTTP/SSE boundary. Provider-native internals are never required.</p>
        {copy && <div className={`recovery-callout recovery-${failure?.kind}`} role="alert">{copy.icon}<div><strong>{copy.guidance}</strong><p>{failure?.message}</p></div></div>}
        <form ref={formRef} onSubmit={(event) => void connect(event)}>
          <label><span>Agent-host endpoint</span><input name="endpoint" type="text" inputMode="url" required defaultValue={preferences.endpoint} autoComplete="url" spellCheck={false} /></label>
          <label><span>Access token <small>required for direct v1 connections; optional when a same-origin proxy injects it</small></span><input name="credential" type="password" autoComplete="off" spellCheck={false} /></label>
          <button className="primary-button" type="submit" disabled={connecting}>{connecting ? <><RotateCcw className="spin" />Checking public API…</> : "Connect securely"}</button>
          {connecting && <button className="secondary-button" type="button" onClick={cancelAttempt}>Cancel connection attempt</button>}
          {lease && <button className="secondary-button" type="button" onClick={returnToWorkspace}>Return to current workspace</button>}
        </form>
        <div className="privacy-note"><LockKeyhole aria-hidden="true" /><p><strong>Memory-only credential.</strong> The token is cleared from the form immediately and is never written to localStorage, URLs, diagnostics, or build output. Reloading a direct connection requires authentication again.</p></div>
        <details><summary>Connection requirements</summary><ul><li>Loopback HTTP or same-origin endpoint</li><li>A supported versioned public API</li><li>No provider-specific metadata dependency</li></ul></details>
      </section>
    </main>}
    </>
  );
}
