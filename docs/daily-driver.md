# Daily-driver session boundary

The dashboard starts with connection onboarding. A `ClientConnector` receives a
validated loopback or same-origin endpoint and a memory-only credential
provider, then returns a disposable `ClientLease`. The shell verifies the
public API through `AgentHostClient.discover()` before mounting the workspace.
Failed and superseded leases are closed, and stale connection attempts are
discarded by generation. A failed credential rotation leaves the verified lease
and workspace state active so the operator can return without losing work.

The development connector is a deterministic demo adapter for onboarding and
recovery tests. A persistent simulation banner states that it never contacts the
entered endpoint. It does not define agent-host paths or wire fields. Production
builds fail closed; their connector remains blocked on the confirmed
`AgentHostWireProtocol` requested in agent-host #2 and the authentication
lifecycle requested in agent-host #4.

## Credential lifetime

- The token input is uncontrolled and cleared immediately on submit.
- The credential is available only through an in-memory closure while the lease
  is active.
- Failure, connection change, page unload, and lease disposal clear it.
- Reloading requires the user to authenticate again.
- Tokens never enter URLs, localStorage, fixtures, diagnostics, or build-time
  configuration.

## Persisted preferences

`LocalPreferenceStore` is the only localStorage adapter. Its version 3 payload
contains only the canonical endpoint, status/provider/sort predicates, density,
selected columns, bounded saved-view names, and global notification-type toggles.
It strictly projects known fields, migrates versions 1 and 2, rejects
future/corrupt/oversized data, and never
persists free-text searches, agent IDs, cwd values, prompt drafts, commands,
snapshots, raw JSON, or error bodies.

Provider/project notification rules, recent agents, and sanitized action history
remain session-only until the backend contract classifies stable public identifiers
that are safe to retain. Provider/project choices accumulate from public facets,
snapshots, and events observed in the current session; complete project enumeration
remains a backend contract blocker.

## Operational memory and notifications

Desktop notification permission is requested only from the Settings button. The
dashboard never notifies for initial snapshots or revision-gap resync snapshots;
only subsequent `agent.upserted` events entering blocked, done, or error states are
eligible. Unknown prior states are suppressed rather than guessed. A session-only
cross-tab election shares only revision and transition kind, preventing duplicate
delivery without broadcasting agent data. Notification clicks revalidate the agent
through the public client before returning focus to the workspace. Global event-type
toggles persist, while provider/project scopes remain in memory. The Activity
surface keeps at most 12 recent agents and 100 action
records for the current session and provides an explicit clear operation. Action
records contain only kind, a target label, time, outcome, and a structured error
code—never agent IDs, cwd, prompt text, commands, approval payloads, or error bodies.

The Diagnostics surface exposes only version compatibility, connection/revision,
event count, and adapter health from the public domain model. It deliberately
excludes credentials and private agent/session payloads.
