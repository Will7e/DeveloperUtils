// ============================================================
// Tool Signals — Tools Pointed At The Moment, Not The Menu
// ============================================================
// `skill-signals.ts` proved the idea: the most informative text in a
// conversation is not always what the user typed — it is what just
// happened. Skills already load off that. Tools did not: the model got
// the same generated tool documentation every round, and "knowing when"
// was its problem alone. That is the gap this module closes.
//
// The shape follows the sibling exactly — rules are DATA (a trigger, the
// tool names it points at, one line a model reads), selection is capped
// and deduped per turn, and the render output rides the turn note, which
// already sits after the cached prefix. Nothing here touches the wire
// schema list: a signal note can only ever name a tool the surface
// offered, checked at selection time, so the advertised-but-withheld bug
// tool-prompt.ts exists to prevent cannot be reintroduced here.
//
// Pure like every other lib module: text and facts in, lines out. No
// stores, no clock, no I/O — every rule is unit-testable without a turn.

/** One signal note the turn note will carry */
export interface ToolSignal {
  /** Stable machine id (turn log, tests, dedupe) */
  id: string;
  /** The tools this moment points at (each must be on the offered surface) */
  tools: readonly string[];
  /** One sentence, phrased as a fact about the moment, not an ad */
  note: string;
}

/**
 * The facts of one round, as tool-signal inputs. Everything is optional
 * and empty means silent — the same honesty rule skill-signals applies.
 */
export interface ToolSignalInput {
  /** Fresh-failing check summary lines (verification ledger) */
  failingChecks: readonly string[];
  /** Paths in the current change set (workspace) */
  changedPaths: readonly string[];
  /** Fresh uncaught errors from the running preview */
  previewErrors: readonly string[];
  /** The user's latest message text ("" when none) */
  userText: string;
  /** Tool names THIS turn actually offers (the selection filter) */
  surface: readonly string[];
  /**
   * Names already suggested on an EARLIER round of this turn. A note
   * once sent is not sent again — turn prep repeats, and a repeated
   * nudge is paid for twice and read as nagging.
   */
  priorNotes?: readonly string[];
  /**
   * ── Difficulty-triggered knowledge (escalation rung 1) ──
   *
   * How many DISTINCT tools failed this turn, and the name of the worst
   * offender (from the call ledger). Tool-shaped friction: the same call
   * failing twice on arguments means the model is guessing at a contract
   * it never read. The response is the ladder's cheapest rung — load the
   * knowledge (a contract hint naming the sibling) — before any effort
   * bump or model swap is considered.
   */
  failedToolCalls?: number;
  mostFailedTool?: string;
  failedToolExecutions?: number;
}

/** Cap on notes per round (skill matching uses the same ceiling) */
export const TOOL_SIGNAL_MAX = 3;

/** File extensions that read as data the agent may want to inspect */
const DATA_EXTENSIONS = /\.(json|ya?ml|csv|tsv|xml|toml)$/i;

/**
 * The rule table, in the order notes are emitted.
 *
 * Each rule is a recognition aid a maintainer can read, matching the
 * literal-word-list style task-complexity.ts uses: no regexes with moods,
 * every match one a transcript can be audited against. Order is the
 * transcript order, and the most consequential moment wins first.
 */
const RULES: ReadonlyArray<{
  id: string;
  tools: readonly string[];
  /** Decides whether THIS round's facts fire the rule */
  fires: (input: ToolSignalInput) => boolean;
  /** The line for the turn note (static, or derived from the input) */
  note: string | ((input: ToolSignalInput) => string);
}> = [
  {
    id: "failing-check",
    tools: ["run_checks", "read_ci_logs", "read_preview"],
    fires: (i) => i.failingChecks.length > 0,
    note:
      "A check is failing against the current change set — `run_checks` runs the failing check directly and `read_ci_logs` reads why a failed run failed, instead of inferring from the message.",
  },
  {
    id: "preview-error",
    tools: ["read_preview", "preview_snapshot", "preview_evaluate"],
    fires: (i) => i.previewErrors.length > 0,
    note:
      "The running preview reported an uncaught error — `read_preview` returns the live page's status and issues, and `preview_evaluate` can inspect the state a snapshot cannot show.",
  },
  {
    id: "changed-data-files",
    tools: ["read_file", "get_workspace_diff"],
    fires: (i) => i.changedPaths.some((p) => DATA_EXTENSIONS.test(p)),
    note:
      "The change set includes data files (json/yaml/csv/xml/toml) — `read_file` one before claiming its content is right, and `compare_data` checks two shapes against each other.",
  },
  {
    id: "web-request",
    tools: ["search_web", "fetch_url"],
    fires: (i) => /https?:\/\/\S+/.test(i.userText) && /look\s*up|check|fetch|read|docs|documentation|api\b/i.test(i.userText),
    note:
      "The request names a URL to look something up — `fetch_url` reads the page itself; if you do not have the URL yet, `search_web` finds it first.",
  },
  {
    id: "report-request",
    tools: ["write_file", "diff_text"],
    fires: (i) => /\b(report|export|spreadsheet|summari[sz]e (?:the|this|those)\b|list of)\b/i.test(i.userText),
    note:
      "The request asks for a written deliverable — build it with `write_file` in the workspace (so it is reviewable with the change set) rather than only in the reply.",
  },
  // Difficulty-triggered. This rule is the knowledge rung of the response
  // ladder (lib/effort-escalation.ts) aimed at tools: repeated failure of
  // the SAME call is the model guessing at a contract, and the cheapest
  // response is to hand it the contract — the sibling discriminator from
  // tool-contracts.ts — rather than more thinking or a bigger model.
  // Evaluated LAST so moment notes win the cap when both fire.
  {
    id: "repeated-tool-failure",
    tools: ["read_skill"],
    fires: (i) =>
      (i.failedToolCalls ?? 0) >= 2 &&
      Boolean(i.mostFailedTool) &&
      (i.failedToolExecutions ?? 0) >= 3,
    note: (i: ToolSignalInput) =>
      `\`${i.mostFailedTool}\` has now failed ${i.failedToolExecutions} times this turn — repeating it unchanged will be refused. Read the tool's contract in the tool documentation above, and use the sibling it names when the discriminator matches your situation.`,
  },
];

/**
 * Selects the tool-signal notes for one round.
 *
 * Rules are evaluated in table order, capped at `TOOL_SIGNAL_MAX`, and a
 * note is dropped entirely when none of its tools survive the surface
 * filter — a nudge for a tool the turn withheld is the
 * advertised-but-withheld bug in one line. Prior notes dedupe across
 * rounds: the same moment does not re-fire round after round.
 */
export function selectToolSignals(input: ToolSignalInput): ToolSignal[] {
  const surface = new Set(input.surface);
  const prior = new Set((input.priorNotes ?? []).map((id) => id.trim()).filter(Boolean));
  const selected: ToolSignal[] = [];

  for (const rule of RULES) {
    if (selected.length >= TOOL_SIGNAL_MAX) break;
    if (prior.has(rule.id)) continue;
    if (!rule.fires(input)) continue;
    const offered = rule.tools.filter((t) => surface.has(t));
    // The note names tools; if the surface carries none of them, the note
    // is noise — drop it rather than advertise what this turn withheld.
    if (offered.length === 0) continue;
    selected.push({
      id: rule.id,
      tools: offered,
      note: typeof rule.note === "function" ? rule.note(input) : rule.note,
    });
  }

  return selected;
}

/**
 * Renders the selected notes as turn-note lines.
 *
 * Empty input renders empty — the block only exists when a moment fired.
 * Tools are named as the model would call them; the phrasing states the
 * situation once, without repeating the note machinery.
 */
export function renderToolSignalBlock(signals: readonly ToolSignal[]): string {
  if (signals.length === 0) return "";
  const lines = ["The situation this turn is in, with the tools that read it directly:"];
  for (const signal of signals) {
    lines.push(`- ${signal.note}`);
  }
  return lines.join("\n");
}
