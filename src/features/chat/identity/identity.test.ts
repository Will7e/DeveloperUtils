// ============================================================
// Binding Identity — Regression Suite
// ============================================================
// These cases are the four reported symptoms expressed as statements about
// strings, which is the point: the bugs were never in the arithmetic, they were
// in two derived artifacts disagreeing about which repository they belonged to.
// If "belongs to" is a value that can be compared, the disagreement is a test
// failure rather than a screenshot.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  DETACHED,
  attachmentIdFor,
  attachmentIdOf,
  bindingKey,
  declaredBinding,
  describeBinding,
  isAttached,
  isCurrentBinding,
  parseBindingKey,
  shortId,
} from "./identity";

const DEVUTILS = { owner: "william", repo: "DeveloperUtils", branch: "main" };
const OTHER = { owner: "william", repo: "other-repo", branch: "main" };

describe("attachmentIdFor", () => {
  it("names the repository and branch, and NOT the base commit", () => {
    // The base commit is a REVISION of an attachment. Putting it in the
    // identity is how a push would orphan a thread's unpushed edits: the
    // persisted working copy is found by (thread, owner, repo, branch), so a
    // moved head would stop matching and a fresh workspace would replace one
    // that had work in it.
    expect(attachmentIdFor(DEVUTILS)).toBe("william/DeveloperUtils@main");
    expect(attachmentIdFor({ ...DEVUTILS, branch: "release/2.x" })).toBe(
      "william/DeveloperUtils@release/2.x"
    );
  });

  it("distinguishes two repositories a thread could switch between", () => {
    expect(attachmentIdFor(DEVUTILS)).not.toBe(attachmentIdFor(OTHER));
  });
});

describe("attachmentIdOf", () => {
  it("reads a repo ref off anything that carries one", () => {
    expect(attachmentIdOf(DEVUTILS)).toBe("william/DeveloperUtils@main");
    // A RepoContext carries more than a ref, and it is the value the store
    // actually hands around. Widening the parameter is what lets that pass
    // without the call site narrowing it by hand.
    const withStamp = { ...DEVUTILS, attachedAt: 123 };
    expect(attachmentIdOf(withStamp)).toBe("william/DeveloperUtils@main");
    expect(attachmentIdOf({ owner: 7, repo: "x", branch: "main" })).toBeNull();
  });

  it("answers null rather than a half-built id for an incomplete ref", () => {
    // A partial ref must not collide with a real attachment id; `owner//@main`
    // would be a valid string that matches nothing and looks legitimate.
    expect(attachmentIdOf({ owner: "william", repo: "", branch: "main" })).toBeNull();
    expect(attachmentIdOf({ owner: "william", repo: "x" })).toBeNull();
    expect(attachmentIdOf(null)).toBeNull();
    expect(attachmentIdOf(undefined)).toBeNull();
  });
});

describe("bindingKey / parseBindingKey", () => {
  it("round-trips a binding", () => {
    const id = bindingKey("thread-1", "william/DeveloperUtils@main");
    expect(id).toBe("thread-1::william/DeveloperUtils@main");
    expect(parseBindingKey(id)).toEqual({
      threadId: "thread-1",
      attachmentId: "william/DeveloperUtils@main",
    });
  });

  it("round-trips an unattached thread", () => {
    const id = bindingKey("thread-1", null);
    expect(id).toBe(`thread-1::${DETACHED}`);
    expect(parseBindingKey(id)).toEqual({ threadId: "thread-1", attachmentId: null });
    expect(isAttached(id)).toBe(false);
  });

  it("never confuses a detached key with a real attachment", () => {
    // A real attachment always carries an "@", so `detached` cannot collide
    // with one however a repository is named.
    expect(isAttached(bindingKey("t", "william/detached@main"))).toBe(true);
    expect(isAttached(bindingKey("t", null))).toBe(false);
  });

  it("degrades a malformed key to 'no binding' instead of guessing", () => {
    // The safe direction. A wrong binding shows ANOTHER repository's app; no
    // binding shows an empty pane with a reason.
    expect(parseBindingKey("no-separator-here")).toEqual({
      threadId: "no-separator-here",
      attachmentId: null,
    });
  });

  it("splits on the first separator, so an attachment cannot become a thread id", () => {
    expect(parseBindingKey("t::a::b")).toEqual({ threadId: "t", attachmentId: "a::b" });
  });
});

describe("declaredBinding", () => {
  it("reads the binding an artifact declares", () => {
    expect(declaredBinding({ bindingId: "t::a" })).toBe("t::a");
  });

  it("answers null for an artifact that cannot say what it is a copy of", () => {
    // Fail closed: an artifact from before bindings existed is treated as
    // belonging to nothing, so no reader can adopt it. Assuming instead is how
    // a restored working copy was read as the current repository's.
    expect(declaredBinding({})).toBeNull();
    expect(declaredBinding({ bindingId: "" })).toBeNull();
    expect(declaredBinding({ bindingId: null })).toBeNull();
    expect(declaredBinding(null)).toBeNull();
  });
});

describe("isCurrentBinding", () => {
  it("is true only for the exact binding in scope", () => {
    const active = bindingKey("t", attachmentIdFor(DEVUTILS));
    expect(isCurrentBinding(active, active)).toBe(true);
  });

  it("is false across repositories, which is the reported bug", () => {
    // A diff computed for DeveloperUtils, read while the thread is attached to
    // another repository. This is the comparison the pane could not make,
    // because the binding had no name to compare.
    const built = bindingKey("t", attachmentIdFor(DEVUTILS));
    const active = bindingKey("t", attachmentIdFor(OTHER));
    expect(isCurrentBinding(built, active)).toBe(false);
  });

  it("is false for a thread with nothing attached, and for an undeclared artifact", () => {
    // A brand-new chat has no binding. Nothing may be shown in it, which is
    // what stops a new chat opening on the previous thread's app.
    const detached = bindingKey("t", null);
    expect(isCurrentBinding(bindingKey("t", attachmentIdFor(DEVUTILS)), detached)).toBe(false);
    expect(isCurrentBinding(declaredBinding({}), detached)).toBe(false);
    expect(isCurrentBinding(null, null)).toBe(false);
  });
});

describe("describeBinding", () => {
  it("says what is on screen in words the pane can show", () => {
    expect(describeBinding(bindingKey("1234567890", attachmentIdFor(DEVUTILS)))).toBe(
      "william/DeveloperUtils@main (thread 12345678)"
    );
    expect(describeBinding(bindingKey("abc", null))).toBe("thread abc (no repository attached)");
    expect(describeBinding(null)).toBe("nothing");
  });

  it("keeps a short id whole", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("abcdefghij")).toBe("abcdefgh");
  });
});
