---
name: tdd
disable-model-invocation: true
description: "Red-first bug fix: write the failing regression test, prove it fails for the intended reason, fix, then prove the test catches the bug by removing the fix. ulw enters it when the owner asks for TDD, a failing test, or a regression test, or when the bug has an obvious cheap local test target. Skip when the test path is unclear, expensive, integration-heavy, or not requested."
---

# TDD bug fix

When a bug has a clear, cheap test path, make the broken behavior executable before changing production code. The goal is a focused regression test that fails before the fix and passes after it, and a proof that it fails because of the bug and nothing else.

Do not force a test when it would be impractical. If the test would need broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn, skip the new test and use the closest useful verification instead.

## Workflow

1. **Understand the bug.** Identify the intended behavior, the current behavior, the affected path, and the smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest unit, component, integration, or regression test already used for that code path (in a bun repo, a `bun:test` file next to it). If no practical test path is obvious, do not build one from scratch to satisfy this workflow.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. It encodes the intended behavior, not the current implementation.
4. **Run it before fixing (red).** Run `bun test <file> -t "<name>"` or the repo's equivalent. Read the failure message. It must fail for the intended reason: the assertion that states the bug, not an import error, a typo, a timeout, or a missing fixture. If it passes, or fails for another reason, fix the test or the reproduction before touching production code.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior and keeps the nearby contracts.
6. **Rerun it (green).** Confirm the test passes, then run the neighbors in the same file.
7. **Mutation proof.** Show that the test depends on the fix. Remove the fix, run the test, and confirm that exactly the new test fails with the same message as in step 4. Restore the fix in a `finally` (an `EXIT` trap in shell). Then confirm `git diff --stat` is the same as before the proof.

## Mutation proof

Record `git diff --stat` before the proof. Save the production part of the change as a patch, reverse it, run the test, and re-apply the patch from an `EXIT` trap so the restore runs even when the test run fails. The subshell scopes the trap to this one proof:

```sh
git diff --stat > /tmp/before.stat
git diff -- src/fix.ts > /tmp/fix.patch
(
  git apply -R /tmp/fix.patch
  trap 'git apply /tmp/fix.patch' EXIT
  bun test src/fix.test.ts -t "the new test name"
)
git diff --stat | diff - /tmp/before.stat
```

List only the production files in the `git diff` path list, never the test file. If the fix is staged, use `git diff HEAD -- <files>`. For an untracked production file, copy it aside and move it back in the trap instead of diffing it.

Read the test output. Exactly the new test must fail, and the failure message must match step 4. Another failing test means the fix touched more than the bug. A passing test means it does not guard the bug: rewrite it. Delete `/tmp/fix.patch` and `/tmp/before.stat` afterward.

## If a failing test is impractical

Use the closest executable regression check: a targeted script, a manual reproduction command, browser automation, a snapshot comparison, a log assertion, or a focused integration check. Run the same mutation proof against it where it can be re-run.

Prefer no new test over a bad test. A bad test mostly tests mocks, encodes implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, or would be deleted right after proving the fix.

## Guardrails

- Never edit a test to fit the implementation. The test states the intended behavior. When the code disagrees, the code changes.
- Do not weaken an existing assertion unless the expected behavior has genuinely changed and you can state the reason. The done gate refuses skipped tests and weakened gate files, but it cannot see a loosened assertion. You can.
- Keep the regression test on the bug. Avoid broad fixture churn and unrelated coverage.
- If the bug is flaky, make the test deterministic where you can, and name the signal you lock down.
- If the bug exposes a broader class of failures, land the focused regression test first, then consider sibling coverage. For a parser or serializer pair, add a property test (`skill://pbt`).

## Final answer

Report the evidence, not only the outcome:

- The failing-before test or check, and the failure it produced.
- The passing-after run and any nearby validation.
- The mutation proof result: which test failed with the fix removed, and that `git diff --stat` matched before and after.
- If failing-before evidence could not be shown, say why and name the closest regression check used.

Source: pstack skills/tdd/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
