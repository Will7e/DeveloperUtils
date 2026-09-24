// ============================================================
// Provider Routing — Tests
// ============================================================
// The rule is one line and the reason is not: a request that carries tool
// schemas is asserting them, and a request that carries none is not. These
// tests exist so the second half cannot be quietly dropped by someone who reads
// "always require the parameters you send" as the obviously safer default — it
// is not, because narrowing the provider pool for a request with nothing to
// require can only cost routing options.

import { describe, it, expect } from "vitest";
import { providerRouting } from "./provider-routing";

describe("providerRouting", () => {
  it("requires the request's parameters when it carries tools", () => {
    expect(providerRouting({ carriesTools: true })).toEqual({ require_parameters: true });
  });

  it("says nothing when the request has nothing to require", () => {
    // A plain chat turn sends temperature and max_tokens, both universal — there
    // is no parameter it would be wrong for a provider to drop, so it must not
    // narrow the pool.
    expect(providerRouting({ carriesTools: false })).toBeUndefined();
  });

  it("returns a fresh object each time, never a shared one", () => {
    // The payload is assembled by spreading this value. A module-level constant
    // would be a mutable object handed to every request.
    const first = providerRouting({ carriesTools: true });
    const second = providerRouting({ carriesTools: true });
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
