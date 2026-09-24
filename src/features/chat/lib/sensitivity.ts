// ============================================================
// Sensitivity — One Definition Of "Careful", Used Everywhere
// ============================================================
// Three places in this app already needed the same answer to "is this a
// secret?": the API Tester's settings modal (which masks a variable's value
// and offers a reveal toggle), the push policy (which blocks a credential
// from reaching a reviewer), and the agent (which must never pull a secret
// into the transcript). Each had its own regex, which is how a rule like
// this rots: you fix the pattern in one place and the other two keep
// leaking.
//
// So the classifier lives here, and the consumers import it. The pattern is
// deliberately the one the UI already shipped — adding classes here changes
// what the user sees masked, so it is a product decision, not a refactor.
//
// The classes are about REACH, not about secrecy alone:
//
//   public    the app's own reference material (ServiceNow APIs, presets)
//   project   the work itself: files, boards, saved formatter/diff sessions
//   personal  what this user has done: request history, collections, chat
//   secret    values that must never reach a model or a reviewer
//
// Masking is strict on purpose: a preview is a LENGTH, never characters from
// the value. A "show the first two characters" preview leaks more than it
// helps, and the whole point of this module is that a secret can be reported
// (present, changed, missing) without any of it travelling.

/** Data class of a value or a field — what MAY read it, not how secret it is */
export type SensitivityClass = "public" | "project" | "personal" | "secret";

/**
 * The key pattern that marks a value secret.
 *
 * Exported because the UI masks on the same rule (features/api-tester
 * components/SettingsModal.tsx) and a test asserts the two agree over a key
 * corpus — the invariant is "what the user sees masked is what the agent
 * cannot read".
 */
export const SECRET_KEY_PATTERN = /token|secret|password|key|auth|cert|credential|private/i;

/** True when a variable/header name marks its value as secret */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Class of one named field: the key decides, and everything else is personal */
export function classifyKey(key: string): SensitivityClass {
  return isSecretKey(key) ? "secret" : "personal";
}

/**
 * Header names that carry a session credential without saying so.
 *
 * `Authorization` and `Proxy-Authorization` are already caught by the key
 * pattern; a cookie is a session token by another name, which the key pattern
 * cannot see. Kept here rather than in a second regex at the call site so there
 * is still exactly one answer to "is this a credential?" for headers.
 */
const SECRET_HEADER_NAMES = /^(?:cookie|set-cookie|x-csrf-token)$/i;

/** True when a request header's VALUE must never be reproduced */
export function isSecretHeader(name: string): boolean {
  return isSecretKey(name) || SECRET_HEADER_NAMES.test(name.trim());
}

/** Paths that are secret by NAME alone (.env files hold credentials) */
const SECRET_PATH_PATTERN = /(^|\/)\.env($|\.)|(^|\/)\.npmrc$|(^|\/)id_(rsa|ed25519)$|\.pem$|\.p12$|\.keystore$|(^|\/)secrets?\.(json|ya?ml)$/i;

/**
 * Env-file TEMPLATES, which look like the real thing and hold no values.
 *
 * Reading one is how you learn which keys a project expects, so classifying it
 * secret would block the useful, harmless read — exactly the over-reaching that
 * makes a sensitivity rule get switched off.
 */
const ENV_TEMPLATE_PATH = /\.env\.(example|sample|template|dist|test)$/i;

/** Class of a file path: real env files, key material and secret manifests */
export function classifyPath(path: string): SensitivityClass {
  if (ENV_TEMPLATE_PATH.test(path)) return "project";
  return SECRET_PATH_PATTERN.test(path) ? "secret" : "project";
}

/** What a masked value reports: that it exists and how big it is, nothing else */
export interface MaskedValue {
  masked: true;
  /** Character count of the hidden value — enough to spot a truncated paste */
  length: number;
  /** Human-facing note. Never contains a character of the value. */
  display: string;
}

/** Masks one value. Total: no prefix, no suffix, no hash of the content. */
export function maskValue(value: string): MaskedValue {
  return {
    masked: true,
    length: value.length,
    display: value.length === 0 ? "(empty)" : `•••• (${value.length} chars hidden)`,
  };
}

/**
 * Redacts a flat key/value map (headers, env vars) by key class.
 *
 * A secret's value is replaced by its mask; an empty value stays readable as
 * empty, because "the key exists but is blank" is a real, non-sensitive answer
 * this app's own comparator cares about.
 */
export function redactRecord(
  record: Readonly<Record<string, string>>
): Record<string, string | MaskedValue> {
  const out: Record<string, string | MaskedValue> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSecretKey(key) && value !== "" ? maskValue(value) : value;
  }
  return out;
}

/**
 * A `{{variable}}` reference, as the API Tester substitutes it.
 *
 * This is the escape hatch that makes the whole policy livable: an agent that
 * needs an authorized request writes `{{API_TOKEN}}` and the app substitutes
 * the value at send time, so the secret is USED without ever being READ.
 */
export const VARIABLE_REFERENCE_PATTERN = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/;

/** True when a value is a `{{variable}}` reference rather than a literal */
export function isVariableReference(value: string): boolean {
  return VARIABLE_REFERENCE_PATTERN.test(value);
}

/**
 * The standing sentence about secrets, for prompts and tool results.
 * One constant so the rule reads the same wherever it is delivered.
 */
export const SECRET_HANDLING_RULE =
  "Secret values are never returned to you. You get the KEY, whether it is present, \
and a length — never the characters. To use one, reference it where the app substitutes \
values, e.g. `{{API_TOKEN}}` in an API Tester URL, header or body; never ask the user to \
paste a secret into the chat, and never invent one.";
