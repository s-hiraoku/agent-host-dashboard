import type { AgentEvent, AgentSnapshot } from "./domain.js";
import { AgentHostError, toAgentHostError } from "./errors.js";
import type { AgentHostClient } from "./client.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stale"
  | "unauthorized"
  | "incompatible"
  | "disconnected";

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly attempt: number;
  readonly revision?: number;
  readonly reason?: string;
}

export interface ConnectionObserver {
  onState(state: ConnectionState): void;
  onSnapshot(snapshot: AgentSnapshot): void;
  onEvent(event: AgentEvent): void;
  onError?(error: AgentHostError): void;
}

export interface ConnectionScheduler {
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export interface ConnectionOptions {
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly maxConsecutiveResyncs?: number;
  readonly scheduler?: ConnectionScheduler;
}

export interface AgentHostConnection {
  readonly completed: Promise<void>;
  close(): void;
}

const defaultScheduler: ConnectionScheduler = {
  sleep(delayMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  },
  random: Math.random,
};

function state(
  observer: ConnectionObserver,
  status: ConnectionStatus,
  attempt: number,
  revision: number | undefined,
  reason?: string,
): void {
  observer.onState({
    status,
    attempt,
    ...(revision === undefined ? {} : { revision }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function backoff(attempt: number, initial: number, maximum: number, jitter: number, random: number): number {
  const base = Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.round(base * (1 + (random * 2 - 1) * jitter)));
}

async function runConnection(
  client: AgentHostClient,
  observer: ConnectionObserver,
  signal: AbortSignal,
  options: ConnectionOptions,
): Promise<void> {
  const scheduler = options.scheduler ?? defaultScheduler;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 15_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const maxConsecutiveResyncs = options.maxConsecutiveResyncs ?? 3;
  let revision: number | undefined;
  let attempt = 0;
  let consecutiveResyncs = 0;

  state(observer, "connecting", attempt, revision);

  try {
    let snapshot: AgentSnapshot;
    while (true) {
      try {
        await client.discover({ signal });
        snapshot = await client.snapshot({}, { signal });
        attempt = 0;
        break;
      } catch (error) {
        if (signal.aborted) return;
        const failure = toAgentHostError(error);
        observer.onError?.(failure);
        if (failure.code === "unauthorized") {
          state(observer, "unauthorized", attempt, revision, failure.message);
          return;
        }
        if (failure.code === "incompatible_version") {
          state(observer, "incompatible", attempt, revision, failure.message);
          return;
        }
        if (!failure.retryable) {
          state(observer, "disconnected", attempt, revision, failure.message);
          return;
        }
        attempt += 1;
        state(observer, "reconnecting", attempt, revision, failure.message);
        await scheduler.sleep(
          backoff(attempt, initialBackoffMs, maxBackoffMs, jitterRatio, scheduler.random()),
          signal,
        );
      }
    }
    revision = snapshot.revision;
    observer.onSnapshot(snapshot);

    while (!signal.aborted) {
      state(observer, "connected", attempt, revision);
      try {
        let streamSequence: number | undefined;
        for await (const event of client.events({ afterRevision: revision, signal })) {
          const sequenced = event.sequence !== undefined;
          if (event.sequence !== undefined && streamSequence !== undefined && event.sequence <= streamSequence) {
            throw new AgentHostError(
              "revision_gap",
              `Expected an event sequence above ${streamSequence}, received ${event.sequence}; refreshing the snapshot.`,
              { retryable: true, details: { current: streamSequence, received: event.sequence } },
            );
          }
          if (event.sequence !== undefined) streamSequence = event.sequence;
          if (!sequenced && event.revision <= revision) continue;
          const revisionGap = sequenced
            ? event.revision < revision || event.revision > revision + 1
            : event.revision !== revision + 1;
          if (revisionGap) {
            const gap = new AgentHostError(
              "revision_gap",
              sequenced
                ? `Expected snapshot revision ${revision} or ${revision + 1}, received ${event.revision}; refreshing the snapshot.`
                : `Expected snapshot revision ${revision + 1}, received ${event.revision}; refreshing the snapshot.`,
              { retryable: true, details: { current: revision, received: event.revision } },
            );
            throw gap;
          }
          consecutiveResyncs = 0;
          attempt = 0;
          revision = event.revision;
          observer.onEvent(event);
        }
        if (signal.aborted) break;
        throw new AgentHostError("connection_failed", "The event stream ended.", { retryable: true });
      } catch (error) {
        if (signal.aborted) break;
        const failure = toAgentHostError(error);
        if (failure.code === "unauthorized") {
          observer.onError?.(failure);
          state(observer, "unauthorized", attempt, revision, failure.message);
          return;
        }
        if (failure.code === "incompatible_version") {
          observer.onError?.(failure);
          state(observer, "incompatible", attempt, revision, failure.message);
          return;
        }
        if (!failure.retryable) {
          observer.onError?.(failure);
          state(observer, "disconnected", attempt, revision, failure.message);
          return;
        }
        observer.onError?.(failure);
        if (failure.code === "revision_gap") {
          consecutiveResyncs += 1;
          state(observer, "stale", attempt, revision, failure.message);
          if (consecutiveResyncs > maxConsecutiveResyncs) {
            state(observer, "disconnected", attempt, revision, "Repeated revision gaps prevented synchronization.");
            return;
          }
        } else {
          attempt += 1;
          state(observer, "reconnecting", attempt, revision, failure.message);
          await scheduler.sleep(
            backoff(attempt, initialBackoffMs, maxBackoffMs, jitterRatio, scheduler.random()),
            signal,
          );
        }

        while (!signal.aborted) {
          try {
            snapshot = await client.snapshot({}, { signal });
            revision = snapshot.revision;
            observer.onSnapshot(snapshot);
            break;
          } catch (snapshotError) {
            if (signal.aborted) return;
            const snapshotFailure = toAgentHostError(snapshotError);
            observer.onError?.(snapshotFailure);
            if (snapshotFailure.code === "unauthorized") {
              state(observer, "unauthorized", attempt, revision, snapshotFailure.message);
              return;
            }
            if (snapshotFailure.code === "incompatible_version") {
              state(observer, "incompatible", attempt, revision, snapshotFailure.message);
              return;
            }
            if (!snapshotFailure.retryable) {
              state(observer, "disconnected", attempt, revision, snapshotFailure.message);
              return;
            }
            attempt += 1;
            state(observer, "reconnecting", attempt, revision, snapshotFailure.message);
            await scheduler.sleep(
              backoff(attempt, initialBackoffMs, maxBackoffMs, jitterRatio, scheduler.random()),
              signal,
            );
          }
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    const failure = toAgentHostError(error);
    observer.onError?.(failure);
    if (failure.code === "unauthorized") state(observer, "unauthorized", attempt, revision, failure.message);
    else if (failure.code === "incompatible_version") state(observer, "incompatible", attempt, revision, failure.message);
    else state(observer, "disconnected", attempt, revision, failure.message);
  }
}

export function connectAgentHost(
  client: AgentHostClient,
  observer: ConnectionObserver,
  options: ConnectionOptions = {},
): AgentHostConnection {
  const controller = new AbortController();
  const completed = runConnection(client, observer, controller.signal, options).finally(() => {
    if (controller.signal.aborted) state(observer, "disconnected", 0, undefined);
  });
  return {
    completed,
    close() {
      controller.abort(new DOMException("The connection was closed.", "AbortError"));
    },
  };
}
