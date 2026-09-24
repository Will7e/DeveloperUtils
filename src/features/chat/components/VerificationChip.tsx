// ============================================================
// Verification Chip — What Has Actually Been Proven, On Screen
// ============================================================
// The ledger existed and nothing showed it. `verificationEvidence` was read by
// the completion gate and by `push_changes`, which meant the user met their own
// proof for the first time INSIDE the approval dialog — after the work was
// done, at the moment they were being asked to ship it. Two consequences, both
// bad: a change with no evidence was indistinguishable from a verified one while
// it was being written, and the honest "UNVERIFIED" the agent wrote in prose was
// the only warning, one paragraph above a diff the user was already skimming.
//
// So the state is a chip in the header, continuously, for the whole task. It
// says the same thing the ledger says, including the two cases prose is worst
// at: STALE (it passed, then the code changed) and FAILED-AGAINST-THIS-REVISION.
// A green tick that survives an edit is worse than no tick at all, which is why
// the freshness rule is the ledger's (revision-stamped) and never this
// component's.
//
// It is also the one place the user learns the TIER, which is the part that is
// genuinely hard to infer: a passing type check and a passing test suite look
// identical in a transcript and prove completely different things.

import React from "react";
import { AlertTriangle, Check, CircleDashed, Clock, Terminal } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { capabilityState, capabilityVersion, subscribeCapability, type CapabilityState } from "../lib/availability";
import { useVerificationReadout } from "./useVerificationReadout";
import {
  planVerification,
  verificationLabel,
  verificationState,
  type VerificationState,
} from "../lib/verification-plan";
import {
  VERIFICATION_KIND_LABEL,
  formatAge,
  type VerificationEvidence,
} from "../lib/verification-ledger";


interface VerificationChipProps {
  conversationId: string;
  repoAttached: boolean;
  /** Whether the workspace holds any change at all */
  hasChanges: boolean;
  /** Whether the change set has been pushed (CI can only run after it has) */
  pushed: boolean;
  onOpenCompanionSettings: () => void;
}

export function VerificationChip({
  conversationId,
  repoAttached,
  hasChanges,
  pushed,
  onOpenCompanionSettings,
}: VerificationChipProps) {
  // The evidence read comes from the shared hook, NOT from props.
  //
  // It used to arrive through ChatPage → ChatHeader as `workspaceUpdatedAt` plus
  // `bindingId`, which meant three surfaces (this chip, the Changes pane, the
  // activity rail) each decided for themselves which revision the ledger should
  // be judged against. That is the one comparison in this feature that must not
  // be re-implemented: get it wrong and a tick survives an edit. The rule lives in
  // the ledger, is invoked once, in one hook, and every surface reads the result.
  const { evidence } = useVerificationReadout(conversationId);

  // The capability map is a module-level store with no re-render of its own, so
  // the version counter is what makes a companion going up or down visible
  // without polling.
  React.useSyncExternalStore(subscribeCapability, capabilityVersion, capabilityVersion);
  const companion: CapabilityState = capabilityState("companion");

  const plan = React.useMemo(
    () =>
      planVerification({
        repoAttached,
        hasChanges,
        companion,
        pushed,
        evidence,
      }),
    [repoAttached, hasChanges, companion, pushed, evidence]
  );

  // Nothing to say without a repository: there is no project, so every state
  // here would be about a workspace that does not exist.
  if (!repoAttached) return null;

  const state = verificationState(evidence);
  const label = verificationLabel(evidence);

  const Icon =
    state === "fail" ? AlertTriangle : state === "pass" ? Check : state === "stale" ? Clock : CircleDashed;

  // A chip that cannot help says nothing on click. When no companion is up the
  // one useful action is pairing one, so the chip IS that affordance; otherwise
  // it is a readout, and a control whose only effect is to open unrelated
  // settings is a control the user learns not to press.
  const actionable = companion !== "up";
  const body = (
    <>
      <Icon className="h-3 w-3" />
      <span className="chat-verify-chip-label">{label}</span>
    </>
  );
  const chipClass = `chat-verify-chip chat-verify-chip-${state}`;

  return (
    <SimpleTooltip
      side="bottom"
      className="chat-verify-card"
      content={
        <VerificationCard
          state={state}
          evidence={evidence}
          plan={plan}
          companion={companion}
          onOpenCompanionSettings={onOpenCompanionSettings}
        />
      }
    >
      {actionable ? (
        <button
          type="button"
          className={`${chipClass} chat-verify-chip-action`}
          aria-label={`Verification: ${label}. Pair a companion so the agent can run your project's own commands.`}
          onClick={onOpenCompanionSettings}
        >
          {body}
        </button>
      ) : (
        <span
          className={chipClass}
          tabIndex={0}
          aria-label={`Verification: ${label}. Hover or focus for what has been proven.`}
        >
          {body}
        </span>
      )}
    </SimpleTooltip>
  );
}

/**
 * The explanation card, exported so the Changes pane shows the SAME account of
 * what has been proven. Two surfaces that describe one ledger must not each keep
 * their own copy of the sentences: the first divergence is a pane claiming
 * something the chip denies.
 */
export function VerificationCard({
  state,
  evidence,
  plan,
  companion,
  onOpenCompanionSettings,
}: {
  state: VerificationState;
  evidence: readonly VerificationEvidence[];
  plan: ReturnType<typeof planVerification>;
  companion: CapabilityState;
  onOpenCompanionSettings: () => void;
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

      {companion !== "up" && (
        <div className="chat-verify-card-note chat-verify-card-note-warn">
          <Terminal className="h-3 w-3" />
          <span>
            {companion === "down"
              ? "No companion is paired, so the agent cannot run your project's own commands — it can only type-check."
              : "No companion has been observed yet, so a command may not run."}{" "}
            <button type="button" className="chat-verify-card-link" onClick={onOpenCompanionSettings}>
              Pair a companion
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
