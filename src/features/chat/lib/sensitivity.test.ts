import { describe, it, expect } from "vitest";
import {
  SECRET_KEY_PATTERN,
  classifyKey,
  classifyPath,
  isSecretKey,
  isVariableReference,
  maskValue,
  redactRecord,
} from "./sensitivity";

/**
 * The key corpus the UI's own masking rule was written against.
 *
 * The invariant worth protecting is that ONE definition decides both what the
 * user sees masked in the API Tester and what the agent may read — so the test
 * states the answer for each key rather than re-deriving it from the regex.
 */
const SECRET_KEYS = [
  "API_TOKEN",
  "Authorization",
  "password",
  "SECRET",
  "apiKey",
  "auth_header",
  "client_cert",
  "CREDENTIALS",
  "private_key",
  "DB_PASSWORD",
];

const ORDINARY_KEYS = ["BASE_URL", "host", "PORT", "name", "tenant", "Accept", "locale"];

describe("secret classification", () => {
  it.each(SECRET_KEYS)("treats %s as secret", (key) => {
    expect(isSecretKey(key)).toBe(true);
    expect(classifyKey(key)).toBe("secret");
  });

  it.each(ORDINARY_KEYS)("treats %s as ordinary", (key) => {
    expect(isSecretKey(key)).toBe(false);
    expect(classifyKey(key)).toBe("personal");
  });

  it("uses the same pattern the API Tester masks with", () => {
    // The UI's reveal toggle is driven by this exact regex; imported here so a
    // future edit to one is a failure in the other.
    expect(SECRET_KEY_PATTERN.source).toBe("token|secret|password|key|auth|cert|credential|private");
  });
});

describe("path classification", () => {
  it("marks env files and key material secret", () => {
    for (const path of [".env", ".env.local", "config/.env.production", "id_rsa", "server.pem", "secrets.json"]) {
      expect(classifyPath(path), path).toBe("secret");
    }
  });

  it("leaves the template and ordinary sources alone", () => {
    for (const path of [".env.example", "src/env.ts", "docs/environment.md", "src/App.tsx"]) {
      expect(classifyPath(path), path).toBe("project");
    }
  });
});

describe("masking never yields the value", () => {
  it("reports presence and length only", () => {
    const value = "sk-live-abcdef1234567890";
    const masked = maskValue(value);
    expect(masked.masked).toBe(true);
    expect(masked.length).toBe(value.length);
    expect(masked.display).not.toContain("sk-");
    expect(masked.display).not.toContain("live");
    expect(masked.display).toContain(`${value.length} chars`);
  });

  it("says empty when it is empty", () => {
    expect(maskValue("").display).toBe("(empty)");
    expect(maskValue("").length).toBe(0);
  });

  it("redacts by key and keeps ordinary values readable", () => {
    const out = redactRecord({ Authorization: "Bearer abc123", Accept: "application/json" });
    expect(out.Accept).toBe("application/json");
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect(JSON.stringify(out)).not.toContain("Bearer");
  });

  it("keeps an empty secret readable as empty — that is not a leak", () => {
    expect(redactRecord({ API_TOKEN: "" }).API_TOKEN).toBe("");
  });
});

describe("variable references", () => {
  it("recognises the app's substitution syntax", () => {
    expect(isVariableReference("{{API_TOKEN}}")).toBe(true);
    expect(isVariableReference("Bearer {{TOKEN}}")).toBe(true);
    expect(isVariableReference("token-literal")).toBe(false);
  });
});
