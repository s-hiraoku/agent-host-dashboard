import { describe, expect, it } from "vitest";
import { decodeSseStream } from "../src/http/sse.js";

function chunked(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("decodeSseStream", () => {
  it("parses chunked frames, multiline data, IDs, and retry hints", async () => {
    const frames = [];
    const stream = chunked(
      ": heartbeat\r\nevent: agent.updated\r\nid: 42\r\ndata: {\"line\":1}\r\n",
      "data: {\"line\":2}\r\nretry: 1500\r\n\r\n",
      "event: ready\ndata: {\"ok\":true}\n\n",
    );

    for await (const frame of decodeSseStream(stream)) frames.push(frame);

    expect(frames).toEqual([
      {
        event: "agent.updated",
        id: "42",
        retry: 1500,
        data: '{"line":1}\n{"line":2}',
      },
      { event: "ready", data: '{"ok":true}' },
    ]);
  });

  it("does not invent a frame boundary when CRLF is split across chunks", async () => {
    const frames = [];
    const stream = chunked("event: update\r", "\ndata: one\r", "\n\r", "\n");

    for await (const frame of decodeSseStream(stream)) frames.push(frame);

    expect(frames).toEqual([{ event: "update", data: "one" }]);
  });
});
