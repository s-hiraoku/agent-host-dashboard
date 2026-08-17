# Agent-host contract status and blockers

Agent-host issues #2, #3, #4, #5, #6, and #11 now publish API v1, adapter health,
browser-safe bearer authentication, bounded cursor pagination, structured
errors, sequenced SSE events, allowlisted global sort, revision-consistent
facets, stable local project ids, sanitized file-change approval context, and
sanitized client-conformance fixtures. The dashboard consumes those public
artifacts through `AgentHostWireProtocol`.

## Confirmed client-side work

The production codec implements the following:

- version discovery and explicit API compatibility;
- provider-neutral list/detail decoding and bounded cursor pagination;
- provider/status/view/cwd/text filters;
- allowlisted complete-snapshot sorting (`attention`, `name`, `activity`, `provider`, `status`);
- same-revision provider/status facets with opposite-facet filter semantics;
- local `project: { id, name, scope }` associations;
- adapter readiness and sanitized failures;
- bearer authentication through fetch, including fetch-streamed SSE;
- structured HTTP errors, timeouts, cancellation, and stale-cursor recovery;
- action payloads and one logical `Idempotency-Key` retained across retries;
- separate SSE `sequence` ordering and `snapshotRevision` state tracking;
- authoritative snapshot resync after ready mismatch, sequence gap, clean EOF,
  or network disconnect;
- fail-closed file-change approval context (`actionable`, sanitized `files`);
- versioned repository associations (`/v1/capabilities`, per-agent no-store detail,
  redacted `agent.repository-associations.changed` invalidations).

An action's client-generated idempotency key can serve as its local correlation
ID. The backend does not need to invent an action ID or response revision; the
dashboard must not fabricate either wire field.

## Remaining backend contract gaps

None for the current dashboard MVP slice. Local `project` ids still group equal
normalized working directories on one machine; they are not forge repositories.

## Completion rule

Sort, facets, file-change approvals, local project ids, and repository
associations are decoded from the pinned official fixtures.
