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

Repository and GitHub Issue/PR work uses two additional framework-independent
ports: `RepositoryContextSource` for agent-to-repository association and
`SourceControlClient` for read-only forge queries. The separation prevents the
dashboard from inventing fields that are not present in the confirmed agent-host
API. See [docs/architecture/repository-context.md](docs/architecture/repository-context.md).
The read-only GitHub REST adapter and its authentication/cache limits are
documented in [docs/github-transport.md](docs/github-transport.md).

## Current API compatibility

Agent-host API v1 now publishes version discovery, bounded snapshots, adapter
health, structured errors, bearer authentication, idempotent actions, sequenced
SSE events, and sanitized client-conformance fixtures. The dashboard production
codec implements those confirmed v1 fields. API v1 still has fixed server
ordering and no global provider/status facets, so the UI disables alternate sorts
and renders unavailable global counts as dashes instead of presenting page-local
approximations as operational truth.

The client therefore ships:

- stable provider-neutral domain and `AgentHostClient` interfaces;
- an injectable `AgentHostWireProtocol` boundary for the v1 codec;
- a fetch HTTP/SSE channel with transient authentication injection;
- deterministic sanitized fixtures and a semantic mock transport;
- connection lifecycle, reconnect/backoff, revision-gap detection, and snapshot resync behavior.

Supported API versions are explicitly supplied when constructing
`DefaultAgentHostClient`; an unknown version fails closed. The v1 codec keeps SSE
sequence and snapshot revision separate and performs mandatory snapshot resync
after ready mismatch, sequence gap, clean EOF, or network disconnect. Unsupported
sort/facet behavior remains unavailable rather than being guessed. See
[docs/agent-host-contract-blockers.md](docs/agent-host-contract-blockers.md).

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

The development server starts with connection onboarding in an explicitly
labelled fixture-only simulation mode. Add `?connector=real` to exercise the
public v1 connector against a running host; production builds use that connector
by default. The deterministic
evaluation workspace remains available at `/?fixture=live`; its **Demo state**
control reproduces live, blocked, error, disconnected, stale, unauthorized, and
incompatible states without a running host. The UI paginates the 1,000-agent
fixture in bounded 50-agent pages rather than mounting all records in the DOM.

`npm run check` runs strict type checking, unit tests, and the production
dashboard and client-module build.

### Preparing a local-host connector

The framework-independent fetch channel can target the same-origin `/agent-host`
path. During development, Vite can proxy that path to a loopback host:

```bash
AGENT_HOST_URL=http://127.0.0.1:9417 npm run dev
```

The confirmed backend authentication contract requires a bearer token. A
development-only proxy can receive it from `AGENT_HOST_TOKEN`; it is never
compiled into browser assets or written to browser storage. The real onboarding
flow also accepts the token at runtime and keeps it only in the active in-memory
lease. Direct browser connections require the dashboard origin in
`AGENT_HOST_ALLOWED_ORIGINS`; same-origin proxy connections use `/agent-host`.

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

## Quality gates

Unit, semantic fixture-contract, production asset, browser E2E, accessibility,
keyboard, narrow viewport, reconnect/resync, and 1,000-agent performance gates
are reproducible with the commands in
[docs/conformance.md](docs/conformance.md). Failed Playwright runs retain a
screenshot and trace, and CI uploads those artifacts with the HTML report.

## Daily-driver session

The default app entry opens first-run connection onboarding. Credentials live
only in memory and are cleared on failure, connection change, or reload. The
dashboard persists only a strict, versioned projection of non-secret appearance
and semantic filter preferences plus global notification-type toggles. Recent
agents, sanitized action history, and provider/project notification scopes stay
session-only. See
[docs/daily-driver.md](docs/daily-driver.md) for the connector lease, privacy
boundary, migration behavior, and current backend dependencies.
