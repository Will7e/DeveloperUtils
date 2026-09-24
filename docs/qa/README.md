# QA scratch — the removed preview harness

These two files are **not part of the app**. They were sitting in `src/` with zero
references from any code, which made them look loadable and invited exactly the
wrong question ("is the preview runtime still here?").

| File | What it is |
|---|---|
| `preview-frame.html` | A captured rendering of the in-pane preview host: the full Tailwind layer plus a fixture app, kept as a visual reference for the CSS contract the preview host was judged against. |
| `preview-harness.html` | The scratch harness that rendered that fixture — a standalone page plus the same fixture inlined, used for eyeballing the host's rendering before the host was deleted. |

The runtime they belonged to (`preview-runtime.ts`, the five-file preview host,
`preview-bridge.ts`, `PreviewPane.tsx`) was removed in `e9144b4` ("remove preview
feature"). Kept out of `src/` because a 550 KB scratch artefact in the source tree
reads as shipped code; kept at all because the CSS contract is the part worth
reusing if a preview ever returns on top of the project's own toolchain rather
than an in-page bundler.

See `docs/intab-runtime-model.md` (why the preview was removed) and
`docs/intab-forge.md` §1 (what its removal costs the Forge proposal).
