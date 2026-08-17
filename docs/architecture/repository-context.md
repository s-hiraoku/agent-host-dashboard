# Repository and source-control boundary

Issue #12 adds repository context without inferring an unpublished wire format.

```text
UI
  ↓
dashboard repository use cases
  ├─ RepositoryContextSource
  │    ↓ AgentHostRepositoryContextSource
  │  AgentHostV1Protocol / public HTTP+SSE
  └─ SourceControlClient
       ↓
     GitHub transport
```

`RepositoryContextSource` answers which repositories an agent is associated with.
Production mode uses `GET /v1/capabilities` and
`GET /v1/agents/{id}/repository-associations?version=1`. A 404 on the capability
endpoint means the host is unsupported. Per-agent `unsupported` / `unavailable` /
stale / partial results are preserved instead of being approximated.

The adapter maps only `forge: "github"` named coordinates onto
`GitHubRepositoryLocator`. Opaque coordinates and other forges are dropped and
mark the result incomplete. Local `project` ids are not repository associations.

`SourceControlClient` remains a framework-independent, read-only query boundary
for repository, Issue, and pull-request summaries. Authentication is a transport
concern and is intentionally absent from domain and client method arguments.

SSE `agent.repository-associations.changed` contains only agent and snapshot
revision coordinates. Clients subscribe before the first association fetch and
refetch after every association-changed event, reconnect, or sequence gap.

## Association semantics

- `confirmed` requires explicit association evidence. Only a confirmed association may carry an explicit pull-request number.
- `candidate` records a repository, branch, or adapter-heuristic match that still needs user judgment.
- A branch match also requires the pull-request head owner to match the structured repository owner; a same-named branch in another fork is not evidence.
- `repository_wide` means the pull request belongs to the repository but has no agent-specific evidence.

Repository equality uses structured `service`, `host`, `owner`, and `name` fields. The optional `repositoryId` is enrichment and never changes equality when one response omits it. URLs are navigation targets, not identity or correlation inputs. GitHub.com is the first transport target; retaining `host` prevents a future GitHub Enterprise migration from changing the domain shape.

## Privacy and persistence policy

Source-control credentials must be injected into a future transport by an ephemeral credential provider. Tokens must never enter React state, domain results, fixtures, diagnostics, action history, logs, browser storage, screenshots, traces, or build artifacts.

The existing persisted preference allowlist remains limited to presentation and notification preferences. Repository names, URLs, Issue/PR titles, authors, branches, worktrees, and source-control responses are session data and are not persisted. Demo and CI browser artifacts must be generated exclusively from the sanitized fixtures under `src/testing/repositories`.

## Performance contract

Requests are cursor-paginated and capped at 100 items. Callers must deduplicate repository locators before querying. The GitHub transport follow-up must add bounded concurrency, cancellation, conditional requests/TTL caching, and rate-limit metadata rather than issuing one request per visible agent.

The repository tests under `test/repositories` cover dashboard domain, fixture consumers, and the production association adapter. Official host fixtures in `contracts/agent-host-v1/repository-associations.json` drive the v1 codec.
