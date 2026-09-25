// ============================================================
// Verification Card — What Has Actually Been Proven, As A Card
// ============================================================
// The explanatory half of the old header chip, kept when the chip went: the
// Changes pane's verification badge still shows this same account of the
// ledger. Two surfaces that describe one ledger must not each keep their own
// copy of the sentences — the first divergence is a pane claiming something
// the evidence denies.

import React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  planVerification,
  type VerificationState,
} from "../lib/verification-plan";
import {
  VERIFICATION_KIND_LABEL,
  formatAge,
  type VerificationEvidence,
} from "../lib/verification-ledger";

/**
 * Wraps `content` in the shared verification bubble. Kept as a wrapper (rather
 * than inlining the card into each caller) so the pane's tooltip and any future
 * surface paint the identical card.
 */
export function VerificationCardTip({
  state,
  evidence,
  plan,
  children,
}: {
  state: VerificationState;
  evidence: readonly VerificationEvidence[];
  plan: ReturnType<typeof planVerification>;
  children: React.ReactNode;
}) {
  return (
    <SimpleTooltip
      side="bottom"
      className="chat-verify-card"
      content={<VerificationCard state={state} evidence={evidence} plan={plan} />}
    >
      {children}
    </SimpleTooltip>
  );
}

export function VerificationCard({
  state,
  evidence,
  plan,
}: {
  state: VerificationState;
  evidence: readonly VerificationEvidence[];
  plan: ReturnType<typeof planVerification>;
}) {
  return (
    <div className="chat-verify-card-body">
      <div className="chat-verify-card-title">Verification</div>

      {evidence.length === 0 ? (
        <div className="chat-verify-card-line chat-verify-card-muted">
          Nothing has run against the current revision of this change set.
        </div>
      ) : (
        <div className="chat-verify-card-list">
          {evidence.map((e) => (
            <div key={e.kind} className={`chat-verify-card-row chat-verify-card-${e.status}`}>
              <span className="chat-verify-card-row-label">{VERIFICATION_KIND_LABEL[e.kind]}</span>
              <span className="chat-verify-card-row-detail">
                {e.status === "fresh-pass"
                  ? `passed ${formatAge(e.ageMs)}`
                  : e.status === "fresh-fail"
                    ? `FAILED ${formatAge(e.ageMs)}`
                    : `ran ${formatAge(e.ageMs)} and ${e.ok ? "passed" : "failed"}, then the code changed`}
              </span>
            </div>
          ))}
        </div>
      )}

      {state === "stale" && (
        <div className="chat-verify-card-note">
          A result that passed before an edit does not describe the code you are looking at. Re-run
          it to make the claim good.
        </div>
      )}

      <div className="chat-verify-card-divider" />

      {plan.recommended ? (
        <div className="chat-verify-card-line">
          <span className="chat-verify-card-row-label">Strongest tier available</span>
          <span className="chat-verify-card-mono">{plan.recommended.tool}</span>
        </div>
      ) : (
        <div className="chat-verify-card-line chat-verify-card-muted">
          {plan.steps.some((s) => s.available)
            ? "Every tier reachable right now has already run against this revision."
            : "No tier can run right now."}
        </div>
      )}
    </div>
  );
}
