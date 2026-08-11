# Repository and source-control boundary

Issue #12 adds repository context without treating an unfinished agent-host wire format as settled.

```text
UI
  ↓
dashboard repository use cases
  ├─ RepositoryContextSource
  │    ↓ (future adapter, after a versioned public contract exists)
  │  AgentHostClient / public HTTP+SSE
  └─ SourceControlClient
       ↓
     GitHub transport
```

`RepositoryContextSource` answers which repositories an agent is associated with. The checked-in implementation is a sanitized fixture only. The production agent-host v1 decoder is unchanged because v1 does not yet expose a stable repository association.

`SourceControlClient` is a framework-independent, read-only query boundary for repository, Issue, and pull-request summaries. Authentication is a transport concern and is intentionally absent from domain and client method arguments.

## Association semantics

- `confirmed` requires explicit association evidence. Only a confirmed association may carry an explicit pull-request number.
- `candidate` records a repository or branch match that still needs user judgment.
- `repository_wide` means the pull request belongs to the repository but has no agent-specific evidence.

Repository equality uses structured `service`, `host`, `owner`, and `name` fields. The optional `repositoryId` is enrichment and never changes equality when one response omits it. URLs are navigation targets, not identity or correlation inputs. GitHub.com is the first transport target; retaining `host` prevents a future GitHub Enterprise migration from changing the domain shape.

## Privacy and persistence policy

Source-control credentials must be injected into a future transport by an ephemeral credential provider. Tokens must never enter React state, domain results, fixtures, diagnostics, action history, logs, browser storage, screenshots, traces, or build artifacts.

The existing persisted preference allowlist remains limited to presentation and notification preferences. Repository names, URLs, Issue/PR titles, authors, branches, worktrees, and source-control responses are session data and are not persisted. Demo and CI browser artifacts must be generated exclusively from the sanitized fixtures under `src/testing/repositories`.

## Performance contract

Requests are cursor-paginated and capped at 100 items. Callers must deduplicate repository locators before querying. The GitHub transport follow-up must add bounded concurrency, cancellation, conditional requests/TTL caching, and rate-limit metadata rather than issuing one request per visible agent.

These tests are dashboard domain and fixture-consumer tests. They are not agent-host API conformance; production conformance will be added only after the backend publishes the versioned association contract.
