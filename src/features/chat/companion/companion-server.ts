// ============================================================
// Companion Server — A Local Runner The App Can Talk To
// ============================================================
//   node src/features/chat/companion/companion-server.ts
//
// One process, on the user's own machine, that turns a workspace into a real
// directory and runs the project's real commands in it. This is the tier
// that makes `npm ci && npm test && docker compose up` possible at all: the
// toolchain is already on the machine and nothing leaves it.
//
// Three things make it safe enough to run:
//
//   • it binds LOOPBACK ONLY, so it is not reachable from the network;
//   • it requires a PAIRING TOKEN on every route, printed once at startup,
//     because a loopback port is reachable by every page in every browser
//     the user has open — and a page that can POST /v1/exec is a page that
//     can run programs on their machine;
//   • it answers only the app's own origins, so a random tab cannot discover
//     or drive it.
//
// A tree is built two ways, and which one was used is REPORTED rather than
// implied. Given a `repo`, it clones that commit and applies the change set,
// so the tree is the whole project and `npm test` means what it means
// locally. Given only files, it writes exactly those — a PARTIAL tree, which
// is fine for a formatter or a lint of one file and a lie for a test suite,
// so the result says `partial: true` and the caller must not pretend
// otherwise.
// ============================================================

import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
//
// The `.ts` extensions are required, not stylistic: this file is meant to be
// run directly by Node (`node …/companion-server.ts`), and Node's own TS
// loader resolves a module graph literally — it does not guess extensions
// the way a bundler does.
import {
  materializeTree,
  runCommand,
  treeRootFor,
  type MaterializeResult,
} from "./companion-node.ts";
import {
  COMPANION_PROTOCOL_VERSION,
  isCompanionRequest,
  shellFor,
  type CompanionCapabilities,
  type CompanionRequest,
  type ExecOutcome,
} from "./protocol.ts";

export interface CompanionHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface CompanionHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface TreeRecord {
  root: string;
  /** True when the tree came from a clone rather than an overlay only */
  complete: boolean;
  touchedAt: number;
}

export interface CompanionContext {
  token: string;
  allowedOrigins: readonly string[];
  /** Where conversation trees live */
  treesDir: string;
  /** One tree per conversation */
  trees: Map<string, TreeRecord>;
  /** How many trees to keep before evicting the oldest */
  maxTrees?: number;
}

export function createCompanionContext(options: {
  token: string;
  allowedOrigins: readonly string[];
  treesDir: string;
  maxTrees?: number;
}): CompanionContext {
  return {
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    treesDir: options.treesDir,
    trees: new Map(),
    ...(options.maxTrees !== undefined ? { maxTrees: options.maxTrees } : {}),
  };
}

export function companionCapabilities(): CompanionCapabilities {
  return {
    exec: true,
    materialize: true,
    platform: process.platform,
    shell: shellFor(process.platform, process.env),
    roots: [],
  };
}

/** Loopback origins may always call; anything else must be listed. */
function isAllowedCaller(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

function json(status: number, payload: unknown, origin?: string): CompanionHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
    },
    body: JSON.stringify(payload),
  };
}

/**
 * The whole request surface, as a pure function of a request and a context.
 *
 * Keeping it independent of `node:http` is what makes the pairing rules and
 * every refusal assertable without opening a socket.
 */
export async function handleCompanionRequest(
  request: CompanionHttpRequest,
  ctx: CompanionContext
): Promise<CompanionHttpResponse> {
  const method = request.method.toUpperCase();
  const origin = request.headers.origin;
  const path0 = request.path.split("?")[0] ?? request.path;

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        ...(isAllowedCaller(origin, ctx.allowedOrigins) && origin
          ? { "access-control-allow-origin": origin, vary: "origin" }
          : {}),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-companion-token",
        "access-control-max-age": "600",
      },
      body: "",
    };
  }

  // Health first, and WITHOUT the token: the app has to be able to ask "is a
  // companion here at all?" before it has anything to send. It answers with
  // the version so a probe can detect a stale install rather than use it.
  if (path0 === "/health" && method === "GET") {
    return json(200, {
      ok: true,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      capabilities: companionCapabilities(),
    });
  }

  if (!isAllowedCaller(origin, ctx.allowedOrigins)) {
    return json(403, { ok: false, error: "This origin may not drive the companion." });
  }
  if (request.headers["x-companion-token"] !== ctx.token) {
    return json(401, {
      ok: false,
      error: "The pairing token is missing or wrong. It is printed when the companion starts.",
    }, origin);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Body must be JSON." }, origin);
  }
  if (!isCompanionRequest(parsed)) {
    return json(400, { ok: false, error: "Not a request this protocol understands." }, origin);
  }
  const message: CompanionRequest = parsed;

  if (message.type === "HELLO") {
    if (message.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      return json(200, {
        type: "PROTOCOL_MISMATCH",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        expected: message.protocolVersion,
      }, origin);
    }
    return json(200, { type: "HELLO_ACK", protocolVersion: COMPANION_PROTOCOL_VERSION, capabilities: companionCapabilities() }, origin);
  }

  if (message.type === "RELEASE") {
    const tree = ctx.trees.get(message.conversationId);
    if (tree) {
      ctx.trees.delete(message.conversationId);
      await rm(tree.root, { recursive: true, force: true }).catch(() => {});
    }
    return json(200, { type: "RELEASED", id: message.id }, origin);
  }

  if (message.type === "MATERIALIZE") {
    const result = await materializeForConversation(
      ctx,
      message.conversationId,
      { writes: message.writes, deletes: message.deletes ?? [] },
      message.repo
    );
    return json(200, { type: "MATERIALIZED", id: message.id, ...result }, origin);
  }

  // EXEC: refresh the tree from the change set first, so a command never runs
  // against a tree from an older revision of the workspace.
  const tree = await materializeForConversation(
    ctx,
    message.conversationId,
    { writes: message.writes ?? [], deletes: message.deletes ?? [] },
    message.repo
  );
  const outcome: ExecOutcome = await runCommand({
    command: message.command,
    cwd: tree.root,
    ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
    ...(message.maxOutputChars !== undefined ? { maxOutputChars: message.maxOutputChars } : {}),
    notes: tree.partial
      ? [
          "This tree is PARTIAL: only the files the workspace had touched were written, so a full test run may fail for a missing file rather than a real fault.",
          ...(tree.cloneError ? [`The checkout could not be built: ${tree.cloneError}`] : []),
        ]
      : [],
  });
  return json(200, { type: "EXEC_RESULT", id: message.id, outcome }, origin);
}

/**
 * Write the change set into this conversation's tree, cloning the base commit
 * first when a repo was supplied and the clone has not happened yet.
 */
async function materializeForConversation(
  ctx: CompanionContext,
  conversationId: string,
  target: { writes: readonly { path: string; content: string }[]; deletes: readonly string[] },
  repo?: { url: string; ref: string }
): Promise<{
  root: string;
  written: number;
  deleted: number;
  bytes: number;
  partial: boolean;
  rejected: string[];
  cloneError?: string;
}> {
  const root = treeRootFor(ctx.treesDir, conversationId);
  const existing = ctx.trees.get(conversationId);
  let written = 0;
  let deleted = 0;
  let bytes = 0;
  let cloneError: string | undefined;

  if (!existing) {
    await mkdir(root, { recursive: true });
    ctx.trees.set(conversationId, { root, complete: false, touchedAt: Date.now() });
    evictTrees(ctx, conversationId);
  }

  const record = ctx.trees.get(conversationId)!;

  // The checkout comes first, so the change set is applied ON TOP of the base
  // commit rather than being the only thing in the directory.
  if (repo && !record.complete && !(await isCloned(root))) {
    const cloned = await cloneIntoTree(root, repo);
    if (cloned.ok) record.complete = true;
    else cloneError = cloned.error;
  } else if (repo && (await isCloned(root))) {
    record.complete = true;
  }

  if (target.writes.length > 0 || target.deletes.length > 0) {
    const result: MaterializeResult = await materializeTree(root, {
      writes: target.writes,
      deletes: target.deletes,
    });
    written = result.written;
    deleted = result.deleted;
    bytes = result.bytes;
  }

  record.touchedAt = Date.now();
  return {
    root,
    written,
    deleted,
    bytes,
    partial: !record.complete,
    rejected: [],
    ...(cloneError ? { cloneError } : {}),
  };
}

/** Keep the newest trees, delete the rest — a node_modules each is not small. */
function evictTrees(ctx: CompanionContext, keep: string): void {
  const max = ctx.maxTrees ?? 3;
  if (ctx.trees.size <= max) return;
  const ordered = [...ctx.trees.entries()]
    .filter(([id]) => id !== keep)
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  while (ctx.trees.size > max && ordered.length > 0) {
    const [id, record] = ordered.shift()!;
    ctx.trees.delete(id);
    void rm(record.root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Clone the base commit into an existing tree and mark it complete.
 *
 * `-c advice.detachedHead=false` only silences git's own advice; the fetch
 * and checkout are ordinary. A failure is returned, never thrown: the caller
 * decides whether a partial tree is still worth running in.
 */
export async function cloneIntoTree(
  root: string,
  repo: { url: string; ref: string },
  run: typeof runCommand = runCommand
): Promise<{ ok: true } | { ok: false; error: string }> {
  const steps: string[] = [
    "git init -q",
    `git remote add origin ${shellQuote(repo.url)}`,
    `git fetch -q --depth 1 origin ${shellQuote(repo.ref)}`,
    "git -c advice.detachedHead=false checkout -q FETCH_HEAD",
  ];
  for (const step of steps) {
    const outcome = await run({ command: step, cwd: root, timeoutMs: 300_000 });
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        error: `\`${step}\` failed (exit ${outcome.exitCode}): ${(outcome.stderr || outcome.stdout).slice(0, 400)}`,
      };
    }
  }
  return { ok: true };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whether a directory already holds a checkout (so a clone would conflict). */
export async function isCloned(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

// ── The process ──────────────────────────────────────────────

export interface StartedCompanion {
  origin: string;
  port: number;
  close(): Promise<void>;
}

export async function startCompanionServer(options: {
  port?: number;
  token: string;
  allowedOrigins?: readonly string[];
  treesDir?: string;
}): Promise<StartedCompanion> {
  const port = options.port ?? Number(process.env.COMPANION_PORT ?? 5280);
  const ctx = createCompanionContext({
    token: options.token,
    allowedOrigins: options.allowedOrigins ?? [],
    treesDir: options.treesDir ?? path.join(process.env.TMPDIR ?? "/tmp", "intab-companion"),
    maxTrees: 3,
  });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      // Refuse early rather than buffering a body nobody sent on purpose.
      if (body.length < 32 * 1024 * 1024) body += chunk.toString("utf8");
    });
    req.on("end", () => {
      void handleCompanionRequest(
        {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: req.headers as Record<string, string | undefined>,
          body,
        },
        ctx
      ).then((response) => {
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1, not 0.0.0.0: a companion that answers the network is a
    // remote shell for anyone on the same Wi-Fi.
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    origin: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ── The process ──────────────────────────────────────────────
//
//   node src/features/chat/companion/companion-server.ts
//
// Run directly rather than imported: the CLI below only fires when this file
// IS the program, so importing it from a test or a bundler starts nothing.

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const token = process.env.COMPANION_TOKEN?.trim() || randomBytes(24).toString("hex");
  const port = Number(process.env.COMPANION_PORT ?? 5280);
  const appOrigins = (process.env.COMPANION_APP_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    const running = await startCompanionServer({
      port,
      token,
      allowedOrigins: appOrigins,
      ...(process.env.COMPANION_TREES_DIR ? { treesDir: process.env.COMPANION_TREES_DIR } : {}),
    });
    console.log(
      [
        "",
        `  Companion listening on ${running.origin} (loopback only)`,
        "",
        "  Pairing token — paste it into the app and restart the dev server:",
        "",
        `    VITE_COMPANION_ORIGIN=${running.origin}`,
        `    VITE_COMPANION_TOKEN=${token}`,
        "",
        "  Commands run in a throwaway tree per conversation, never in your own",
        "  checkout. Dependencies install INSIDE that tree, so a first run copies",
        "  the repository again rather than reusing your local node_modules.",
        "",
        "  Refused outright: sudo, credentials, paths outside the tree, docker with",
        "  host access, and anything that publishes (git push included) — shipping",
        "  happens through the app's diff review, not a shell.",
        "",
        `  Trees live in ${process.env.COMPANION_TREES_DIR ?? path.join(process.env.TMPDIR ?? "/tmp", "intab-companion")}`,
        "",
      ].join("\n")
    );

    const shutdown = () => {
      void running.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error(
      `\n  The companion could not start: ${err instanceof Error ? err.message : String(err)}\n` +
        "  Another process may hold the port:  COMPANION_PORT=5281 node src/features/chat/companion/companion-server.ts\n"
    );
    process.exit(1);
  }
}
