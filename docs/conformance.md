# Conformance gates

`npm run test:contract` validates the provider-neutral semantic demo fixtures
against `contracts/demo-fixture.schema.json`. This makes accidental changes to
agent summaries, details, capabilities, health records, revisions, and events
fail CI before they reach the dashboard.

The checked-in schema is a dashboard fixture contract, not an agent-host wire
contract. Agent-host API v1 now includes official sanitized client-conformance
fixtures for list sorting/facets/project identity, file-change approvals, and
versioned repository associations. `contracts/agent-host-v1/` pins those
language-neutral fixtures at the audited companion commit. `npm run test:contract`
drives the v1 codec from them, and `npm run test:conformance:live` starts from the
built client module and verifies a real demo host only through public HTTP/SSE.
CI checks out the pinned agent-host commit for that live gate.

## Local quality commands

```bash
npm run typecheck
npm run test:unit
npm run test:contract
npm run test:conformance:live # requires the pinned demo host and test env vars
npm run build
npm run check:assets
npm run smoke:package
npm run test:e2e:functional
npm run test:a11y
npm run test:performance
```

Playwright retains a trace and screenshot for failed tests under
`test-results/playwright/`; CI uploads these together with the HTML report.

## Live v1 gate

The live command expects the pinned agent-host demo on port 48777. From a sibling
`agent-host` checkout at commit
`92fcec225820dea26f31dd02ff4a7f29de55b227`, start it with a disposable test
credential:

```bash
AGENT_HOST_API_TOKEN=dashboard-conformance-token-0001 \
AGENT_HOST_PORT=48777 \
AGENT_HOST_REFRESH_MS=60000 \
npm run demo
```

Then run from this repository:

```bash
AGENT_HOST_BASE_URL=http://127.0.0.1:48777 \
AGENT_HOST_API_TOKEN=dashboard-conformance-token-0001 \
npm run test:conformance:live
```

The fixed value is test-only and never used for a real host. CI creates it only
inside the isolated job. The runner prints semantic counts, revision, sequence,
and authorization outcome; it never prints the bearer token, prompt body,
command, cwd, or private session data.
