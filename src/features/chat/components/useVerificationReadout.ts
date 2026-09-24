// ============================================================
// Verification Readout — One Read Of The Ledger, For Every Surface
// ============================================================
// Three surfaces now answer "what has been proven about the code on screen": the
// header chip, the Changes pane beside the diff, and the activity rail's
// finished-turn line. Each needs the same two things — the evidence, judged
// against the revision currently displayed, and whether anything passed — and the
// revision comparison is the part that must not be re-implemented. Freshness is
// derived by the ledger against `workspace.updatedAt` plus the thread's binding;
// a caller that compared its own timestamps would produce a green tick over code
// that had already changed, which is the failure this whole feature exists to
// prevent.
//
// So the read lives here, once.

import React from "react";
import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import { hasFreshPass } from "../lib/change-set-verification";
import {
  subscribeVerification,
  verificationEvidence,
  verificationVersion,
  type VerificationEvidence,
} from "../lib/verification-ledger";
import { activeBindingIdOf } from "../context/engine";

export interface VerificationReadout {
  /** Evidence about the revision currently on screen, newest run per tier */
  evidence: VerificationEvidence[];
  /** True when at least one check passed against that revision */
  verifiedRevision: boolean;
  /** The revision the evidence was judged against, when there is one */
  workspaceUpdatedAt: number | undefined;
}

export function useVerificationReadout(conversationId: string | null): VerificationReadout {
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === conversationId)
  );
  const workspaceUpdatedAt = useChatStore(
    (s) => selectWorkspace(s, conversationId)?.updatedAt
  );
  // Module-level map, no re-render of its own: the version counter is what makes
  // a result that lands while a surface is open show up in it.
  const ledgerVersion = React.useSyncExternalStore(
    subscribeVerification,
    verificationVersion,
    verificationVersion
  );

  const evidence = React.useMemo(() => {
    if (!conversation || typeof workspaceUpdatedAt !== "number") return [];
    return verificationEvidence(conversation.id, {
      workspaceUpdatedAt,
      bindingId: activeBindingIdOf(conversation),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, workspaceUpdatedAt, ledgerVersion]);

  return { evidence, verifiedRevision: hasFreshPass(evidence), workspaceUpdatedAt };
}
