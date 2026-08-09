import { AgentHostError } from "../errors.js";
import { decodeSseStream } from "./sse.js";
import type { HttpChannel, HttpRequest, HttpResponse, SseFrame, SseRequest } from "./types.js";

export interface BearerCredential {
  readonly scheme: "Bearer";
  readonly token: string;
}

export type AuthenticationProvider = (signal?: AbortSignal) => BearerCredential | undefined | Promise<BearerCredential | undefined>;

export interface FetchHttpChannelOptions {
  readonly baseUrl?: string;
  readonly authentication?: AuthenticationProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowRemoteHttps?: boolean;
}

export function normalizeAgentHostBaseUrl(input: string, allowRemoteHttps = false): string {
  const baseUrl = input.trim();
  if (baseUrl.startsWith("/")) {
    const normalizedPath = baseUrl === "/" ? "/" : baseUrl.replace(/\/$/, "");
    const segments = normalizedPath.split("/").slice(1);
    if (
      baseUrl.startsWith("//") ||
      (normalizedPath !== "/" &&
        (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalizedPath) ||
          segments.some((segment) => segment === "." || segment === "..")))
    ) {
      throw new AgentHostError(
        "unsupported",
        "Same-origin connection paths must be literal path segments without authorities, traversal, encoded separators, query parameters, or fragments.",
      );
    }
    return normalizedPath;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new AgentHostError("unsupported", "The agent-host connection URL is invalid.", { cause: error });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentHostError("unsupported", "Connection URLs cannot contain credentials, query parameters, or fragments.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (loopback && url.protocol === "http:") return url.toString();
  if (allowRemoteHttps && url.protocol === "https:") return url.toString();
  throw new AgentHostError(
    "unsupported",
    "AgentHost connections must use same-origin, loopback HTTP, or explicitly enabled remote HTTPS.",
  );
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (baseUrl.startsWith("/")) return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
  return new URL(normalizedPath.slice(1), `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function errorCode(status: number): "unauthorized" | "not_found" | "rate_limited" | "connection_failed" {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "connection_failed";
}

export class FetchHttpChannel implements HttpChannel {
  private readonly baseUrl: string;
  private readonly authentication: AuthenticationProvider | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FetchHttpChannelOptions = {}) {
    this.baseUrl = normalizeAgentHostBaseUrl(options.baseUrl ?? "/agent-host", options.allowRemoteHttps ?? false);
    this.authentication = options.authentication;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async headers(
    input: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Headers> {
    const headers = new Headers(input);
    const credential = await this.authentication?.(signal);
    if (credential) {
      if (!credential.token.trim()) throw new AgentHostError("unauthorized", "The authentication token is empty.");
      headers.set("authorization", `${credential.scheme} ${credential.token}`);
    }
    return headers;
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const headers = await this.headers(request.headers, request.signal);
    if (request.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, request.path), {
        method: request.method ?? "GET",
        headers,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      throw new AgentHostError("connection_failed", "Could not reach agent-host.", { retryable: true, cause: error });
    }

    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? undefined;
      throw new AgentHostError(errorCode(response.status), `agent-host request failed with HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        ...(requestId === undefined ? {} : { requestId }),
      });
    }
    let body: unknown;
    try {
      body = response.status === 204 ? undefined : await response.json();
    } catch (error) {
      throw new AgentHostError("invalid_response", "agent-host returned invalid JSON.", {
        status: response.status,
        cause: error,
      });
    }
    return { status: response.status, headers: response.headers, body: body as T };
  }

  async *events(request: SseRequest): AsyncIterable<SseFrame> {
    const headers = await this.headers({ accept: "text/event-stream", ...request.headers }, request.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, request.path), {
        headers,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      throw new AgentHostError("connection_failed", "Could not connect to the agent-host event stream.", {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? undefined;
      throw new AgentHostError(errorCode(response.status), `Event stream failed with HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        ...(requestId === undefined ? {} : { requestId }),
      });
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/event-stream") {
      throw new AgentHostError("invalid_response", "The event stream response was not text/event-stream.", {
        status: response.status,
      });
    }
    if (!response.body) throw new AgentHostError("invalid_response", "The event stream response had no body.");
    yield* decodeSseStream(response.body);
  }
}
