import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import * as formatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { DefaultAgentHostClient } from "../../src/client.js";
import { createDemoSnapshot, demoAdapterHealth, demoAgents } from "../../src/testing/fixtures.js";
import { MockAgentHostTransport } from "../../src/testing/mock-transport.js";

const schema = JSON.parse(
  readFileSync(new URL("../../contracts/demo-fixture.schema.json", import.meta.url), "utf8"),
) as object;
const addFormats = ("default" in formatsModule ? formatsModule.default : formatsModule) as unknown as (
  ajv: Ajv,
) => Ajv;

const events = [
  { type: "heartbeat", revision: 41 },
  { type: "agent.upserted", revision: 42, agent: createDemoSnapshot().agents[0]! },
  { type: "adapter.health", revision: 43, adapter: demoAdapterHealth[0]! },
  { type: "action.completed", revision: 44, agentId: demoAgents[0]!.id, actionId: "demo-action", ok: true },
  { type: "agent.removed", revision: 45, agentId: demoAgents[5]!.id },
];

describe("fixture-backed public contract", () => {
  it("validates every semantic fixture kind against the checked-in schema", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const fixture = {
      apiInfo: new MockAgentHostTransport().apiInfo,
      snapshot: createDemoSnapshot(),
      details: demoAgents,
      health: demoAdapterHealth,
      events,
    };

    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it.each([
    { advertised: "0", supported: ["1", "2"], compatible: false },
    { advertised: "1", supported: ["1", "2"], compatible: true },
    { advertised: "2", supported: ["1", "2"], compatible: true },
    { advertised: "3", supported: ["1", "2"], compatible: false },
  ])("applies the explicit compatibility policy to API $advertised", async ({ advertised, supported, compatible }) => {
    const transport = new MockAgentHostTransport();
    transport.apiInfo = { apiVersion: advertised, features: [] };
    const client = new DefaultAgentHostClient(transport, { supportedApiVersions: supported });

    if (compatible) {
      await expect(client.snapshot()).resolves.toMatchObject({ revision: expect.any(Number) });
    } else {
      await expect(client.snapshot()).rejects.toMatchObject({
        code: "incompatible_version",
        details: { supported, received: advertised },
      });
    }
  });

  it("contains no credential or private-session fields", () => {
    const serialized = JSON.stringify({ snapshot: createDemoSnapshot(), details: demoAgents, events });
    expect(serialized).not.toMatch(/authorization|bearer|access[_-]?token|refresh[_-]?token|privateSession/i);
    expect(serialized).not.toMatch(/\/Users\/|\/home\//);
  });

  it("rejects unknown status facet keys", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const fixture = {
      apiInfo: new MockAgentHostTransport().apiInfo,
      snapshot: { ...createDemoSnapshot(), facets: { byStatus: { privateStatus: 1 }, byProvider: {} } },
      details: demoAgents,
      health: demoAdapterHealth,
      events,
    };

    expect(validate(fixture)).toBe(false);
  });
});
