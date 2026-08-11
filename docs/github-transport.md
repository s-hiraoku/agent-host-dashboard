# GitHub read-only transport

`GitHubRestClient` implements the framework-independent `SourceControlClient`. It uses only read-only GitHub REST endpoints:

- `GET /repos/{owner}/{repo}`
- `GET /repos/{owner}/{repo}/issues`
- `GET /repos/{owner}/{repo}/pulls`
- `GET /repos/{owner}/{repo}/pulls/{pull_number}` for explicitly associated PRs

The client pins `X-GitHub-Api-Version: 2026-03-10`, sends the recommended `application/vnd.github+json` media type, uses browser-compatible redirect following, and rejects a final response URL outside the configured API origin. Fetch strips credentials during a cross-origin redirect; the client then fails the request instead of decoding that response. Unconfigured hosts are rejected before requesting credentials. GitHub.com is configured by default. GitHub Enterprise requires an explicit host-to-HTTPS-API-endpoint mapping.

## Authentication

Authentication is an ephemeral, host-keyed callback evaluated immediately before a network request. Host validation runs first, so a credential is never requested for an unconfigured origin and GitHub Enterprise credentials can remain isolated from GitHub.com. The client never accepts a token in repository/domain objects, never persists it, and does not include upstream response bodies in structured errors. A future onboarding surface must keep the credential in the current in-memory connection lease and request only the minimum read permissions required for repository metadata, Issues, and pull requests.

## Caching and rate limits

Successful GET responses use a short, size-bounded in-memory TTL and ETag revalidation. Cache keys are separated by a one-way SHA-256 credential scope so rotating or removing a credential cannot return data from the prior session; token plaintext is not retained. Nothing is written to browser storage. Cursor pagination follows GitHub's `Link` header while exposing only a validated numeric page cursor. Primary rate-limit headers are returned with each page; 403 exhaustion and 429 responses become retryable `rate_limited` errors with `retryAt` when GitHub supplies it.

The repository Issues endpoint also returns pull requests, so the decoder explicitly removes entries with a `pull_request` field. Search, multi-state, draft, merged, and relationship filters are applied to the current bounded page when the REST list endpoint cannot express them directly. The UI must label this as filtering the loaded page and continue pagination when the user asks for more results.

## Deliberately unknown fields

The list-pull-requests endpoint does not provide aggregate check-run or final review decisions. This transport returns `unknown` for those two fields instead of issuing an N+1 request for every pull request or guessing. A later bounded enrichment path may add them with deduplication, limited concurrency, cancellation, cache validators, and rate-limit budgeting.

References: [GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions), [Issues endpoints](https://docs.github.com/en/rest/issues/issues), [pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls), and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
