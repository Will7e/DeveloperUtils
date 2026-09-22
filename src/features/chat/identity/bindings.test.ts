// ============================================================
// Bindings — The Transition Matrix, As A Spec
// ============================================================
// Every bug this module exists to prevent was a transition that did not happen,
// or a transition whose result nobody was told about:
//
//   • switching a thread to another repository changed the repository and
//     nothing else, so the workspace, the change set and the recorded
//     evidence all still belonged to the old one — the reported symptom;
//   • attaching a repository that was already attached counted as a move, so
//     the state the user was looking at was evicted and rebuilt from nothing;
//   • a push re-pinned the base, and whatever was keyed by "the base commit"
//     silently took the working copy with it.
//
// So this file is a table: an event, and exactly what must be released. A future
// bug of this family is fixed by adding a row here rather than by adding an `if`
// somewhere — which is the difference between fixing a symptom and closing the
// class.

import { describe, it, expect, beforeEach } from "vitest";
import {
  allBindings,
  announceThreadCreated,
  bindingIdOf,
  bindingRecord,
  clearAttachment,
  describeThreadBinding,
  forgetThread,
  isAttachmentInUse,
  pinBase,
  resetBindings,
  setAttachment,
} from "./bindings";
import {
  registerScopedResource,
  resetScopedResources,
  type ReleaseContext,
  type ScopedResource,
} from "./scoped-resources";
import { bindingKey, isAttached, parseBindingKey, type RepoRef } from "./identity";

const REF_A: RepoRef = { owner: "acme", repo: "storefront", branch: "main" };
const REF_B: RepoRef = { owner: "acme", repo: "billing", branch: "main" };

/** What a thread's binding is, written the way the tests read it */
const on = (threadId: string, ref: RepoRef) => bindingKey(threadId, `${ref.owner}/${ref.repo}@${ref.branch}`);
const detached = (threadId: string) => bindingKey(threadId, null);

/** A resource that records what it was told, in the order it was told it */
function spyResource(name: string, scope: ScopedResource["scope"] = "binding") {
  const seen: ReleaseContext[] = [];
  const resource: ScopedResource = {
    name,
    scope,
    release: (context) => {
      seen.push(context);
    },
  };
  registerScopedResource(resource);
  return {
    seen,
    /** Every (previous → next) pair it observed */
    moves: () => seen.map((c) => `${c.transition.previous ?? "-"} → ${c.transition.next ?? "-"}`),
    types: () => seen.map((c) => c.transition.type),
  };
}

describe("bindings — the transition matrix", () => {
  beforeEach(() => {
    resetBindings();
    resetScopedResources();
  });

  it("attaching a repository moves the thread from detached onto its binding", async () => {
    const spy = spyResource("spy");
    const move = await setAttachment("t1", REF_A);

    expect(move?.transition.type).toBe("attachment.set");
    expect(move?.transition.previous).toBe(detached("t1"));
    expect(move?.transition.next).toBe(on("t1", REF_A));
    expect(bindingIdOf("t1")).toBe(on("t1", REF_A));
    expect(spy.moves()).toEqual([`${detached("t1")} → ${on("t1", REF_A)}`]);
  });

  it("re-attaching the SAME repository is NOT a move", async () => {
    // A second `setConversationRepo` for the same repository is ordinary — the
    // attach path calls it more than once. Treating it as a move evicted the
    // state the user was looking at and rebuilt it from nothing, which is the
    // "it keeps resetting" report.
    await setAttachment("t1", REF_A);
    const spy = spyResource("spy");
    const again = await setAttachment("t1", REF_A);

    expect(again).toBeNull();
    expect(spy.seen).toEqual([]);
    expect(bindingIdOf("t1")).toBe(on("t1", REF_A));
  });

  it("switching repository says which was left and which was entered", async () => {
    // THE bug: same thread, same conversation id, different repository. With the
    // attachment in the key this is representable, and it is what the workspace,
    // the change set and the ledger are keyed by from here on.
    await setAttachment("t1", REF_A);
    const spy = spyResource("spy");
    await setAttachment("t1", REF_B);

    expect(spy.moves()).toEqual([`${on("t1", REF_A)} → ${on("t1", REF_B)}`]);
    expect(spy.seen[0]?.transition.ref).toEqual(REF_B);
    expect(bindingIdOf("t1")).toBe(on("t1", REF_B));

    // …and back. Same thread, the FIRST binding again — so what was built for A
    // is reachable again instead of having been overwritten by B.
    await setAttachment("t1", REF_A);
    expect(bindingIdOf("t1")).toBe(on("t1", REF_A));
    expect(spy.moves()).toEqual([
      `${on("t1", REF_A)} → ${on("t1", REF_B)}`,
      `${on("t1", REF_B)} → ${on("t1", REF_A)}`,
    ]);
  });

  it("gives two threads on one repository two bindings, and a detached thread its own", () => {
    // A new chat has no repository, so it has no binding, so it cannot open on
    // someone else's app — the property is structural, not a rule to remember.
    expect(bindingIdOf("brand-new")).toBe(detached("brand-new"));
    expect(isAttached(bindingIdOf("brand-new"))).toBe(false);
    expect(bindingIdOf("brand-new")).not.toBe(bindingIdOf("t1"));
  });

  it("clearing the attachment detaches the thread without forgetting it", async () => {
    await setAttachment("t1", REF_A);
    const spy = spyResource("spy");
    await clearAttachment("t1");

    expect(spy.types()).toEqual(["attachment.cleared"]);
    expect(bindingIdOf("t1")).toBe(detached("t1"));
    expect(parseBindingKey(bindingIdOf("t1")).threadId).toBe("t1");
  });

  it("deleting a thread releases its binding, and only its own", async () => {
    await setAttachment("t1", REF_A);
    await setAttachment("t2", REF_A);
    const spy = spyResource("spy");
    await forgetThread("t1");

    expect(spy.types()).toEqual(["thread.deleted"]);
    expect(spy.seen[0]?.transition.previous).toBe(on("t1", REF_A));
    expect(spy.seen[0]?.transition.next).toBeNull();
    // The other thread is untouched, and still on the repository.
    expect(allBindings().map((b) => b.threadId)).toEqual(["t2"]);
    // Deleting it twice is not a second transition.
    expect(await forgetThread("t1")).toBeNull();
  });

  it("pinning a base is a REVISION, not a binding", async () => {
    // The base commit must not be part of the identity: it is looked up per
    // (thread, repo, branch), so putting the commit in the key would orphan the
    // working copy on every push — silently discarding unpushed edits.
    await setAttachment("t1", REF_A);
    const spy = spyResource("spy");

    const pinned = await pinBase("t1", REF_A, "sha-one");
    expect(pinned?.transition.type).toBe("base.moved");
    expect(pinned?.transition.previous).toBe(on("t1", REF_A));
    expect(pinned?.transition.next).toBe(on("t1", REF_A));
    expect(bindingIdOf("t1")).toBe(on("t1", REF_A));
    expect(bindingRecord("t1").baseCommitSha).toBe("sha-one");

    // Same base again is a no-op: re-pinning on every load must not keep
    // invalidating evidence and build sessions.
    expect(await pinBase("t1", REF_A, "sha-one")).toBeNull();

    // A push moves it, and the move is announced.
    await pinBase("t1", REF_A, "sha-two");
    expect(spy.types()).toEqual(["base.moved", "base.moved"]);
    expect(spy.seen[spy.seen.length - 1]?.transition.baseCommitSha).toBe("sha-two");
  });

  it("pins a base for a thread nothing had attached yet", async () => {
    // A fresh load runs the workspace bootstrap before any attach, so this is an
    // attach from the binding's point of view, not a move of an attachment.
    const spy = spyResource("spy");
    await pinBase("t1", REF_A, "sha-one");
    expect(spy.types()).toEqual(["attachment.set", "base.moved"]);
    expect(bindingRecord("t1").baseCommitSha).toBe("sha-one");
  });

  it("tells every registered resource, in registration order", async () => {
    const first = spyResource("a-first", "repo");
    const second = spyResource("b-second", "url");
    const third = spyResource("c-third", "thread");
    await setAttachment("t1", REF_A);

    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    expect(third.seen).toHaveLength(1);
    // All three agree about the transition they were handed.
    for (const spy of [first, second, third]) {
      expect(spy.seen[0]?.transition.next).toBe(on("t1", REF_A));
    }
  });

  it("reports a failing release instead of throwing into the transition", async () => {
    // One cache failing to evict must not leave the app half-moved: the store
    // updated and the caches not is exactly the state nobody can reason about.
    const boom: ScopedResource = {
      name: "boom",
      scope: "binding",
      release: () => {
        throw new Error("cache on fire");
      },
    };
    const after = spyResource("after");
    registerScopedResource(boom);

    const move = await setAttachment("t1", REF_A);
    expect(move?.failures).toEqual([{ resource: "boom", error: "cache on fire" }]);
    // The move still happened, and every later resource was still told.
    expect(bindingIdOf("t1")).toBe(on("t1", REF_A));
    expect(after.seen).toHaveLength(1);
  });

  it("tells releases whether any thread is still attached to the repository", async () => {
    // Over-eviction is not a safe default: dropping a shared repo-scoped cache
    // because ONE thread left it is the same class of mistake in the other
    // direction, and it is what made switching chats feel like it destroyed work.
    const answers: boolean[] = [];
    registerScopedResource({
      name: "asker",
      scope: "repo",
      release: ({ isAttachmentInUse, transition }) => {
        if (transition.type !== "attachment.cleared" || !transition.ref) return;
        const id = `${transition.ref.owner}/${transition.ref.repo}@${transition.ref.branch}`;
        answers.push(isAttachmentInUse(id));
      },
    });

    await setAttachment("t1", REF_A);
    await setAttachment("t2", REF_A);
    // Two threads share A. The first one leaving must NOT read as "A is free" —
    // dropping a shared cache then is what made switching chats destructive.
    await clearAttachment("t1");
    await clearAttachment("t2");

    expect(answers).toEqual([true, false]);
    expect(isAttachmentInUse("acme/storefront@main")).toBe(false);
    expect(isAttachmentInUse("nobody/cares@main")).toBe(false);
  });

  it("announces a new thread, so the matrix has no gap", async () => {
    const spy = spyResource("spy");
    await announceThreadCreated("t9");
    expect(spy.types()).toEqual(["thread.created"]);
    expect(bindingIdOf("t9")).toBe(detached("t9"));
  });

  it("says what a thread is on, in prose a log can use", async () => {
    expect(describeThreadBinding("t1")).toContain("no repository attached");
    await setAttachment("t1", REF_A);
    expect(describeThreadBinding("t1")).toBe("acme/storefront@main (thread t1)");
  });

  it("bumps a generation on each real move, so an out-of-order read is detectable", async () => {
    // Records are replaced, never mutated, so an inspector (or a late lander)
    // needs something to compare that keeps moving in one direction.
    await setAttachment("t1", REF_A);
    const one = bindingRecord("t1").generation;
    await setAttachment("t1", REF_B);
    const two = bindingRecord("t1").generation;
    expect(two).toBeGreaterThan(one);
    // Re-attaching the repository it is already on is not a move, so it is not a
    // new generation either.
    await setAttachment("t1", REF_B);
    expect(bindingRecord("t1").generation).toBe(two);
  });
});
