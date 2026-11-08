# ADR-0003 — Code index: content-addressed by git blob, scoped per branch

- **Status:** Withdrawn (2026-11-08) — `@vymalo/opencode-code-index` was dropped at the OpenCode v2 cutover
  ([ADR-0019](0019-opencode-v2-cutover.md)) rather than ported. The package was private, experimental and never
  published. The Context/Decision/Consequences below are preserved as-written for history; the code they describe
  no longer exists in this repository.
- **Scope:** `@vymalo/opencode-code-index` — the indexing model and query-time resolution.

> **Note:** the package this ADR describes (`packages/opencode-code-index`) was removed on 2026-11-08, so there is no
> code to find. This record is kept only for the reasoning behind the content-addressed blob / per-branch manifest model.

## Context

Code changes every commit, and developers switch branches and use git **worktrees**
constantly (this repo's own work happens in `.claude/worktrees/<id>/`). A code index has to
stay **correct per branch** and **cheap to update** — re-parsing a whole repo on every
branch switch is a non-starter, and a `blast_radius` that reports edges from the wrong branch
is worse than no answer.

## Decision

Index **git blobs**, not "the working tree", and make a **branch a manifest**.

- `symbol` and `ref` (edge) rows are keyed by the file's git **blob sha** — never by branch.
  A blob is parsed once and shared by every branch/worktree that contains it.
- The only per-branch state is the **`manifest`** table: `(branch, root, path → blob_sha)`,
  built from `git ls-tree`.
- Edge endpoints (`ref.dst_name`) are stored **unresolved**; name resolution happens **at
  query time** by joining against the active branch's manifest. So the same stored edge
  yields a branch-correct answer, and switching branches re-indexes only the blobs whose sha
  changed (`git diff` delta).
- The store is keyed by **repo identity** = the root-commit sha, so all branches *and*
  worktrees of a repo share one index file.

## Consequences

**Positive**
- **Branch switch = delta only** (changed blobs), proven end-to-end in the test suite: the
  same blob/symbol pool yields `blast_radius(util) = {auth,login,handler}` on `main` but
  `{}` on a branch where `auth` was refactored to drop the call.
- **Worktree switch is free** — shared blob pool, different active manifest.
- No duplicate parsing of identical files across branches; the blob pool dedups naturally.

**Negative / cost**
- Query-time resolution means every structural query carries two manifest joins. Indexed and
  cheap at code scale, but more than a pre-resolved edge table would cost.
- Name-collision ambiguity: a bare `foo()` resolves to *any* branch-present `foo` (see
  [ADR-0004](0004-code-index-tree-sitter-sound-but-partial-resolution.md)); the manifest
  narrows the candidate set to the branch but does not disambiguate same-name defs on one
  branch. The optional typed tier is where that gets resolved.
- We index committed **HEAD**, not the dirty working tree — `index_refresh` after commits.

## Alternatives considered

### Re-index the working tree per branch — rejected
Simplest to reason about, but pays the full parse cost on every branch switch and can't share
work across worktrees. The churn is exactly what this model exists to avoid.

### Per-branch symbol/edge tables (branch baked into the rows) — rejected
Stores the graph once per branch. Correct, but duplicates the vast majority of rows that are
identical across branches (most files don't differ branch-to-branch) and turns a branch
switch into a bulk copy. The manifest approach stores the *difference* (which blob sits where)
instead of the *whole graph per branch*.

### Resolve edges eagerly at index time — rejected
Pre-resolving `dst_name → symbol_id` would make queries a touch cheaper, but it bakes a
branch assumption into stored edges — the opposite of what we need. Keeping edges unresolved
is what makes one stored graph serve every branch correctly.
