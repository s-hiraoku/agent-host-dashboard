# agent-host-dashboard

The first external client for [agent-host](https://github.com/s-hiraoku/agent-host). The dashboard is designed as a calm, data-dense local operations console for observing, evaluating, and safely controlling supported agents through the public HTTP/SSE API.

## Architecture

```text
UI
  ↓
dashboard domain / use cases
  ↓
AgentHostClient
  ↓
AgentHostTransport + versioned wire protocol
  ↓
HTTP / fetch-streamed SSE
  ↓
agent-host
```

`src/domain.ts`, `src/client.ts`, and `src/connection.ts` are framework-independent. UI code must not import endpoint paths, wire codecs, or provider-native metadata. A future native client can implement `AgentHostTransport` without depending on the dashboard framework.

## Current API compatibility

No agent-host version currently provides the confirmed public contract required by dashboard issue #1. The current host `0.2.0` endpoints were inspected, but are intentionally not encoded as the stable dashboard contract because they lack version discovery, bounded snapshots, adapter health, structured errors, event revisions/resume, and browser authentication hardening.

The client therefore ships:

- stable provider-neutral domain and `AgentHostClient` interfaces;
- an injectable `AgentHostWireProtocol` boundary for the eventual confirmed codec;
- a fetch HTTP/SSE channel with transient authentication injection;
- deterministic sanitized fixtures and a semantic mock transport;
- connection lifecycle, reconnect/backoff, revision-gap detection, and snapshot resync behavior.

Supported API versions are explicitly supplied when constructing `DefaultAgentHostClient`; an unknown version fails closed. A production codec will be added only after the backend contract is confirmed. See [docs/agent-host-contract-blockers.md](docs/agent-host-contract-blockers.md).

## Authentication and local connection

`FetchHttpChannel` defaults to the same-origin `/agent-host` path so a development or packaged proxy can connect to loopback agent-host without permissive CORS. Authentication is injected by a callback and is kept in memory:

```ts
const channel = new FetchHttpChannel({
  baseUrl: "/agent-host",
  authentication: () => transientToken ? { scheme: "Bearer", token: transientToken } : undefined,
});
```

Tokens must not be placed in URLs, localStorage, fixtures, logs, diagnostics, or build-time environment variables. The channel refuses credentials/query parameters in its base URL, refuses remote plaintext HTTP, and only allows remote HTTPS after explicit opt-in. SSE uses fetch streaming instead of native `EventSource`, because `EventSource` cannot inject the required Authorization header.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
npm run check
```

The development server starts the dashboard with the deterministic 1,000-agent
fixture. Use the **Demo state** control to reproduce live, blocked, error,
disconnected, stale, unauthorized, and incompatible states without a running
host. The UI paginates the fixture in bounded 50-agent pages rather than
mounting all records in the DOM.

`npm run check` runs strict type checking, unit tests, and the production
dashboard and client-module build.

### Connecting a local host

The browser always calls the same-origin `/agent-host` path. During development,
Vite can proxy that path to a loopback host:

```bash
AGENT_HOST_URL=http://127.0.0.1:9417 npm run dev
```

If the confirmed backend authentication contract requires a bearer token, pass
it only to the server-side development process with `AGENT_HOST_TOKEN`. Vite
injects the header while proxying; it is never compiled into browser assets or
written to browser storage. The production app still requires a confirmed
`AgentHostWireProtocol` implementation before it can connect to agent-host.

## Dashboard interaction model

The main workspace keeps provider-neutral operational context visible: status,
capabilities, working directory, source, last activity, adapter health, and the
semantic live event stream. Raw public API JSON is isolated in a collapsed
developer panel.

Actions are capability-gated. Prompt, interrupt, approve, and reject operations
open a contextual confirmation showing the exact target and working directory.
Approval requests also show their reason, command, or file path. Enter and
Escape never act as semantic approval or rejection; users must choose the
explicit action button.

## Fixtures

`src/testing/fixtures.ts` contains deterministic public-domain records for idle, working, blocked, done, error, and unknown states, including a 1,000-agent generator. It contains no tokens, user home paths, provider-native session payloads, or personal prompt content.
