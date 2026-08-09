# Pinned agent-host v1 fixtures

These files are copied verbatim from
`s-hiraoku/agent-host@9344c8287331a34a88f640cd17e9d82c280bbf45` under
`fixtures/client-conformance/`. They are sanitized, language-neutral public
contract artifacts used to drive the dashboard's real v1 codec tests.

`large-list.json` is intentionally not duplicated because its upstream blob is
544,491 bytes. `manifest.json` pins its Git blob SHA and required 1,000-agent
cardinality; the dashboard's bounded-DOM performance gate covers the same scale.
Run the documented upstream sync audit before changing any pinned fixture or
commit.
