// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultAgentHostClient } from "../src/client.js";
import { DailyDriverShell } from "../src/daily/DailyDriverShell.js";
import { LocalPreferenceStore, MemoryPreferenceStore, preferenceStorageKey } from "../src/daily/preferences.js";
import type { ClientConnector, ClientLease, SourceControlClientFactory } from "../src/daily/session.js";
import { AgentHostError } from "../src/errors.js";
import { SourceControlError } from "../src/repositories/source-control.js";
import { createLargeDemoSnapshot } from "../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../src/testing/mock-transport.js";
import { MockRepositoryContextSource, MockSourceControlClient } from "../src/testing/repositories/mock-clients.js";

class RecordingStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixtureLease(close = vi.fn()): ClientLease {
  const transport = new MockAgentHostTransport();
  transport.currentSnapshot = createLargeDemoSnapshot();
  transport.holdEventStreams = true;
  return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close };
}

afterEach(cleanup);

describe("daily-driver shell", () => {
  it("clears the form credential and persists only the normalized endpoint", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    let observedCredential: string | undefined;
    const connector: ClientConnector = {
      async open(input) {
        observedCredential = input.credential();
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close() {} };
      },
    };
    const storage = new RecordingStorage();
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new LocalPreferenceStore(storage)} />);
    const generatedCredential = globalThis.crypto.randomUUID();

    await user.clear(screen.getByLabelText("Agent-host endpoint"));
    await user.type(screen.getByLabelText("Agent-host endpoint"), "http://localhost:8787");
    await user.type(screen.getByLabelText(/Access token/), `  ${generatedCredential}  `);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    expect(observedCredential).toBe(generatedCredential);
    expect(screen.queryByDisplayValue(generatedCredential)).not.toBeInTheDocument();
    const serialized = storage.values.get(preferenceStorageKey) ?? "";
    expect(serialized).toContain("http://localhost:8787/");
    expect(serialized).not.toContain(generatedCredential);
  });

  it("keeps the GitHub credential in memory and clears it on disconnect", async () => {
    const connector: ClientConnector = { async open() { return fixtureLease(); } };
    const storage = new RecordingStorage();
    let readCredential: (() => string | undefined) | undefined;
    const sourceControlFactory: SourceControlClientFactory = (credential) => {
      readCredential = credential;
      return new MockSourceControlClient();
    };
    const user = userEvent.setup();
    const view = render(<DailyDriverShell connector={connector} preferenceStore={new LocalPreferenceStore(storage)} sourceControlFactory={sourceControlFactory} />);
    const secret = globalThis.crypto.randomUUID();

    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText("GitHub access token"), `  ${secret}  `);
    await user.click(screen.getByRole("button", { name: "Use for this session" }));

    expect(readCredential?.()).toBe(secret);
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(screen.getByText("connected")).toBeInTheDocument();
    expect(JSON.stringify([...storage.values])).not.toContain(secret);

    await user.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    expect(readCredential?.()).toBeUndefined();
    expect(screen.getByText("disconnected")).toBeInTheDocument();

    await user.type(screen.getByLabelText("GitHub access token"), secret);
    await user.click(screen.getByRole("button", { name: "Use for this session" }));
    expect(readCredential?.()).toBe(secret);
    view.unmount();
    expect(readCredential?.()).toBeUndefined();
  });

  it("rejects an empty GitHub credential without creating a client", async () => {
    const sourceControlFactory = vi.fn(() => new MockSourceControlClient());
    const user = userEvent.setup();
    render(<DailyDriverShell connector={{ async open() { return fixtureLease(); } }} preferenceStore={new MemoryPreferenceStore()} sourceControlFactory={sourceControlFactory} />);

    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const input = screen.getByLabelText("GitHub access token");
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Use for this session" }));

    expect(sourceControlFactory).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a GitHub access token for this session.")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("clears a rejected GitHub credential and returns Settings to recovery", async () => {
    const rejected = new MockSourceControlClient();
    const repository = vi.spyOn(rejected, "repository").mockRejectedValue(new SourceControlError("unauthorized", "Rejected test credential."));
    let readCredential: (() => string | undefined) | undefined;
    const user = userEvent.setup();
    render(<DailyDriverShell
      connector={{ async open() { return fixtureLease(); } }}
      preferenceStore={new MemoryPreferenceStore()}
      repositoryContext={new MockRepositoryContextSource()}
      sourceControlFactory={(credential) => { readCredential = credential; return rejected; }}
    />);

    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText("GitHub access token"), "rejected-session-secret");
    await user.click(screen.getByRole("button", { name: "Use for this session" }));
    await user.click(screen.getAllByRole("button", { name: "Workspace" })[0]!);

    await waitFor(() => expect(repository).toHaveBeenCalled());
    await waitFor(() => expect(readCredential?.()).toBeUndefined());
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    expect(screen.getByText("GitHub authentication failed. Enter a current token and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub access token")).toHaveValue("");
  });

  it("restores non-secret preferences with an empty credential after reload", async () => {
    const storage = new RecordingStorage();
    const store = new LocalPreferenceStore(storage);
    store.save({ ...store.load(), endpoint: "http://127.0.0.1:9000/", density: "compact" });
    const connector: ClientConnector = { async open() { throw new Error("not called"); } };
    render(<DailyDriverShell connector={connector} preferenceStore={store} />);

    expect(screen.getByLabelText("Agent-host endpoint")).toHaveValue("http://127.0.0.1:9000/");
    expect(screen.getByLabelText(/Access token/)).toHaveValue("");
    expect(screen.getByText(/Reloading a direct connection requires authentication again/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect securely" })).toBeEnabled());
  });

  it("allows a same-origin proxy connection without a form credential", async () => {
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.holdEventStreams = true;
    let observedCredential: string | undefined = "not-called";
    const connector: ClientConnector = {
      async open(input) {
        observedCredential = input.credential();
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close() {} };
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);

    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    expect(observedCredential).toBeUndefined();
  });

  it("preserves filter, selection, and draft while rotating the client lease", async () => {
    const connector: ClientConnector = {
      async open() {
        const transport = new MockAgentHostTransport();
        transport.currentSnapshot = createLargeDemoSnapshot();
        transport.holdEventStreams = true;
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close() {} };
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.selectOptions(await screen.findByLabelText("Status"), "working");
    await user.click(await screen.findByRole("button", { name: /Sanitized agent 0001/ }));
    await user.type(await screen.findByLabelText("Prompt"), "Keep during credential rotation");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    expect(await screen.findByRole("heading", { name: "Connect to your local agent-host" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    await user.click((await screen.findAllByRole("button", { name: "Workspace" }))[0]!);
    expect(await screen.findByLabelText("Status")).toHaveValue("working");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Keep during credential rotation");
    expect(screen.getByRole("button", { name: /Sanitized agent 0001/ })).toHaveAttribute("aria-current", "true");
  });

  it("resets host-scoped selection and drafts when the canonical endpoint changes", async () => {
    let calls = 0;
    const connector: ClientConnector = {
      async open() {
        calls += 1;
        if (calls === 1) return fixtureLease();
        const transport = new MockAgentHostTransport();
        transport.holdEventStreams = true;
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close() {} };
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.selectOptions(await screen.findByLabelText("Status"), "working");
    await user.click(await screen.findByRole("button", { name: /Sanitized agent 0001/ }));
    await user.type(await screen.findByLabelText("Prompt"), "Must not cross hosts");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.clear(screen.getByLabelText("Agent-host endpoint"));
    await user.type(screen.getByLabelText("Agent-host endpoint"), "http://127.0.0.1:9000");
    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(await screen.findByRole("heading", { name: "Review orbital parser" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toHaveValue("");
    expect(screen.queryByText("Sanitized agent 0001")).not.toBeInTheDocument();
  });

  it("disposes the active lease and credential after a terminal session failure", async () => {
    let releaseStream: () => void = () => undefined;
    const close = vi.fn();
    let credential: (() => string | undefined) | undefined;
    const transport = new MockAgentHostTransport();
    transport.currentSnapshot = createLargeDemoSnapshot();
    transport.eventStreamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    transport.eventStreams = [new AgentHostError("unauthorized", "Session credential expired.")];
    const connector: ClientConnector = {
      async open(input) {
        credential = input.credential;
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close };
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    await user.type(screen.getByLabelText(/Access token/), "expired-session-secret");
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    releaseStream();
    await user.click(await screen.findByRole("button", { name: "Review connection" }));

    expect(await screen.findByRole("heading", { name: "Connect to your local agent-host" })).toBeInTheDocument();
    expect(credential?.()).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a superseded lease returned by a cancelled slow open and clears its credential", async () => {
    const first = deferred<ClientLease>();
    const staleClose = vi.fn();
    let firstCredential: (() => string | undefined) | undefined;
    let calls = 0;
    const connector: ClientConnector = {
      async open(input) {
        calls += 1;
        if (calls === 1) {
          firstCredential = input.credential;
          return await first.promise;
        }
        return fixtureLease();
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    const secret = globalThis.crypto.randomUUID();
    await user.type(screen.getByLabelText(/Access token/), secret);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    expect(firstCredential?.()).toBe(secret);

    await user.click(screen.getByRole("button", { name: "Cancel connection attempt" }));
    expect(firstCredential?.()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();

    first.resolve(fixtureLease(staleClose));
    await waitFor(() => expect(staleClose).toHaveBeenCalledOnce());
  });

  it("closes a lease whose discovery is superseded by a newer connection", async () => {
    const discovery = deferred<void>();
    const staleClose = vi.fn();
    let calls = 0;
    const connector: ClientConnector = {
      async open() {
        calls += 1;
        if (calls > 1) return fixtureLease();
        const transport = new MockAgentHostTransport();
        transport.discover = async () => {
          await discovery.promise;
          return transport.apiInfo;
        };
        return { client: new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] }), close: staleClose };
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.click(screen.getByRole("button", { name: "Cancel connection attempt" }));
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    expect(await screen.findByText("50 shown of 1000")).toBeInTheDocument();
    discovery.resolve();
    await waitFor(() => expect(staleClose).toHaveBeenCalledOnce());
  });

  it("clears the pending credential and closes a late lease after unmount", async () => {
    const pending = deferred<ClientLease>();
    const lateClose = vi.fn();
    let credential: (() => string | undefined) | undefined;
    const connector: ClientConnector = {
      async open(input) {
        credential = input.credential;
        return await pending.promise;
      },
    };
    const user = userEvent.setup();
    const view = render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    const secret = globalThis.crypto.randomUUID();
    await user.type(screen.getByLabelText(/Access token/), secret);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    expect(credential?.()).toBe(secret);

    view.unmount();
    expect(credential?.()).toBeUndefined();
    pending.resolve(fixtureLease(lateClose));
    await waitFor(() => expect(lateClose).toHaveBeenCalledOnce());
  });

  it("keeps the old lease, credential, and draft through a failed rotation", async () => {
    const oldClose = vi.fn();
    let oldCredential: (() => string | undefined) | undefined;
    let calls = 0;
    const connector: ClientConnector = {
      async open(input) {
        calls += 1;
        if (calls === 1) {
          oldCredential = input.credential;
          return fixtureLease(oldClose);
        }
        if (calls === 2) throw new AgentHostError("unauthorized", "Rejected test credential.");
        return fixtureLease();
      },
    };
    const user = userEvent.setup();
    render(<DailyDriverShell connector={connector} preferenceStore={new MemoryPreferenceStore()} />);
    await user.type(screen.getByLabelText(/Access token/), "first-session-secret");
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.selectOptions(await screen.findByLabelText("Status"), "working");
    await user.click(await screen.findByRole("button", { name: /Sanitized agent 0001/ }));
    await user.type(await screen.findByLabelText("Prompt"), "Retain this draft");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(await screen.findByRole("heading", { name: "Authentication failed" })).toBeInTheDocument();
    expect(oldClose).not.toHaveBeenCalled();
    expect(oldCredential?.()).toBe("first-session-secret");
    await user.click(screen.getByRole("button", { name: "Return to current workspace" }));
    expect(screen.getByLabelText("Prompt")).toHaveValue("Retain this draft");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "Connect securely" }));
    await user.click((await screen.findAllByRole("button", { name: "Workspace" }))[0]!);
    expect(screen.getByLabelText("Prompt")).toHaveValue("Retain this draft");
    expect(oldClose).toHaveBeenCalledOnce();
    expect(oldCredential?.()).toBeUndefined();
  });

  it("rejects endpoints containing embedded secrets without calling or persisting them", async () => {
    const storage = new RecordingStorage();
    const connector = { open: vi.fn() } satisfies ClientConnector;
    const user = userEvent.setup();
    const view = render(<DailyDriverShell connector={connector} preferenceStore={new LocalPreferenceStore(storage)} />);
    const secret = globalThis.crypto.randomUUID();
    const unsafeEndpoint = `http://user:${secret}@localhost:8787/path?token=${secret}#${secret}`;
    await user.clear(screen.getByLabelText("Agent-host endpoint"));
    await user.type(screen.getByLabelText("Agent-host endpoint"), unsafeEndpoint);
    await user.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(await screen.findByRole("heading", { name: "Connection could not be opened" })).toBeInTheDocument();
    expect(connector.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Agent-host endpoint")).toHaveValue("http://127.0.0.1:4777/");
    expect(storage.values.get(preferenceStorageKey) ?? "").not.toContain(secret);
    expect(view.container.innerHTML).not.toContain(secret);
  });
});
