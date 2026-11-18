Fix a bug from runtime evidence: every shipped line traces to a run, and the smallest change the evidence justifies ships. A line that "might help" is a hypothesis, not a fix; it does not ship.

1. Reproduce it yourself on the user's surface through the project's `verify-<app>` skill (`skill://verify` creates it when none exists); save the exact command and its wrong output. Ask the owner to reproduce only with a stated reason the surface cannot be reached, after driving it as far as it goes. If it will not reproduce, synthesize the trigger, tighten conditions, or instrument until it fires. A bug that appears only after a restart or reload: check persisted state (storage, files, DB, cache) before the code path.
2. Binary-search the cause. Seed the hypothesis list with a trace of the affected subsystem and `skill://why` for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate; cheapest run first. When program state is unclear, add instrumentation or logging and read it as the code runs. Do not guess. An inconclusive run is not a pass. A long or stubborn hunt routes to `playbooks/autonomous-run.md`.
3. Confirm the surviving mechanism with runtime evidence, then trace to the first place the system went wrong; fix there, not where the symptom shows. Revert any code added for a refuted hypothesis.
4. Plan the fix. If it crosses a function boundary, run `skill://architect` first. Delegate the fix to a worker with a specific scope (paths, the confirmed mechanism, the repro command); the worker returns a patch, the main session reads it before applying.
5. Test first when a test is cheap: write it, watch it fail for the intended reason (`skill://tdd`), never edit a test to fit the code. Skip it, with a stated reason, when the test would be expensive, integration-heavy, or unclear.
6. Mutation proof: with the fix reverted the repro test fails; with it applied the test passes. Name one plausible product bug the test catches and one harmless refactor it survives.
7. Stage the commits so the failing repro test lands before the fix in git history: the test commit first, the fix commit on top (one verifiable unit each, `skill://principle-sequence-verifiable-units`).
8. Verify on the same surface: the original repro now passes. Wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
9. A PR only when the owner asked for one (or an autopilot queue grant covers it): run `playbooks/opening-a-pr.md` from the main session; the worker never pushes or opens it.

Reply: what was broken, root cause, fix, how you verified, in Korean plain text. Paste the failing-then-passing repro output verbatim.

Source: pstack skills/poteto-mode/playbooks/bug-fix.md (MIT, skill://ulw/references/LICENSE-pstack).
