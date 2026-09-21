// ============================================================
// Push Policy — What an Agent Must Never Ship Unnoticed
// ============================================================
// The push gate already asks a human to approve a diff. That is a good
// gate, but it is a HUMAN gate on an AGENT's judgement: an agent that
// has been talked into a change (or that simply does not know which
// files are load-bearing) will happily propose a diff that a reviewer
// skims past. This module adds an automated layer underneath the human
// one, with two severities:
//
//   • block — never ship, full stop. A credential in the diff is the
//     only thing in that class: once a secret is committed it is
//     compromised, and a reviewer clicking Approve cannot tell a
//     placeholder from a live key at a glance.
//   • warn — ship, but the reviewer must be TOLD what is unusual:
//     CI workflows, lockfiles, deploy config, migrations. These are
//     legitimate changes that happen to be high-blast-radius.
//
// Pure and side-effect free: `assessPushPolicy` takes the change set and
// returns findings, so the rules are unit-testable without a network,
// store, or UI.
//
// Scope note: this inspects the ADDED side of the change set only. An
// agent deleting a secret is a fix, not a leak.

import type { PushWarning } from "../types";

export type PushPolicySeverity = "block" | "warn";

export interface PushPolicyFinding {
  severity: PushPolicySeverity;
  /** Short machine label (also the warning grouping in the UI) */
  code: "protected-path" | "secret-detected" | "oversized-change-set";
  message: string;
  paths: string[];
}

export interface PushPolicyFile {
  path: string;
  /** Added/final content; null for a deletion */
  content: string | null;
}

/** Files whose change has outsized blast radius on a hosted repo */
const PROTECTED_PATTERNS: Array<{ pattern: string; why: string }> = [
  { pattern: ".github/workflows/*", why: "CI workflow: runs repository code with repository secrets on every push" },
  { pattern: ".github/**", why: "GitHub configuration (CODEOWNERS, actions, templates)" },
  { pattern: "**/.env*", why: "environment file" },
  { pattern: "**/*.pem", why: "certificate/key material" },
  { pattern: "**/*.key", why: "key material" },
  { pattern: "**/id_rsa*", why: "SSH private key" },
  { pattern: "package-lock.json", why: "dependency lockfile: a tampered entry is a supply-chain change" },
  { pattern: "**/package-lock.json", why: "dependency lockfile" },
  { pattern: "yarn.lock", why: "dependency lockfile" },
  { pattern: "pnpm-lock.yaml", why: "dependency lockfile" },
  { pattern: "bun.lockb", why: "dependency lockfile" },
  { pattern: "Cargo.lock", why: "dependency lockfile" },
  { pattern: "poetry.lock", why: "dependency lockfile" },
  { pattern: "go.sum", why: "dependency checksum file" },
  { pattern: "package.json", why: "dependency + script manifest: edits can add install-time code" },
  { pattern: "Dockerfile", why: "container build definition" },
  { pattern: "docker-compose*.yml", why: "container orchestration" },
  { pattern: "**/*.tf", why: "infrastructure as code" },
  { pattern: "vercel.json", why: "deployment configuration" },
  { pattern: "netlify.toml", why: "deployment configuration" },
  { pattern: "wrangler.toml", why: "deployment configuration" },
  { pattern: ".npmrc", why: "package-registry configuration (can redirect installs)" },
  { pattern: ".gitmodules", why: "submodule definitions" },
  { pattern: "**/migrations/**", why: "database migration: irreversible in production" },
];

/** Credential shapes that must never reach a commit */
const SECRET_PATTERNS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "private-key", label: "a PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "aws-key", label: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", label: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: "openai-key", label: "an OpenAI/OpenRouter key", re: /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: "anthropic-key", label: "an Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", label: "a Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-key", label: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "jwt", label: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "azure-key", label: "an Azure connection string", re: /AccountKey=[A-Za-z0-9+/=]{20,}/ },
  {
    id: "assigned-secret",
    label: "a hard-coded credential assignment",
    re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'`][^"'`\n]{12,}["'`]/i,
  },
];

/**
 * Values that look like a secret pattern but are plainly not one. Kept
 * deliberately broad — a false block is worse than a missed warn for
 * the assigned-secret rule, because it teaches users to distrust the
 * gate.
 */
const PLACEHOLDER_RE =
  /(?:your[_-]?|my[_-]?|the[_-]?|<[^>]*>|\{\{|\$\{|process\.env|import\.meta\.env|os\.environ|getenv|xxxx|aaaa|0000|placeholder|example|sample|dummy|redacted|changeme|todo|test[_-]?key|fake)/i;

/** Change sets above this are unreviewable by a human clicking Approve */
const MAX_REVIEWABLE_FILES = 60;
const MAX_REVIEWABLE_LINES = 4_000;

export interface PushPolicyInput {
  files: PushPolicyFile[];
  /** Optional line totals for the size check (from the diff stats) */
  additions?: number;
  deletions?: number;
}

export interface PushPolicyReport {
  findings: PushPolicyFinding[];
  /** True when at least one finding is fatal to the push */
  blocked: boolean;
  /** First blocking message, ready for the tool result */
  blockReason?: string;
}

/** True when a glob pattern matches a repo-relative path */
function pathMatches(pattern: string, path: string): boolean {
  // Reuse the skill glob semantics: `**` spans directories, `*` is one
  // segment. Implemented locally to keep this module dependency-free.
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += ch === "?" ? "[^/]" : /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`, "i").test(path);
}

/** The first secret-shaped value in a piece of content, if any */
export function findSecret(content: string): { label: string; snippet: string } | null {
  for (const { label, re } of SECRET_PATTERNS) {
    const match = re.exec(content);
    if (!match) continue;
    const snippet = match[0];
    if (PLACEHOLDER_RE.test(snippet)) continue;
    // Show the shape, never the value: this text reaches the model, the
    // user, and the turn log.
    const redacted =
      snippet.length <= 12 ? `${snippet.slice(0, 4)}…` : `${snippet.slice(0, 6)}…${snippet.slice(-2)}`;
    return { label, snippet: redacted };
  }
  return null;
}

/**
 * Assesses a pending change set. Never throws: findings are data, so the
 * caller decides whether to block the gate or annotate it.
 */
export function assessPushPolicy(input: PushPolicyInput): PushPolicyReport {
  const findings: PushPolicyFinding[] = [];
  const files = input.files ?? [];

  // ── 1. Credentials (blocking) ──
  const secretPaths: string[] = [];
  const secretLabels = new Set<string>();
  for (const file of files) {
    if (file.content === null || !file.content) continue;
    const secret = findSecret(file.content);
    if (secret) {
      secretPaths.push(file.path);
      secretLabels.add(secret.label);
    }
  }
  if (secretPaths.length > 0) {
    findings.push({
      severity: "block",
      code: "secret-detected",
      message:
        `A hard-coded credential was found in the added content (${[...secretLabels].join(", ")}). ` +
        "A committed secret must be treated as compromised. Remove it, read it from an environment " +
        "variable or a secret store instead, and rotate the exposed value.",
      paths: secretPaths,
    });
  }

  // ── 2. Protected paths (advisory, but never silent) ──
  const protectedHits = new Map<string, { paths: string[]; why: string }>();
  for (const file of files) {
    if (file.content === null) continue;
    for (const { pattern, why } of PROTECTED_PATTERNS) {
      if (!pathMatches(pattern, file.path)) continue;
      const entry = protectedHits.get(pattern) ?? { paths: [], why };
      entry.paths.push(file.path);
      protectedHits.set(pattern, entry);
      break; // one reason per file is enough
    }
  }
  for (const { paths, why } of protectedHits.values()) {
    findings.push({
      severity: "warn",
      code: "protected-path",
      message: `High-impact file changed — ${why}: ${paths.slice(0, 4).join(", ")}${paths.length > 4 ? ", …" : ""}. Review this part of the diff especially carefully.`,
      paths,
    });
  }

  // ── 3. Reviewability (advisory) ──
  const lines = (input.additions ?? 0) + (input.deletions ?? 0);
  if (files.length > MAX_REVIEWABLE_FILES || lines > MAX_REVIEWABLE_LINES) {
    findings.push({
      severity: "warn",
      code: "oversized-change-set",
      message:
        `This change set is very large (${files.length} file(s), ${lines} line(s)) — larger than a reviewer can genuinely check. ` +
        "Consider splitting it, or say explicitly what the reviewer should look at first.",
      paths: files.slice(0, 8).map((f) => f.path),
    });
  }

  const blocking = findings.find((f) => f.severity === "block");
  return {
    findings,
    blocked: Boolean(blocking),
    blockReason: blocking?.message,
  };
}

/** Converts findings into approval-gate warnings (advisory ones only) */
export function policyWarnings(report: PushPolicyReport): PushWarning[] {
  return report.findings
    .filter((f) => f.severity === "warn")
    .map((f) => ({ kind: "policy" as const, message: f.message }));
}
