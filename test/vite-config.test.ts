import { describe, expect, it } from "vitest";
import { safeAgentHostTarget } from "../vite.config.js";

describe("safeAgentHostTarget", () => {
  it("accepts only credential-free loopback HTTP(S) targets", () => {
    expect(safeAgentHostTarget("http://127.0.0.1:4777")).toBe("http://127.0.0.1:4777/");
    expect(safeAgentHostTarget("https://localhost:4777")).toBe("https://localhost:4777/");
    expect(() => safeAgentHostTarget("https://agents.example.test")).toThrow(/loopback/);
    expect(() => safeAgentHostTarget("http://token@127.0.0.1:4777")).toThrow(/credentials/);
    expect(() => safeAgentHostTarget("http://127.0.0.1:4777?token=secret")).toThrow(/query parameters/);
  });
});
