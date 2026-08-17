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
entered endpoint. It does not define agent-host paths or wire fields. Agent-host
issues #2 and #4 now define the v1 wire and bearer-authentication contracts.
Production builds use the v1 codec, including additive sort, facet, project, and
file-approval fields when the host publishes them. Direct v1 connections accept the bearer
token at connection time; a same-origin proxy may inject it without exposing it
to the form. Development stays in labelled simulation mode unless
`?connector=real` is present. Unsupported global sort/facets remain visibly
unavailable rather than being approximated from the current page.

## Credential lifetime

- Agent-host and GitHub token inputs are uncontrolled and cleared immediately on
  submit.
- Each credential is available only through its own in-memory closure while its
  session is active.
- Failure, explicit disconnect, page unload, and lease disposal clear the
  applicable credential.
- Reloading requires the user to authenticate again.
- Tokens never enter URLs, localStorage, fixtures, diagnostics, or build-time
  configuration.

The Settings surface can create and disconnect a read-only GitHub session. It
does not infer a repository from cwd: GitHub requests begin only when a
`RepositoryContextSource` supplies an explicit association. The fixture connector
uses sanitized source-control data without accepting a real credential. A 401
from an associated repository clears the GitHub vault and returns Settings to a
disconnected recovery state so an expired token cannot remain labelled active.

## Persisted preferences

`LocalPreferenceStore` is the only localStorage adapter. Its version 4 payload
contains only the canonical endpoint, status/provider/sort predicates, density,
selected columns, bounded saved-view names, global notification-type toggles,
and opaque local project ids used to suppress notifications. It strictly
projects known fields, migrates versions 1 through 3, rejects
future/corrupt/oversized data, and never
persists free-text searches, agent IDs, cwd values, prompt drafts, commands,
snapshots, raw JSON, or error bodies.

Provider notification rules, recent agents, and sanitized action history
remain session-only. Local project mutes may persist because the host classifies
those ids as stable public identifiers. They never include cwd or directory
paths. Provider/project choices accumulate from public facets,
snapshots, and events observed in the current session.

## Operational memory and notifications

Desktop notification permission is requested only from the Settings button. The
dashboard never notifies for initial snapshots or revision-gap resync snapshots;
only subsequent `agent.upserted` events entering blocked, done, or error states are
eligible. Unknown prior states are suppressed rather than guessed. A session-only
cross-tab election shares only a truncated SHA-256 endpoint namespace, revision, and
transition kind, preventing duplicate delivery across tabs on the same host without
broadcasting the endpoint or agent data. Notification clicks revalidate the agent
through the public client before returning focus to the workspace. Global event-type
toggles persist, while provider/project scopes remain in memory. The Activity
surface keeps at most 12 recent agents and 100 action
records for the current session and provides an explicit clear operation. Action
records contain only kind, a target label, time, outcome, and a structured error
code—never agent IDs, cwd, prompt text, commands, approval payloads, or error bodies.

The Diagnostics surface exposes only version compatibility, connection/revision,
event count, and adapter health from the public domain model. It deliberately
excludes credentials and private agent/session payloads.
