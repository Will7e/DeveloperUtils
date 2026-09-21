// ============================================================
// Encrypted Storage — Failure Semantics
// ============================================================
// Two properties here are load-bearing for data safety:
//
//  1. A store is never silently persisted in the clear. Encryption failure
//     used to return the plaintext, which was then written verbatim — so a
//     whole store (editor files, the OpenRouter key in chat settings) could sit
//     unencrypted on disk with no signal whatsoever.
//  2. An envelope that cannot be decrypted is never handed back as if it were
//     state. Returning the raw `{ct,iv,salt,v}` JSON made zustand merge that
//     envelope over the store, which looks exactly like data loss.

import { describe, expect, it } from "vitest";
import {
  EncryptionUnavailableError,
  decryptState,
  encryptState,
  isQuotaExceededError,
} from "./encrypted-storage.service";

const ENVELOPE_SALT_MARKER = "intab-envelope-v1";

describe("encryptState", () => {
  it("produces an envelope rather than the plaintext", async () => {
    const raw = await encryptState(JSON.stringify({ state: { files: ["secret.txt"] } }));
    expect(raw).not.toContain("secret.txt");
    expect(raw).toContain('"v":1');
  });

  it("keeps the device key material out of the envelope", async () => {
    const envelope = JSON.parse(await encryptState("secret")) as {
      ct: string;
      iv: string;
      salt: string;
      v: number;
    };
    // The salt field used to carry the device id — the other half of the KDF
    // input — in cleartext next to the ciphertext it protects.
    expect(envelope.salt).toBe(ENVELOPE_SALT_MARKER);
  });

  it("uses a fresh IV per call, so identical plaintexts differ at rest", async () => {
    const [a, b] = await Promise.all([encryptState("same"), encryptState("same")]);
    expect(a).not.toBe(b);
  });

  it("passes empty payloads through untouched", async () => {
    await expect(encryptState("")).resolves.toBe("");
  });
});

describe("decryptState", () => {
  it("round-trips what encryptState produced", async () => {
    const plaintext = JSON.stringify({ state: { conversations: [] }, version: 1 });
    await expect(decryptState(await encryptState(plaintext))).resolves.toBe(plaintext);
  });

  it("returns null for an envelope no known key can open", async () => {
    const envelope = JSON.parse(await encryptState("secret")) as {
      ct: string;
      iv: string;
      salt: string;
      v: number;
    };
    // Well-formed base64, but the GCM tag cannot verify.
    envelope.ct = btoa("this is not the real ciphertext");
    await expect(decryptState(JSON.stringify(envelope))).resolves.toBeNull();
  });

  it("returns null for a malformed envelope instead of throwing", async () => {
    const malformed = JSON.stringify({ ct: "!!!not-base64!!!", iv: "?", salt: "x", v: 1 });
    await expect(decryptState(malformed)).resolves.toBeNull();
  });

  it("passes legacy plaintext through untouched", async () => {
    const legacy = JSON.stringify({ state: { files: [] }, version: 0 });
    await expect(decryptState(legacy)).resolves.toBe(legacy);
    await expect(decryptState("not json at all")).resolves.toBe("not json at all");
  });
});

describe("EncryptionUnavailableError", () => {
  it("is a distinguishable, named error", () => {
    const err = new EncryptionUnavailableError("nope", new Error("cause"));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EncryptionUnavailableError");
    expect(err.code).toBe("encryption_unavailable");
  });

  it("detects quota errors by name", () => {
    const quota = new DOMException("quota", "QuotaExceededError");
    expect(isQuotaExceededError(quota)).toBe(true);
    expect(isQuotaExceededError(new Error("other"))).toBe(false);
  });
});
