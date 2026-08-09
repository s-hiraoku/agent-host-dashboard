import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DefaultAgentHostClient } from "./client.js";
import { createLargeDemoSnapshot, demoAdapterHealth } from "./testing/fixtures.js";
import { MockAgentHostTransport } from "./testing/mock-transport.js";
import "./styles.css";

const transport = new MockAgentHostTransport();
const snapshot = createLargeDemoSnapshot();
transport.currentSnapshot = snapshot;
transport.holdEventStreams = true;
transport.eventStreams = [
  [
    { type: "heartbeat", revision: 41 },
    { type: "adapter.health", revision: 42, adapter: demoAdapterHealth[0]! },
    { type: "action.completed", revision: 43, agentId: snapshot.agents[0]!.id, actionId: "demo-action-live", ok: true },
  ],
];
const client = new DefaultAgentHostClient(transport, { supportedApiVersions: ["1"] });

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
createRoot(root).render(<StrictMode><App client={client} /></StrictMode>);
