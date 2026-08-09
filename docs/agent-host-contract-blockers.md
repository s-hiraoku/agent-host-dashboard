# Agent-host contract status and blockers

Agent-host issues #2, #3, #4, #5, and #6 now publish API v1, adapter health,
browser-safe bearer authentication, bounded cursor pagination, structured
errors, sequenced SSE events, and sanitized client-conformance fixtures. The
dashboard must consume those public artifacts through `AgentHostWireProtocol`;
fixture/mock tests alone are not wire conformance.

## Confirmed client-side work

The production codec can implement the following without further backend
changes:

- version discovery and explicit API compatibility;
- provider-neutral list/detail decoding and bounded cursor pagination;
- provider/status/view/cwd/text filters and the server's fixed ordering;
- adapter readiness and sanitized failures;
- bearer authentication through fetch, including fetch-streamed SSE;
- structured HTTP errors, timeouts, cancellation, and stale-cursor recovery;
- action payloads and one logical `Idempotency-Key` retained across retries;
- separate SSE `sequence` ordering and `snapshotRevision` state tracking;
- authoritative snapshot resync after ready mismatch, sequence gap, clean EOF,
  or network disconnect.

An action's client-generated idempotency key can serve as its local correlation
ID. The backend does not need to invent an action ID or response revision; the
dashboard must not fabricate either wire field.

## Remaining backend contract gaps

### Global sorting

API v1 exposes fixed attention ordering but no sort grammar. Sorting only the
current page changes the meaning of pagination, while fetching every page is
unbounded and cannot guarantee a single snapshot revision. The daily-driver UI
requires an allowlisted server-side sort contract, or an explicit capability
that lets the UI disable unavailable sort choices without misrepresenting them.

### Accurate provider/status summaries

API v1 returns a filtered total but no provider/status facets. Page-local counts
must not be labelled as global operational summaries. Repeating filtered list
requests is non-atomic and scales with the number of providers. The API needs
revision-consistent facet counts with defined pre-filter/post-filter semantics,
or an explicit capability that lets the UI mark global summaries unavailable.

### File approval context

The public pending-approval record includes method, reason, and command, but no
sanitized file path or file-change summary. The dashboard can safely label
command approvals and can operate an opaque semantic approval ID, but it cannot
show the required file context before approving or rejecting a file change.

### Stable public project scope

The v1 summary has provider and source but no classified, stable public project
identifier. Project-scoped notification preferences therefore remain
session-only and appear only when a public project value is observed through a
future compatible contract.

## Completion rule

The connector runs pinned official fixtures through the real codec and has a live
public HTTP/SSE demo-host gate. Dashboard #1-#4 and the agent-host #11 dashboard
gate still cannot be reported complete until global sort/facet behavior and file
approval context are resolved without approximation.
