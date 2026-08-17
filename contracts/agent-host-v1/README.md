# Pinned agent-host v1 fixtures

These files are copied verbatim from
`s-hiraoku/agent-host@92fcec225820dea26f31dd02ff4a7f29de55b227` under
`fixtures/client-conformance/`. They are sanitized, language-neutral public
contract artifacts used to drive the dashboard's real v1 codec tests.

`large-list.json` is intentionally not duplicated because its upstream blob is
544,491 bytes. `manifest.json` pins its Git blob SHA and required 1,000-agent
cardinality; the dashboard's bounded-DOM performance gate covers the same scale.

This pin includes additive `list-features.json`, `file-approval.json`, and
`repository-associations.json`. Run an upstream fixture audit before changing any
pinned file or commit: confirm the Git blob SHA of `large-list.json`, copy the
remaining language-neutral JSON files verbatim, and keep the dashboard codec
fail-closed on unknown or unsafe additive fields.
