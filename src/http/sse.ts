import { AgentHostError } from "../errors.js";
import type { SseFrame } from "./types.js";

function parseBlock(block: string): SseFrame | undefined {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }

  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

export async function* decodeSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const trailingCarriageReturn = !done && buffer.endsWith("\r");
      if (trailingCarriageReturn) buffer = buffer.slice(0, -1);
      buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      if (trailingCarriageReturn) buffer += "\r";

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const finalFrame = parseBlock(buffer);
    if (finalFrame) yield finalFrame;
  } catch (error) {
    throw new AgentHostError("connection_failed", "The event stream could not be read.", {
      retryable: true,
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
}
