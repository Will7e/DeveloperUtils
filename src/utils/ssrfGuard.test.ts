import { describe, expect, it } from "vitest";
import { validateUrlForSSRF } from "./ssrfGuard";

/** Convenience: is this URL blocked? */
const blocked = (url: string, options?: { allowLocalhost?: boolean; allowPrivateSubnets?: boolean }) =>
  validateUrlForSSRF(url, options).allowed === false;

describe("validateUrlForSSRF — protocols and authority", () => {
  it("only allows http and https", () => {
    expect(blocked("file:///etc/passwd")).toBe(true);
    expect(blocked("gopher://example.com")).toBe(true);
    expect(blocked("ftp://example.com")).toBe(true);
    expect(blocked("https://example.com")).toBe(false);
  });

  it("rejects credentials in the authority", () => {
    expect(blocked("https://user:pass@example.com")).toBe(true);
  });

  it("rejects malformed input and empty hostnames", () => {
    expect(blocked("not a url")).toBe(true);
    expect(blocked("")).toBe(true);
  });
});

describe("validateUrlForSSRF — metadata and private ranges", () => {
  it("blocks cloud metadata endpoints", () => {
    expect(blocked("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(blocked("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
    expect(blocked("http://100.100.100.200/latest/meta-data/")).toBe(true);
  });

  it("blocks loopback in its common spellings", () => {
    expect(blocked("http://127.0.0.1:8080/admin")).toBe(true);
    expect(blocked("http://localhost/admin")).toBe(true);
    expect(blocked("http://[::1]/admin")).toBe(true);
    expect(blocked("http://2130706433/")).toBe(true);
    expect(blocked("http://0x7f000001/")).toBe(true);
    expect(blocked("http://0177.0.0.1/")).toBe(true);
  });

  it("blocks private, link-local and CGNAT ranges", () => {
    expect(blocked("http://10.1.2.3/")).toBe(true);
    expect(blocked("http://172.16.0.1/")).toBe(true);
    expect(blocked("http://192.168.1.1/")).toBe(true);
    expect(blocked("http://100.64.0.1/")).toBe(true);
    expect(blocked("http://[fd00::1]/")).toBe(true);
  });

  it("blocks a whole address hidden in a single hostname label", () => {
    // These resolve to 127.0.0.1 through wildcard DNS, so a hostname-only
    // check that expects dotted quads would wave them through.
    expect(blocked("http://2130706433.nip.io/")).toBe(true);
    expect(blocked("http://0x7f000001.sslip.io/")).toBe(true);
    expect(blocked("http://127-0-0-1.nip.io/")).toBe(true);
    expect(blocked("http://169.254.169.254.nip.io/latest/meta-data/")).toBe(true);
  });

  it("blocks IPv4 addresses mapped into IPv6 in both spellings", () => {
    expect(blocked("http://[::ffff:127.0.0.1]/")).toBe(true);
    expect(blocked("http://[::ffff:7f00:1]/")).toBe(true);
    expect(blocked("http://[::ffff:10.0.0.1]/")).toBe(true);
  });

  it("still allows ordinary public hosts", () => {
    expect(blocked("https://api.github.com/user")).toBe(false);
    expect(blocked("https://openrouter.ai/api/v1/models")).toBe(false);
    expect(blocked("https://8.8.8.8/")).toBe(false);
    expect(blocked("https://cdn.jsdelivr.net/npm/esbuild-wasm/")).toBe(false);
  });
});

describe("validateUrlForSSRF — opt-in relaxations", () => {
  it("allows loopback and private ranges only when asked", () => {
    expect(blocked("http://127.0.0.1:5173/api", { allowLocalhost: true })).toBe(false);
    expect(blocked("http://192.168.0.10/api", { allowPrivateSubnets: true })).toBe(false);
    // Metadata endpoints stay blocked even with both relaxations on.
    expect(
      blocked("http://169.254.169.254/", { allowLocalhost: true, allowPrivateSubnets: true })
    ).toBe(true);
  });
});

describe("validateUrlForSSRF — normalized output", () => {
  it("returns the parsed URL for allowed targets", () => {
    const result = validateUrlForSSRF("https://example.com/path?q=1");
    expect(result.allowed).toBe(true);
    expect(result.normalizedUrl).toBe("https://example.com/path?q=1");
  });
});
