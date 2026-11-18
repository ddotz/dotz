Sustained, iterative improvement of one measurable thing against a target. A one-off fix is Bug fix or `skill://perf`; this is the loop. Main owns the metric and the experiment's integrity; workers write the attempts.

Core discipline: one change, one measurement, keep or revert. Never stack untested changes; never claim a win from code inspection (`skill://principle-prove-it-works`).

1. Ground the workload and architecture before choosing the metric. Trace the target, name the workload dimensions that can move the result (data size, history, state, concurrency), and pick a case that reproduces the complaint. No case reproduces it: fix the repro instead of hillclimbing. Then fix one metric, the direction that counts as better, and a checkable stop predicate pairing a target with a floor on attempts so a lucky early win cannot end the run ("at least 50% better than baseline and at least 10 iterations"). Use the owner's numbers when given, otherwise agree them with the `ask` tool.
2. Build the measurement harness, prove its sensitivity, then freeze it (`skill://principle-build-the-lever`). Run contrasting realistic workloads: the target case must show the symptom and easier cases must separate as expected, else revise workload or metric. Vet it with `skill://benchmark-checklist`; print the error count and a count of work done. Frozen means one repeatable command emits the metric, sampled past noise (median of N, alternating A,B,A,B as in `skill://perf`). Record the baseline and one green run of the regression gate (the tests that must keep passing) before any change. Say so when the machine is busy (`uptime`).
3. Open the trail with `skill://decision-log` at `.omp/decision-log.tsv` (untracked). One row per iteration, columns mapped:
   - ts: stamped by the script.
   - phase: `hill-<n>` (iteration number; `hill-0` for the baseline row).
   - decision: hypothesis plus the change in one line.
   - why: the mechanism from step 4, in plain words.
   - evidence: pointer to the raw measurement file (`.omp/hillclimb/<name>/iter-<n>.txt`) or commit SHA, with before, after, delta in that file.
   - result: `kept -12.4% median of 9, tests green` or `reverted: within noise` or `reverted: gate red`.
   Read the last rows before each attempt. Rows are written as each iteration lands.
4. Ground each hypothesis in the architecture model from step 1, so it names a mechanism ("defer X off the boot path because it blocks first paint"), not "try memoizing something". For a perf metric, order hypotheses by the mantras in `skill://perf` section 4; borrow the order only, not its stop rule.
5. Loop, one hypothesis per iteration:
   - Main briefs one `task` worker per hypothesis: tight scope, exact paths, the frozen harness command, the Acceptance line, no measuring of its own result as final. Writing workers run `isolated: true` and return a patch; main reads the patch, then `git apply`s it (`skill://principle-guard-the-context-window`: review the diff, do not type it). Several independent hypotheses fan out as one `task` batch, each isolated (`skill://principle-separate-before-serializing-shared-state`); apply and measure them one at a time, `git apply --check` the rest after each.
   - Main measures before and after with the frozen harness on the real tree, then runs the regression gate.
   - Keep only when the metric moves past noise and the gate stays green. Otherwise revert in full (undo the applied patch; no `git stash` in a shared tree). A tweak that "might help" is not kept.
   - One commit per kept fix through the eval `commit` namespace so only your lines are staged. Log the row either way.
   Each iteration ends in a check before the next starts (`skill://principle-sequence-verifiable-units`).
6. Wake mechanism for unattended runs. TUI main session: enter loop mode with the `loop` tool (`action: enter`, a `prompt` that names this file and the log path, an `iterations` or `minutes` bound, and a `condition` command that runs the harness and checks the stop predicate). Where the `loop` tool is refused (print/RPC session, dotz): run the harness loop as a background bash job (`timeout: 0`) that appends to the iteration file, or drive attempts in eval `agent()`/`wait()` waves. Workers never start loops. Borrow only the wake mechanism from `playbooks/autonomous-run.md`, not its stop rule.
7. Push past the first plateau. After several rejects in a row: pivot category, combine near-misses, re-read the source, or try something more radical before concluding the hill is climbed. Correctness and simplicity outrank the number: revert a win that breaks behavior, keep a simplification that holds the number (`skill://principle-laziness-protocol`).
8. Stop when the predicate is met, or the remaining ideas are marginal and not worth their cost. Do not relax the predicate to meet it, and do not quit while cheap untried hypotheses remain. Stuck: surface it instead of spinning. Last row states the final predicate result; run `log.sh --check` on the log.
9. A PR only when the owner asked for one: run `playbooks/opening-a-pr.md` from main with the kept commits stacked in the order they landed.

Reply (Korean, plain text): the metric and target, baseline to final with the percent delta, iterations run (kept vs reverted), each kept fix on one line, the decision log path, and the best idea to try next if pushed further.

Source: pstack skills/poteto-mode/playbooks/hillclimb.md (MIT, skill://ulw/references/LICENSE-pstack).
