export interface HttpRequest {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface SseRequest {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface HttpChannel {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
  events(request: SseRequest): AsyncIterable<SseFrame>;
}
