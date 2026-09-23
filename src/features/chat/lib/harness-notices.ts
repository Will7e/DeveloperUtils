// ============================================================
// Harness Notices — The Sentences The Harness Itself Writes
// ============================================================
// Three moments in a turn are the HARNESS talking, not the model: it
// continues a turn the model stopped with work open, it hands the turn back
// when the continuations are spent, and it does the same when the tool loop
// hits its bound. Those sentences are the only honest signal of the thing the
// product is judged on — "did the agent finish, or did the user have to say
// 'continue'?" — so the scorecard has to read them.
//
// They live here, in one place, because a metric that matches a string the
// harness no longer writes silently reports zero. Wording and measurement
// come from the same constant, so changing the sentence changes the metric.

/** First line of the completion-gate nudge (a harness continuation) */
export const COMPLETION_NUDGE_PREFIX =
  "_You stopped while the work was still open, so the harness is continuing this turn. Do not restate what you already did._";

/** The gate's exit when the continuation budget is spent */
export function continuationExhaustedNotice(summary: string): string {
  return (
    `The work is still open and I'm out of automatic continuations — ${summary} ` +
    "Ask me to continue and I'll pick it up from there."
  );
}

/** The loop's exit when the tool-use bound is reached without the model stopping */
export const TOOL_LIMIT_NOTICE =
  "Reached the tool-use limit for this turn and the automatic continuations are spent. " +
  "Ask me to continue and I'll pick up where I left off.";

/** True when this assistant message is the harness handing the turn back */
export function isHandoffNotice(content: string): boolean {
  const text = content.trimStart();
  return text.startsWith("Reached the tool-use limit") || text.startsWith("The work is still open and I'm out of");
}

/** True when this assistant message is a harness continuation, not a reply */
export function isContinuationNudge(content: string): boolean {
  return content.trimStart().startsWith(COMPLETION_NUDGE_PREFIX);
}
