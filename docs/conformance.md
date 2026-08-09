# Conformance gates

`npm run test:contract` validates the provider-neutral semantic demo fixtures
against `contracts/demo-fixture.schema.json`. This makes accidental changes to
agent summaries, details, capabilities, health records, revisions, and events
fail CI before they reach the dashboard.

The checked-in schema is a dashboard fixture contract, not a guessed agent-host
wire contract. The final `AgentHostWireProtocol` codec and live conformance job
remain blocked on the versioned API and deterministic demo artifacts requested
in agent-host issues #2 and #6. Once those artifacts exist, CI will run this same
semantic suite through the real HTTP/SSE adapter and treat any decode or schema
failure as a breaking backend change.

## Local quality commands

```bash
npm run test:unit
npm run test:contract
npm run build
npm run check:assets
npm run test:e2e:functional
npm run test:a11y
npm run test:performance
```

Playwright retains a trace and screenshot for failed tests under
`test-results/playwright/`; CI uploads these together with the HTML report.
