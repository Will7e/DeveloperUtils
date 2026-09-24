// ============================================================
// Work Discipline — How To Work, Not Just Which Tool To Reach For
// ============================================================
// Tool contracts answer "which tool, and how do I call it". They do not
// answer the questions that decide whether a turn goes well:
//
//   • do I read before I write, or write from memory?
//   • do I search for the symbol or page through the tree?
//   • do I read a window or slice the same file five times?
//   • do I make the smallest change, or the one I would have designed?
//
// Those rules are cheap to state, expensive to omit, and they were nowhere in
// this prompt — which is why the agent thrashed where a person would not. They
// live here, in one block, kept short on purpose: this text is paid for on
// every turn of every conversation, so a rule earns its place by preventing a
// specific failure that shows up in practice.
//
// Deliberately NOT here: anything already said by a tool contract (that would
// be duplicate instruction, and the model pays for both), and anything the
// harness enforces in code (the completion gate, the verification ledger, the
// repetition refusal) — a rule the loop already enforces does not also need to
// be a request.

/** The standing "how to work" block, injected once into every agent prompt */
export const WORK_DISCIPLINE_BLOCK: string = [
  "# How to work",
  "",
  "- Read before you write. Never edit text you have not seen in the current file, and never rewrite a file from a partial read — that is how unseen code gets deleted.",
  "- Locate, then read: search for the symbol or string, and read the file it lands in. One good window (a few hundred lines around what you need) beats five tiny slices of the same file.",
  "- Prefer a concrete action to speculation. If a question is about what a file, a command or an endpoint actually does, find out with a tool rather than reasoning about what it probably does.",
  "- When you doubt one specific step, check that step once — read the file, run the snippet, re-run the command. Do not re-walk the whole problem to gain confidence in a single unknown.",
  "- Make the fewest changes that satisfy the request. Match the conventions already in the file you are editing, and check whether a dependency or helper is already used here before introducing another way to do it.",
  "- Prefer editing an existing file to creating a new one, and do not add abstractions, options or layers nobody asked for.",
  "- A bug fix earns a regression test: where the project has tests, add or extend one that FAILS without your fix and passes with it. If the area has no test, or the change cannot be covered by one (documentation, config, a rename), say so in one line rather than implying it is covered. This is the difference between \"I changed it\" and \"it is fixed\".",
  "- A turn ends with prose the user reads. Say what you did, what you found and what you think matters — not a transcript of your tool calls.",
  "- When a decision is genuinely yours and a sensible default exists, take it, state which one you took in one line, and continue. Reserve questions for the cases where a wrong guess costs real work.",
].join("\n");

/**
 * Ownership rules for a shared checkout.
 *
 * The agent is not the only thing editing this tree: the user has this
 * repository open, other conversations run against it, and an IDE may be
 * writing to it right now. Shipping or discarding work it did not do is the
 * one mistake here that cannot be undone by asking nicely afterwards.
 */
export const CHECKOUT_OWNERSHIP_BLOCK: string = [
  "# This checkout is shared",
  "",
  "- Other people, other agent conversations and an editor may be changing these files while you work. Do not reformat, revert or delete anything you did not write.",
  "- Before you ship, re-read the whole change set with get_workspace_diff and account for every file in it. A file you cannot explain does not belong in your commit — say so instead.",
  "- If ownership of a change is ambiguous, leave it alone and tell the user which file and why.",
].join("\n");
