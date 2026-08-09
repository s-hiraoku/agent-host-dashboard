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

`LocalPreferenceStore` is the only localStorage adapter. Its version 2 payload
contains only the canonical endpoint, status/provider/sort predicates, density,
selected columns, and bounded saved-view names. It strictly projects known
fields, migrates version 1, rejects future/corrupt/oversized data, and never
persists free-text searches, agent IDs, cwd values, prompt drafts, commands,
snapshots, raw JSON, or error bodies.

Project rules and recent-agent persistence remain intentionally absent until
the backend contract classifies stable public identifiers that are safe to
retain. They are tracked for the operational-memory follow-up to dashboard #4.
