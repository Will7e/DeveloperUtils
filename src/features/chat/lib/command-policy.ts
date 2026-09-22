// ============================================================
// Command Policy — What a Shell May Do Unnoticed
// ============================================================
// push-policy.ts asks "may this DIFF ship without a human looking twice".
// This asks the same question about a COMMAND, and it is the more dangerous
// of the two: a diff is inert until someone deploys it, and a command has
// already run by the time anyone reads it.
//
// Two severities, matching the push gate:
//
//   • block — never run, full stop. Privilege escalation, remote code piped
//     into a shell, writes outside the workspace, credential access, and
//     anything that ships AROUND the review gate. Each is irreversible,
//     exfiltration in one step, or a way to publish code the user never
//     approved — and none of them is ever what "run the tests" meant.
//   • warn — run, but the human must be TOLD what is unusual. Installing
//     dependencies executes arbitrary postinstall code from the network,
//     Docker can mount the host, and a plain HTTP client moves source off
//     the machine.
//
// The default is ALLOW with a visible command: the shell's gate is the
// user reading the line before it runs, so this module exists to make the
// handful of lines nobody should approve impossible to approve by accident
// — not to build an allowlist that would refuse `npm test` on a Tuesday.
//
// Pure and side-effect free: a command string in, findings out. No process,
// no clock, no store, so every rule is unit-testable without running
// anything.
// ============================================================

export type CommandPolicySeverity = "block" | "warn";

export type CommandPolicyCode =
  | "privilege-escalation"
  | "remote-code-execution"
  | "outside-workspace"
  | "credential-access"
  | "bypasses-review-gate"
  | "package-publish"
  | "destructive-command"
  | "destructive-git"
  | "package-install"
  | "network-egress"
  | "container-host-access";

export interface CommandPolicyFinding {
  severity: CommandPolicySeverity;
  code: CommandPolicyCode;
  message: string;
}

export interface CommandPolicyVerdict {
  /** False only when a `block` finding exists. */
  allowed: boolean;
  findings: CommandPolicyFinding[];
}

/**
 * One rule. `test` runs against the command with quoting normalised away by
 * `normalize`, because `rm  -rf   /` and `rm -rf /` are the same command and
 * a policy that only saw the first would be a policy with a hole in it.
 */
interface CommandRule {
  code: CommandPolicyCode;
  severity: CommandPolicySeverity;
  test: RegExp;
  message: string;
}

/**
 * Credential locations, as a single alternation. These are reads the user
 * would never approve knowingly, so they block rather than warn: a token
 * that has left the machine cannot be un-leaked by a later review.
 */
const CREDENTIAL_PATHS =
  String.raw`(?:~/|/(?:home|Users)/[^/\s]+/|\$HOME/)?\.(?:ssh|aws|gnupg|netrc|docker/config\.json)\b|/etc/shadow|\.npmrc\b|\bauth\.json\b`;

const RULES: readonly CommandRule[] = [
  {
    code: "privilege-escalation",
    severity: "block",
    test: /(?:^|[;&|(]\s*|\bsudo\s+)(?:sudo|doas|pkexec|runas)\b/,
    message:
      "Runs with administrator privileges. A repository's tests never need root, and anything that asks for it is either a mistake or an escalation.",
  },
  {
    code: "remote-code-execution",
    severity: "block",
    test: /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|node|python3?|perl|ruby)\b|<\s*\(\s*(?:curl|wget)\b/,
    message:
      "Pipes downloaded content straight into an interpreter. Nothing in the repository reviewed that code, and it runs with the user's own account.",
  },
  {
    code: "credential-access",
    severity: "block",
    test: new RegExp(
      String.raw`(?:cat|less|more|head|tail|cp|mv|scp|rsync|tar|zip|grep|awk|sed|base64|curl|wget|python3?|node|openssl)\b[^;|&]*(?:${CREDENTIAL_PATHS})|(?:${CREDENTIAL_PATHS})[^;|&]*\|\s*\w`,
      "i"
    ),
    message:
      "Reads or copies a credential file. A command that touches one is an exfiltration step, and no build needs it.",
  },
  {
    code: "bypasses-review-gate",
    severity: "block",
    test: /\bgit\s+push\b|\bgh\s+(?:pr|release|api\s+\S*pulls?)\b|\bgit\s+remote\s+(?:set-url|add)\b/,
    message:
      "Publishes to the remote from a shell. Every ship in this app goes through the diff review gate, so a command that pushes would put code in front of a reviewer who never saw it.",
  },
  {
    code: "package-publish",
    severity: "block",
    test: /\b(?:npm|yarn|pnpm|bun)\s+publish\b/,
    message: "Publishes a package to a public registry. That is a release, not a verification step.",
  },
  {
    code: "outside-workspace",
    severity: "block",
    test: /\b(?:rm|shred|truncate|chmod|chown)\b[^;|&]*(?:\s|^)(?:~|\$HOME|\/|\/\*|\/etc|\/usr|\/var|\/bin|\/opt|\.\.\/\.\.|\/Users\b|\/home\b)|\bdd\b[^;|&]*of=\/(?:dev|etc|usr|var)|\bmkfs\b|\b:\(\)\s*\{/,
    message:
      "Modifies paths outside the workspace. The workspace is a throwaway copy of the repository; anything reaching past it is the user's actual machine.",
  },
  {
    code: "destructive-git",
    severity: "block",
    test: /\bgit\s+(?:reset\s+--hard|clean\s+-\S*f|checkout\s+--\s+\.|branch\s+-D|stash\s+(?:drop|clear))/,
    message:
      "Discards uncommitted work irreversibly (hard reset, force clean, branch delete). The workspace holds changes nobody has reviewed yet, so this is never merely a step.",
  },
  {
    code: "container-host-access",
    severity: "block",
    test: /\bdocker\b[^;|&]*(?:--privileged|--pid[= ]host|--network[= ]host|-v\s*\/:|-v\s*\/(?:Users|home|root|var\/run))/,
    message:
      "Gives a container the host's devices, namespaces or filesystem. That escapes the sandbox the command was meant to run inside.",
  },
  {
    // A WARNING, not a refusal. `rm -rf node_modules && npm ci` is an
    // ordinary thing to do, and a policy that blocks it is a policy the user
    // turns off — which protects nothing at all. The refusal lives in the
    // rule above, where the target is outside the workspace.
    code: "destructive-command",
    severity: "warn",
    test: /\brm\s+-[a-z]*r[a-z]*|\bshred\b|\btruncate\b/,
    message: "Deletes recursively and irreversibly. Check the path before approving.",
  },
  {
    code: "package-install",
    severity: "warn",
    test: /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add)\b|\bpip3?\s+install\b|\bcargo\s+(?:install|add)\b|\bgo\s+get\b|\bbundle\s+install\b|\bapt(?:-get)?\s+install\b/,
    message:
      "Installs dependencies from the network. Their install scripts run with the user's own account, which is the same trust decision as running the project.",
  },
  {
    code: "network-egress",
    severity: "warn",
    // Each verb must be followed by an ARGUMENT, so `.ssh/id_rsa` — a path,
    // not a connection — is not reported as egress. A bare-verb match here
    // appended a network warning to every credential refusal, which is how a
    // result starts burying its most important line.
    test: /\b(?:curl|wget|nc|ncat|scp|sftp|rsync|socat|telnet|ssh)\s+\S/,
    message: "Reaches the network. Useful for real work, but it can also move source off this machine.",
  },
  {
    code: "container-host-access",
    severity: "warn",
    test: /\bdocker\b/,
    message: "Runs Docker. A container is a real process on the user's machine, not an abstraction.",
  },
];

/**
 * Command text with quoting and whitespace flattened, so a rule cannot be
 * dodged by adding spaces (`rm  -rf   /`), a quoting style (`"rm" -rf /`),
 * or a newline inside a pipeline.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\\\r?\n/g, " ")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every rule the command trips, worst first.
 *
 * A command can trip several — `sudo rm -rf ~` is escalation AND destruction
 * — and the caller shows all of them, because "this needs root" and "this
 * deletes your home directory" are separate reasons to refuse.
 */
export function assessCommandPolicy(command: string): CommandPolicyVerdict {
  const normalized = normalizeCommand(command);
  const findings: CommandPolicyFinding[] = [];
  if (!normalized) {
    return { allowed: false, findings: [{ severity: "block", code: "destructive-command", message: "Empty command." }] };
  }
  for (const rule of RULES) {
    // A fresh regex object per test: several rules are stateful alternations
    // and a shared /g lastIndex across calls is the classic way a security
    // check starts passing every other invocation.
    if (new RegExp(rule.test.source, rule.test.flags.replace("g", "")).test(normalized)) {
      findings.push({ severity: rule.severity, code: rule.code, message: rule.message });
    }
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
  return { allowed: !findings.some((f) => f.severity === "block"), findings };
}

/** One line for a tool result, or null when nothing is unusual. */
export function summarizeCommandPolicy(verdict: CommandPolicyVerdict): string | null {
  if (verdict.findings.length === 0) return null;
  const blocked = verdict.findings.filter((f) => f.severity === "block");
  const warned = verdict.findings.filter((f) => f.severity === "warn");
  if (blocked.length > 0) {
    return `Refused: ${blocked.map((f) => f.message).join(" ")}`;
  }
  return `Noted: ${warned.map((f) => f.message).join(" ")}`;
}
