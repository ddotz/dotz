Tie every performance fix to a measurement; the measuring routine is `skill://perf`, vetted with `skill://benchmark-checklist`, and this playbook adds the pstack steps around it.

Do not read source instead of measuring, and do not claim a ceiling without running it.

1. Capture a baseline artifact (trace, profile, timings) on the matching surface through `verify-<app>` or the CLI. Run `skill://perf` sections 1-2 and vet the baseline, and every later number, with `skill://benchmark-checklist`.
2. Trace the code to ground hypotheses. Try the mantras in order, cheapest first, and stop when an earlier one meets the target: don't do it; do it, but don't do it again; do it less; do it later; do it when they are not looking; do it concurrently; do it cheaper.
3. Plan the fix from the trace. A fix that crosses a function boundary: `skill://architect` first. Delegate implementation to a worker with a specific scope; it returns a patch, the main session reads it and reviews the diff before applying. Verify each attempt before trying the next (`skill://principle-sequence-verifiable-units`); one change, one measurement.
4. Capture a post-fix artifact the same way and parse both (JSON to sqlite, diff). Wrong-surface or inconclusive is not a pass; flag it. Before reporting the delta, name what limits it and rule out that it measured something else (`skill://principle-explain-the-number`).
5. Cite the measurement (baseline, after, delta, run count, artifact path) in the PR body the main session writes; the worker never opens the PR (`playbooks/opening-a-pr.md`).

For sustained improvement against a metric rather than a one-off fix, use `playbooks/hillclimb.md`.

Reply: baseline number, post-fix number, delta with unit and run count, and the artifact path, in Korean plain text.

Source: pstack skills/poteto-mode/playbooks/perf-issue.md (MIT, skill://ulw/references/LICENSE-pstack).
