# Agent-host contract blockers

Dashboard development can proceed through the provider-neutral client boundary and sanitized fixtures. Production HTTP/SSE conformance remains blocked until the backend issues below publish and test a versioned public contract.

## agent-host #2 — public API and event contract

Required decisions:

- version discovery response, compatibility policy, and incompatible-version error/status;
- bounded list pagination cursor, stable ordering, filter/sort grammar, and snapshot revision;
- provider-neutral summary, detail, capabilities, approvals, and public-data schemas;
- structured error envelope with stable code, retryability, request ID, and safe details;
- SSE event ID/revision, ordering, duplicate semantics, retention, heartbeat, retry, and resume-after-revision;
- lossless handoff between snapshot revision and the resumed event stream;
- action requests/results, idempotency, conflicts, and target revision/precondition for prompt, interrupt, approve, and reject;
- public/private field classification and required redaction.

The snapshot/event handoff must guarantee that an event occurring between snapshot creation and stream subscription is either replayed by `events-after-revision` or detected as a gap. A `/v1` path alone is not a compatibility signal.

## agent-host #3 — adapter health

Required provider-neutral fields: adapter ID/label, starting/healthy/degraded/unavailable state, last attempt, last success, bounded duration, agent count, sanitized error code/message/retryability, and semantic health-change events.

## agent-host #4 — browser safety and authentication

Required decisions: bearer-token bootstrap/rotation, sensitive endpoint coverage, Host/Origin/CORS policy, JSON content-type and body limits, loopback versus remote connection policy, audit event schema, and redacted authorization errors. Browser SSE authentication must support fetch-streaming Authorization headers or define an equally safe non-query alternative.

## agent-host #6 — fixtures and conformance

Required artifacts: deterministic sanitized snapshot/event/action/error fixtures, a 1,000-agent fixture, reconnect and revision-gap scenarios, schema identifiers, and a reusable conformance command. Fixtures must contain no tokens, local user paths, session content, or provider-native private metadata.

## Completion rule

The dashboard's fixture/mock tests do not count as agent-host API conformance. Conformance is complete only when the confirmed codec passes the official backend fixtures/suite and the integrated HTTP/SSE tests. Until then the dashboard PR is implementation-complete only on the client-boundary side and carries this backend blocker.
