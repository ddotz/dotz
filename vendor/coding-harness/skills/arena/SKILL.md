---
name: arena
disable-model-invocation: true
description: "Run N isolated candidates at the same artifact, have a blinded judge pick a base by rubric, then graft the strongest parts of the losers into it and verify. Use for /skill:arena, 'arena this', or when one attempt at a non-trivial design or change would lock in the wrong shape."
---

One attempt locks in its first shape. Arena buys alternatives cheaply, then keeps the best parts of each.

## Phases

Open one todo per phase: Frame, Fan out, Judge, Graft, Verify.

### Frame

1. Name the artifact every candidate produces (a design sketch, a patch, a document).
2. Write the rubric: 3-6 gradeable criteria specific to this task. Only the judge sees it.
3. Pick N (default 3, never fewer than 2). Same-model candidates on one prompt converge, so give each seat a structurally different mandated shape when the task is a design (e.g. "state machine", "table-driven", "extend existing module"). For a pure implementation race, one prompt is fine.
4. Decide the judge seat:
   - One-way-door decision: `deep-reviewer` (deep tier).
   - Otherwise: `reviewer`.
5. Rubric reference for designs: one owner per piece of state, one supported way per task, internals hidden so the wrong import fails, one source of truth, old ways deleted, the smallest API that serves the callers.

### Fan out

Spawn all candidates in ONE `task` batch, each brief carrying: the task, the grounding file paths, its mandated shape if any, and "end with a short rationale naming the alternatives you rejected". Each brief needs its Acceptance line. A candidate that produces nothing: continue with N-1 and note the dropout.

- Patch candidates: `isolated: true` (requires a git repo and plan mode off). Each result's merge summary names a patch file. Do not apply any patch yet.
- Design sketches and documents: not isolated. Each brief names its own output file, `local://arena-<slug>-<letter>.md`, and its final answer is that path plus a one-line status, never the full report.

### Judge

One judge task. Give it: the rubric, the task, and each candidate's patch path or output labeled Candidate A/B/C (no seat or model names). Ask for:

- a score per criterion per candidate, with the line of evidence for each score,
- the base candidate,
- graft items: specific hunks or ideas from non-base candidates, each with the criterion it improves.

Before reading the judge's result, score every candidate on every criterion yourself (per criterion, not holistic). Then compare:

- Same base: verify the judge's evidence lines against the patches and continue.
- Different base: the rubric is ambiguous or one of you is biased. Read both rationales, name which criterion decides it, and write that down.
- Tie: prefer the smaller API and the cleaner boundary, the base a maintainer can extend without breaking its invariants.
- All candidates converge: ship the consensus, no graft.
- Candidates diverge wildly: the frame was under-specified. Reframe and re-run; never average them.

### Graft

1. `git apply --check <base patch>`, then apply it.
2. Each graft item: port it onto the base (a fresh `task` worker for anything beyond a few lines). One or two items per loser, not most of it. Drop a graft that conflicts with the base's structure; note why.

### Verify

Run the rubric checks and the repository's relevant tests on the grafted result. A failure means either the frame was wrong (reframe, re-run) or a candidate handled it and the graft was missed (back to Graft). Report:

- the base and why it won (rubric scores),
- each graft kept or dropped with its reason,
- the verification commands and their results,
- dropouts.
