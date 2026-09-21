import { describe, it, expect } from "vitest";
import { createSseParser } from "./sse";

function feedAll(parser: ReturnType<typeof createSseParser>, chunks: string[]) {
  for (const c of chunks) parser.feed(c);
  parser.end();
}

describe("createSseParser", () => {
  it("parses simple single-line data events", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    feedAll(parser, ['data: {"a":1}\n\n']);
    expect(events).toEqual(['{"a":1}']);
  });

  it("buffers partial frames across feed boundaries", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    parser.feed('data: {"a":');
    parser.feed('2}\n');
    parser.feed('\n');
    parser.end();
    expect(events).toEqual(['{"a":2}']);
  });

  it("joins multi-line data fields with newlines", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    feedAll(parser, ["data: line1\ndata: line2\n\n"]);
    expect(events).toEqual(["line1\nline2"]);
  });

  it("skips comment keep-alive lines without firing events", () => {
    const events: string[] = [];
    const comments: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d), onComment: (c) => comments.push(c) });
    feedAll(parser, [": OPENROUTER PROCESSING\n\n", "data: x\n\n"]);
    expect(events).toEqual(["x"]);
    expect(comments).toEqual(["OPENROUTER PROCESSING"]);
  });

  it("handles CRLF line endings", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    feedAll(parser, ["data: hello\r\n\r\n"]);
    expect(events).toEqual(["hello"]);
  });

  it("flushes a trailing event without a final blank line", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    parser.feed("data: tail");
    parser.end();
    expect(events).toEqual(["tail"]);
  });

  it("surfaces the [DONE] sentinel to the caller", () => {
    const events: string[] = [];
    const parser = createSseParser({ onEvent: (d) => events.push(d) });
    feedAll(parser, ["data: [DONE]\n\n"]);
    expect(events).toEqual(["[DONE]"]);
  });
});
