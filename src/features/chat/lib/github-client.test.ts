// ============================================================
// GitHub Client — Files the Contents API Declines To Return
// ============================================================
// The Contents API returns `content: ""` with `encoding: "none"` for any file
// over 1 MB. Reading that as "this file could not be loaded" is what produced
// "is in the repository but its contents were not loaded" for an image (or a
// large module) that was sitting right there. These tests pin the Blob API
// fallback that closes the gap, and the byte cap that keeps it honest.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_BLOB_FALLBACK_MAX_BYTES,
  readFileContent,
} from "./github-client";

/** Minimal Response stand-in: only what githubFetch touches. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** Records every URL requested, so "did it even try?" is assertable. */
function stubFetch(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
  return calls;
}

/** What the Contents API sends for a file it refuses to inline */
function overSizeLimit(size: number, sha = "sha-big") {
  return json({
    path: "src/big.ts",
    size,
    sha,
    content: "",
    encoding: "none",
  });
}

const b64Text = (text: string): string => btoa(text);
const b64Bytes = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readFileContent — files over the Contents API's 1 MB limit", () => {
  it("fetches the bytes through the Blob API instead of giving up", async () => {
    const calls = stubFetch((url) =>
      url.includes("/git/blobs/")
        ? json({ content: b64Text("export const a = 1;"), encoding: "base64" })
        : overSizeLimit(2_000_000)
    );

    const file = await readFileContent("t", "acme", "web", "src/big.ts", "main");

    expect(file.text).toBe("export const a = 1;");
    expect(file.truncated).toBe(false);
    expect(file.isBinary).toBe(false);
    expect(calls.some((u) => u.includes("/git/blobs/sha-big"))).toBe(true);
  });

  it("keeps the bytes of a large asset, which is what an inliner needs", async () => {
    // A JPEG header — valid base64, invalid UTF-8.
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    stubFetch((url) =>
      url.includes("/git/blobs/")
        ? json({ content: b64Bytes(bytes), encoding: "base64" })
        : overSizeLimit(3_000_000)
    );

    const file = await readFileContent("t", "acme", "web", "src/hero.webp", "main");

    expect(file.text).toBeNull();
    expect(file.isBinary).toBe(true);
    expect(file.base64).toBe(b64Bytes(bytes));
    expect(file.truncated).toBe(false);
  });

  it("does not request bytes that exceed the cap, and says so", async () => {
    const calls = stubFetch(() =>
      overSizeLimit(GITHUB_BLOB_FALLBACK_MAX_BYTES + 1)
    );

    const file = await readFileContent("t", "acme", "web", "src/huge.bin", "main");

    expect(file.truncated).toBe(true);
    expect(file.base64).toBeNull();
    // The prediction happens before the request: fetching 6 MiB+ only to
    // reject it for being too big is the round trip worth avoiding.
    expect(calls).toHaveLength(1);
  });

  it("degrades to the old report when the Blob request fails", async () => {
    stubFetch((url) =>
      url.includes("/git/blobs/")
        ? json({ message: "Server Error" }, 500)
        : overSizeLimit(2_000_000)
    );

    const file = await readFileContent("t", "acme", "web", "src/big.ts", "main");

    expect(file.truncated).toBe(true);
    expect(file.text).toBeNull();
    expect(file.base64).toBeNull();
  });

  it("does not attempt the Blob API without a sha to address", async () => {
    const calls = stubFetch(() =>
      json({ path: "src/big.ts", size: 2_000_000, content: "", encoding: "none" })
    );

    const file = await readFileContent("t", "acme", "web", "src/big.ts", "main");

    expect(file.truncated).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("readFileContent — ordinary files", () => {
  it("still decodes a small base64 file exactly as before", async () => {
    stubFetch(() =>
      json({
        path: "src/a.ts",
        size: 18,
        sha: "small",
        content: b64Text("export const a = 1;"),
        encoding: "base64",
      })
    );

    const file = await readFileContent("t", "acme", "web", "src/a.ts", "main");

    expect(file.text).toBe("export const a = 1;");
    expect(file.encoding).toBe("base64");
    expect(file.isBinary).toBe(false);
  });

  it("reads a zero-byte file as an empty text file, not as binary", async () => {
    // Regression: `content: ""` used to fall through to the binary branch, so
    // an empty file could never be loaded — every caller reads `text: null`
    // as "the contents were not fetched".
    stubFetch(() =>
      json({ path: "src/empty.css", size: 0, sha: "e", content: "", encoding: "base64" })
    );

    const file = await readFileContent("t", "acme", "web", "src/empty.css", "main");

    expect(file.text).toBe("");
    expect(file.isBinary).toBe(false);
    expect(file.truncated).toBe(false);
  });
});
