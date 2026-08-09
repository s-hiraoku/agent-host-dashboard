import type { AdapterHealth, AgentDetail, AgentSnapshot } from "../domain.js";

const timestamp = "2026-01-15T09:30:00.000Z";

export const demoAgents: readonly AgentDetail[] = [
  {
    id: "demo:orbit-review",
    name: "Review orbital parser",
    provider: "demo-alpha",
    status: "working",
    capabilities: { prompt: true, read: true, interrupt: true },
    cwd: "/workspace/orbit",
    lastActivityAt: timestamp,
    project: "orbit",
    provenance: { source: "demo", confidence: "high", view: "active" },
    pendingApprovals: [],
  },
  {
    id: "demo:harbor-approval",
    name: "Validate release archive",
    provider: "demo-beta",
    status: "blocked",
    capabilities: { read: true, approve: true, reject: true },
    cwd: "/workspace/harbor",
    lastActivityAt: "2026-01-15T09:29:10.000Z",
    project: "harbor",
    provenance: { source: "demo", confidence: "high", view: "active" },
    pendingApprovals: [
      {
        id: "approval-demo-1",
        kind: "command",
        summary: "Run the release verification suite",
        reason: "Confirm the archive before publishing",
        command: "npm run verify:release",
      },
    ],
  },
  {
    id: "demo:atlas-error",
    name: "Index project symbols",
    provider: "demo-alpha",
    status: "error",
    capabilities: { read: true, prompt: true },
    cwd: "/workspace/atlas",
    lastActivityAt: "2026-01-15T09:22:00.000Z",
    project: "atlas",
    provenance: { source: "demo", confidence: "high", view: "recent" },
    pendingApprovals: [],
  },
  {
    id: "demo:ember-done",
    name: "Update dependency notes",
    provider: "demo-gamma",
    status: "done",
    capabilities: { read: true },
    cwd: "/workspace/ember",
    lastActivityAt: "2026-01-15T09:18:00.000Z",
    project: "ember",
    provenance: { source: "demo", confidence: "medium", view: "recent" },
    pendingApprovals: [],
  },
  {
    id: "demo:quartz-idle",
    name: "Prepare migration plan",
    provider: "demo-beta",
    status: "idle",
    capabilities: { prompt: true },
    cwd: "/workspace/quartz",
    lastActivityAt: "2026-01-15T08:55:00.000Z",
    project: "quartz",
    provenance: { source: "demo", confidence: "high", view: "recent" },
    pendingApprovals: [],
  },
  {
    id: "demo:signal-unknown",
    name: "Detected helper process",
    provider: "demo-process",
    status: "unknown",
    capabilities: {},
    lastActivityAt: "2026-01-15T08:30:00.000Z",
    provenance: { source: "process", confidence: "low", view: "raw" },
    pendingApprovals: [],
  },
];

export const demoAdapterHealth: readonly AdapterHealth[] = [
  {
    id: "demo-alpha",
    label: "Demo Alpha",
    status: "healthy",
    durationMs: 42,
    agentCount: 2,
    lastAttemptAt: timestamp,
    lastSuccessAt: timestamp,
  },
  {
    id: "demo-beta",
    label: "Demo Beta",
    status: "degraded",
    durationMs: 850,
    agentCount: 2,
    lastAttemptAt: timestamp,
    lastSuccessAt: "2026-01-15T09:20:00.000Z",
    error: { code: "adapter_timeout", message: "Discovery exceeded its bounded time window.", retryable: true },
  },
];

export function createDemoSnapshot(revision = 40): AgentSnapshot {
  return { agents: demoAgents, revision, total: demoAgents.length };
}

export function createLargeDemoSnapshot(count = 1_000, revision = 40): AgentSnapshot {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("count must be a non-negative safe integer.");
  }
  const agents = Array.from({ length: count }, (_, index) => {
    const seed = demoAgents[index % demoAgents.length]!;
    return {
      ...seed,
      id: `demo:agent-${String(index + 1).padStart(4, "0")}`,
      name: `Sanitized agent ${String(index + 1).padStart(4, "0")}`,
      cwd: `/workspace/project-${index % 20}`,
      project: `project-${index % 20}`,
      pendingApprovals: [],
    };
  });
  return { agents, revision, total: count };
}
