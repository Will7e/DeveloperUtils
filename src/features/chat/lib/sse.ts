// ============================================================
// SSE Parser — Spec-Correct Server-Sent Events Reader
// ============================================================
// Handles: comment lines (": OPENROUTER PROCESSING"), multi-line
// data fields, CRLF endings, and the [DONE] sentinel. Streams are
// surfaced as complete data payloads to the onEvent callback.

export interface SseParserOptions {
  onEvent: (data: string) => void;
  /** Called for comment lines (e.g. keep-alive pings) */
  onComment?: (comment: string) => void;
}

export function createSseParser({ onEvent, onComment }: SseParserOptions) {
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "";

  function dispatch() {
    if (dataLines.length === 0 && !eventName) return;
    if (dataLines.length > 0) {
      // Multi-line data fields are joined with newlines per spec
      onEvent(dataLines.join("\n"));
    }
    dataLines = [];
    eventName = "";
  }

  function processLine(rawLine: string) {
    // Handle both \n and \r\n line endings
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line === "") {
      // Empty line = event boundary
      dispatch();
      return;
    }

    if (line.startsWith(":")) {
      onComment?.(line.slice(1).trim());
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      return;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return;
    }

    // Ignore unknown fields (id:, retry:, etc.)
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Keep the last (possibly partial) line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },

    /** Flush any pending partial event at stream end */
    end() {
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

/**
 * Convenience helper: read a fetch Response body as SSE events.
 * Rejects with a descriptive error if the body is missing.
 */
export async function readSseStream(
  response: Response,
  options: SseParserOptions
): Promise<void> {
  if (!response.body) {
    throw new Error("Response body is empty — cannot read the stream.");
  }

  const parser = createSseParser(options);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}
