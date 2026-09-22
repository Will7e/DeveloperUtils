// ============================================================
// useBinding — The Binding A Component Should Be Reading From
// ============================================================
// The pane used to be kept in step with the active conversation by an effect:
// something had to notice the conversation changed and call `setConversation`,
// and when that call did not happen — a new chat with no repository attached
// returns early — the pane went on rendering the previous thread's app and had
// no way to tell.
//
// There is nothing to keep in step now. A component asks for the binding it is
// displaying and reads that binding's state; a thread with no repository has no
// binding, so it has nothing to display. This is the whole difference between
// fixing the symptom and removing the class.
// ============================================================

import { useSyncExternalStore } from "react";
import { bindingIdOf, bindingsVersion, subscribeBindings } from "@/features/chat/identity/bindings";
import type { BindingId } from "@/features/chat/identity/identity";

/** The binding id of a thread, or null when there is no thread to ask about */
export function useBindingId(threadId: string | null): BindingId | null {
  // The version is read only to subscribe: it changes when a binding moves, and
  // that is what makes a component re-read the id below.
  const version = useSyncExternalStore(subscribeBindings, bindingsVersion, bindingsVersion);
  void version;
  return threadId ? bindingIdOf(threadId) : null;
}
