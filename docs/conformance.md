# Conformance gates

`npm run test:contract` validates the provider-neutral semantic demo fixtures
against `contracts/demo-fixture.schema.json`. This makes accidental changes to
agent summaries, details, capabilities, health records, revisions, and events
fail CI before they reach the dashboard.

The checked-in schema is a dashboard fixture contract, not an agent-host wire
contract. Agent-host issues #2 and #6 now provide API v1 and official sanitized
client-conformance fixtures. A follow-up connector PR must consume those artifacts
directly and run them through the real HTTP/SSE codec. Until that lands, this suite
proves the provider-neutral UI boundary only; it is not evidence of wire
conformance. Remaining global sort and facet gaps are tracked in
`docs/agent-host-contract-blockers.md`.

## Local quality commands

```bash
npm run typecheck
npm run test:unit
npm run test:contract
npm run build
npm run check:assets
npm run smoke:package
npm run test:e2e:functional
npm run test:a11y
npm run test:performance
```

Playwright retains a trace and screenshot for failed tests under
`test-results/playwright/`; CI uploads these together with the HTML report.
