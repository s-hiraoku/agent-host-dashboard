import { describe, expect, it } from "vitest";
import { BrowserNotificationCoordinator, notificationFromEvent, shouldNotify } from "../src/daily/notifications.js";
import { defaultPreferences } from "../src/daily/preferences.js";
import { createLargeDemoSnapshot } from "../src/testing/fixtures.js";

describe("daily-driver notifications", () => {
  it("derives only attention state notifications from semantic agent events", () => {
    const blocked = { ...createLargeDemoSnapshot().agents[1]!, status: "blocked" as const };
    expect(notificationFromEvent({ type: "agent.upserted", revision: 41, agent: blocked })).toMatchObject({ kind: "blocked", agentId: blocked.id });
    expect(notificationFromEvent({ type: "heartbeat", revision: 42 })).toBeUndefined();
    expect(notificationFromEvent({ type: "agent.upserted", revision: 43, agent: { ...blocked, status: "working" } })).toBeUndefined();
    expect(notificationFromEvent({ type: "agent.upserted", revision: 44, agent: { ...blocked, status: "done" } })).toMatchObject({ kind: "completed" });
    expect(notificationFromEvent({ type: "agent.upserted", revision: 45, agent: { ...blocked, status: "error" } })).toMatchObject({ kind: "error" });
  });

  it("applies global type and session-only provider/project controls", () => {
    const notification = { kind: "error" as const, agentId: "session-id", agentName: "Agent", provider: "public-provider", project: "public-project" };
    const enabled = { ...defaultPreferences.notifications, enabled: true };
    expect(shouldNotify(notification, enabled, new Set(), new Set())).toBe(true);
    expect(shouldNotify(notification, { ...enabled, enabled: false }, new Set(), new Set())).toBe(false);
    expect(shouldNotify(notification, enabled, new Set([notification.provider]), new Set())).toBe(false);
    expect(shouldNotify(notification, enabled, new Set(), new Set([notification.project]))).toBe(false);
    expect(shouldNotify(notification, { ...enabled, error: false }, new Set(), new Set())).toBe(false);
  });

  it("deduplicates delivery without cross-tab coordination", async () => {
    const coordinator = new BrowserNotificationCoordinator({ tabId: "single-tab" });
    let deliveries = 0;

    await coordinator.runOnce("41:blocked", () => { deliveries += 1; });
    await coordinator.runOnce("41:blocked", () => { deliveries += 1; });

    expect(deliveries).toBe(1);
    coordinator.close();
  });

  it("elects one tab without broadcasting agent data", async () => {
    class MemoryChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      readonly messages: unknown[] = [];
      peer: MemoryChannel | undefined;
      postMessage(message: unknown) {
        this.messages.push(message);
        this.peer?.onmessage?.({ data: message } as MessageEvent<unknown>);
      }
      close() {}
    }
    const leftChannel = new MemoryChannel();
    const rightChannel = new MemoryChannel();
    leftChannel.peer = rightChannel;
    rightChannel.peer = leftChannel;
    const left = new BrowserNotificationCoordinator({ tabId: "a", channel: leftChannel, settleMs: 0 });
    const right = new BrowserNotificationCoordinator({ tabId: "b", channel: rightChannel, settleMs: 0 });
    let deliveries = 0;

    await Promise.all([
      left.runOnce("41:blocked", () => { deliveries += 1; }),
      right.runOnce("41:blocked", () => { deliveries += 1; }),
    ]);

    expect(deliveries).toBe(1);
    expect(JSON.stringify([...leftChannel.messages, ...rightChannel.messages])).not.toMatch(/agent|project|provider|cwd/i);
    left.close();
    right.close();
  });

  it("does not let a non-contending tab suppress a notification", async () => {
    class MemoryChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      peer: MemoryChannel | undefined;
      postMessage(message: unknown) {
        this.peer?.onmessage?.({ data: message } as MessageEvent<unknown>);
      }
      close() {}
    }
    const unrelatedChannel = new MemoryChannel();
    const contenderChannel = new MemoryChannel();
    unrelatedChannel.peer = contenderChannel;
    contenderChannel.peer = unrelatedChannel;
    const unrelated = new BrowserNotificationCoordinator({ tabId: "a", channel: unrelatedChannel, settleMs: 0 });
    const contender = new BrowserNotificationCoordinator({ tabId: "b", channel: contenderChannel, settleMs: 0 });
    let deliveries = 0;

    await contender.runOnce("host-b:41:blocked", () => { deliveries += 1; });

    expect(deliveries).toBe(1);
    unrelated.close();
    contender.close();
  });

  it("cancels a pending delivery when its coordinator closes", async () => {
    class ClosingChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      closed = false;
      postMessage(_message: unknown) {
        if (this.closed) throw new DOMException("Channel is closed", "InvalidStateError");
      }
      close() { this.closed = true; }
    }
    const channel = new ClosingChannel();
    const coordinator = new BrowserNotificationCoordinator({ tabId: "strict-mode", channel, settleMs: 1 });
    let deliveries = 0;
    const pending = coordinator.runOnce("41:blocked", () => { deliveries += 1; });

    coordinator.close();
    await expect(pending).resolves.toBeUndefined();
    expect(deliveries).toBe(0);
  });
});
