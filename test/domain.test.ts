import { describe, expect, it } from "vitest";
import { statusExplanation, statusLabel, workspaceLabel } from "../src/domain.js";

describe("status labels", () => {
  it("keeps operational statuses and explains detections without a known state", () => {
    expect(statusLabel("working")).toBe("working");
    expect(statusLabel("unknown")).toBe("Detected");
    expect(statusExplanation("working")).toBeUndefined();
    expect(statusExplanation("unknown")).toMatch(/cannot report/i);
  });
});

describe("workspaceLabel", () => {
  it("distinguishes Codex worktrees of the same repository", () => {
    expect(workspaceLabel({
      cwd: "/Users/demo/.codex/worktrees/60a8/agent-host",
      project: { id: "local:aaaaaaaaaaaaaaaaaaaaaa", name: "agent-host", scope: "local" },
    })).toBe("agent-host · 60a8");
    expect(workspaceLabel({
      cwd: "/Users/demo/.codex/worktrees/a697/agent-host",
      project: { id: "local:bbbbbbbbbbbbbbbbbbbbbb", name: "agent-host", scope: "local" },
    })).toBe("agent-host · a697");
    expect(workspaceLabel({ cwd: "/Users/demo/.codex/worktrees/056a/.github" })).toBe(".github · 056a");
  });

  it("shows owner/repo for ghq checkouts and Windows worktree paths", () => {
    expect(workspaceLabel({ cwd: "/Volumes/SSD/ghq/github.com/s-hiraoku/tech-blog" })).toBe("s-hiraoku/tech-blog");
    expect(workspaceLabel({ cwd: "/Volumes/SSD/ghq/github.com/kaizen-agents-org" })).toBe("kaizen-agents-org");
    expect(workspaceLabel({ cwd: "C:\\Users\\demo\\.codex\\worktrees\\60a8\\agent-host" })).toBe("agent-host · 60a8");
  });

  it("uses Cursor workspace candidates only when cwd is missing", () => {
    expect(workspaceLabel({
      workspaceCandidate: {
        id: "cursor-workspace:demo",
        name: "Volumes-SSD-ghq-github-com-s-hiraoku-agent-host-dashboard",
        confidence: "low",
      },
    })).toBe("s-hiraoku-agent-host-dashboard");
    expect(workspaceLabel({
      workspaceCandidate: {
        id: "cursor-workspace:worktree",
        name: "Users-demo-codex-worktrees-60a8-agent-host",
        confidence: "low",
      },
    })).toBe("agent-host · 60a8");
    expect(workspaceLabel({
      cwd: "/Volumes/SSD/ghq/github.com/s-hiraoku/tech-blog",
      workspaceCandidate: { id: "cursor-workspace:other", name: "empty-window", confidence: "low" },
    })).toBe("s-hiraoku/tech-blog");
  });

  it("does not treat root or version basenames as a workspace", () => {
    expect(workspaceLabel({ cwd: "/", project: { id: "local:cccccccccccccccccccccc", name: "/", scope: "local" } })).toBeUndefined();
    expect(workspaceLabel({
      cwd: "/Users/demo/.codex/plugins/cache/openai-bundled/record-and-replay/1.0.1000816",
    })).toBe("record-and-replay/1.0.1000816");
  });
});
