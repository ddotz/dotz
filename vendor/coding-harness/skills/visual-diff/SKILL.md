---
name: visual-diff
disable-model-invocation: true
description: "Screenshot regression check against a stored baseline with a pixel tolerance. Entered from a project verify skill or skill://verify when a change can alter layout or styling; not a substitute for driving the feature."
---

Proves "this screen did not change except where intended". It does not prove the feature works; that is the verify skill's drive step.

## Layout (inside the project repo)

- Baselines: `.omp/verify/baselines/<feature>/<state>@<width>.png`, committed.
- Runs: `.omp/verify/runs/<run-id>/<feature>/` holding `current`, `diff`, and the snapshot text; add `.omp/verify/runs/` to `.gitignore`.

## Steps

1. Same conditions both times: same viewport (`page.setViewportSize`), same seed data, animations settled (wait on the target element, not a fixed sleep), clock-dependent text masked or frozen. A diff taken under different conditions is not evidence.
2. Baseline first. Capture it on the commit BEFORE the change (`git stash` is forbidden in a shared tree; use a worktree of the base commit or the state before your edit). No baseline means no regression claim: report `NO-BASELINE`, never invent one from the changed build.
3. Capture current at the same state, then run:

       skill://visual-diff/scripts/vdiff.sh <baseline> <current> <diff-out> [fuzz%=2] [max-changed%=0.1]

   Output `SAME`, `CHANGED <pct>%`, `SIZE a -> b`, or `NO-BASELINE`; exit 0 within tolerance, 1 changed, 2 no baseline, 3 tool error.
4. Read the result:
   - Intended change: open the diff image and confirm the changed region is exactly the intended one. Then replace the baseline in the same commit as the change, and say so in the reply.
   - Unintended change: a regression. Fix it, or report it with the diff path.
   - Never raise the tolerance, crop, or re-baseline to make an unexpected diff pass.
5. Reply with the vdiff line, the diff image path, and the viewport.
