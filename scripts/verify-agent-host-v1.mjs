import {
  AgentHostV1Protocol,
  DefaultAgentHostClient,
  FetchHttpChannel,
  HttpAgentHostTransport,
} from "../dist-client/index.js";

const baseUrl = process.env.AGENT_HOST_BASE_URL ?? "http://127.0.0.1:48777";
const token = process.env.AGENT_HOST_API_TOKEN;
if (!token) throw new Error("AGENT_HOST_API_TOKEN is required for live conformance");

const delegate = new FetchHttpChannel({
  baseUrl,
  authentication: () => ({ scheme: "Bearer", token }),
});
let readyStream;
let signalReady;
const streamReady = new Promise((resolve) => { signalReady = resolve; });
const observedChannel = {
  request: (request) => delegate.request(request),
  async *events(request) {
    for await (const frame of delegate.events(request)) {
      if (frame.event === "ready" && !readyStream) {
        readyStream = true;
        signalReady();
      }
      yield frame;
    }
  },
};
const client = new DefaultAgentHostClient(
  new HttpAgentHostTransport(observedChannel, new AgentHostV1Protocol()),
  { supportedApiVersions: ["1"], requestTimeoutMs: 5_000 },
);

async function waitForHost() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("agent-host demo did not become ready");
}

await waitForHost();
const info = await client.discover();
const snapshot = await client.snapshot({ limit: 200, filter: { view: "raw" } });
if (snapshot.agents.length !== 6) throw new Error(`expected 6 demo agents, received ${snapshot.agents.length}`);
const health = await client.adapterHealth();
if (health.length !== 1 || health[0]?.status !== "healthy") throw new Error("demo adapter was not healthy");

const idle = await client.detail("demo:idle");
const blocked = await client.detail("demo:blocked");
if (!idle.capabilities.prompt || !blocked.capabilities.approve || !blocked.pendingApprovals[0]) {
  throw new Error("demo action capabilities were not exposed through the public detail contract");
}

const streamController = new AbortController();
const iterator = client.events({ afterRevision: snapshot.revision, signal: streamController.signal })[Symbol.asyncIterator]();
const nextEvent = iterator.next();
await Promise.race([
  streamReady,
  new Promise((_, reject) => setTimeout(() => reject(new Error("SSE ready handshake timed out")), 2_000)),
]);
const prompt = await client.action(idle, { kind: "prompt", text: "conformance prompt" });
const observed = await Promise.race([
  nextEvent,
  new Promise((_, reject) => setTimeout(() => reject(new Error("semantic action event timed out")), 2_000)),
]);
if (observed.done || observed.value.type !== "action.completed" || observed.value.actionId.length === 0) {
  throw new Error("expected one correlated action.completed event");
}
await client.action(blocked, { kind: "approve", approvalId: blocked.pendingApprovals[0].id });
await delegate.request({ path: "/v1/refresh", method: "POST" });
const updated = await client.snapshot({ limit: 200, filter: { view: "raw" } });
if (updated.revision <= snapshot.revision) throw new Error("demo action transitions did not advance the snapshot revision");

streamController.abort();
await iterator.return?.().catch(() => {});

const invalid = new DefaultAgentHostClient(
  new HttpAgentHostTransport(
    new FetchHttpChannel({ baseUrl, authentication: () => ({ scheme: "Bearer", token: "invalid-conformance-token" }) }),
    new AgentHostV1Protocol(),
  ),
  { supportedApiVersions: ["1"], requestTimeoutMs: 2_000 },
);
let unauthorized = false;
try {
  await invalid.discover();
} catch (error) {
  unauthorized = error?.code === "unauthorized";
}
if (!unauthorized) throw new Error("invalid bearer credential was not rejected as unauthorized");

console.log(JSON.stringify({
  apiVersion: info.apiVersion,
  agents: updated.agents.length,
  adapters: health.length,
  actionId: prompt.actionId,
  eventSequence: observed.value.sequence,
  revision: updated.revision,
  unauthorized,
}));
