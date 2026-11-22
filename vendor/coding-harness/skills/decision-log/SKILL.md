---
name: decision-log
disable-model-invocation: true
description: "Keep a reviewable decision trail for long, multi-phase, or unattended work: one TSV row per decision (what, why, evidence, result). Use for /skill:decision-log, the ulw Long run playbook, or work the user reviews after stepping away."
---

A reviewer coming back should rebuild the run from the log alone, without reading the transcript.

## Format

One TSV file, one row per decision, every cell single-line:

| column | content |
|---|---|
| ts | ISO8601 UTC, stamped by the script |
| phase | phase or workstream name |
| decision | what was chosen or done, one line |
| why | the reason in plain words |
| evidence | a pointer, never prose: commit SHA, `file:line`, artifact path, command |
| result | outcome: `tests green`, `reverted`, `diff empty`, `INCONCLUSIVE`, `open` |

## Where

`.omp/decision-log.tsv` at the repository root (the working directory outside a repo). When several efforts run at once, give each its own file, `.omp/decision-log/<task-slug>.tsv`, so their rows do not interleave. Local by default. Commit it only when the user asks or the stakes need an auditable record.

Two example rows, as a reviewer reads them:

```
ts	phase	decision	why	evidence	result
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the instructions for next time
```

## Logging

```bash
~/.omp/agent/skills/decision-log/scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>
```

The script writes the header on first use and never truncates a log that already has content, stamps `ts`, flattens tabs and newlines, and quote-prefixes cells starting with `= + - @` so spreadsheets don't execute them.

The log is append-only. A decision that changes is a new row whose decision starts `supersedes <ts>:`; never edit or delete an old row.

Before the final reply, check that every evidence pointer still resolves (commit SHAs exist, `file` and `file:line` paths exist in the tree); a row that a later `supersedes <ts>:` row replaces is skipped when it is the only row with that `ts`. Rows that share a second cannot be told apart by the pointer, so they stay checked:

```bash
~/.omp/agent/skills/decision-log/scripts/log.sh --check <logfile>
```

Log decision points, not actions: a fork chosen, a unit finished with its check result, a pivot or revert with its trigger, a blocker, a gate fixed. In a loop, one row per iteration. Write rows as each step lands, not at the end.

## Runs

A run is one agent session. A new session appending to an existing log first reads its last rows, then writes a row with phase `start` whose evidence names this session and whose decision names the `ts` range written by others since this run last wrote. Use phase `start` for nothing else.

## Done

Before the final reply, the log has a row for every unit's verification result, the last row states the final predicate result, and `log.sh --check` passes.

## Audit the log against the transcript

Before handing back, check the log told the truth. Read this run's transcript through `history://<id>` (bare `history://` lists sessions; read only this project's). Walk this run's rows against what happened. A stretch of rows begins at one of this run's `start` rows, or at the first row if this run created the log, and ends at the next `start` row of another run.

- Every row maps to a real decision or action.
- Every row's evidence resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but is not logged is a gap: add it.

Correct the log, not the story. The audit never edits or removes a row, even an invented one. A row that records neither a real decision nor a real action, or whose claim or evidence is wrong, gets a new row that supersedes it with what happened and a pointer that resolves. Rows outside this run's stretches are not checked; if this run's own work shows one is wrong, supersede it like any wrong call.

## Cross-tier review of the trail

Self-review is not a substitute. Before handing back, the main session spawns one worker (agent `reviewer`, or `task` when the author ran at base tier) so that its tier differs from the author's, and that wrote none of the rows. Deep tier is for a one-way door only. The brief names the log path and the transcript ids, and carries an Acceptance line. The worker reads the trail and the transcript and flags what the owner should look at. It does not redo the work. Its final answer is the flags, not a transcript.

- decisions logged with weak or absent evidence;
- verification steps skipped, or claimed without proof in the transcript;
- choices that look risky in hindsight (premature, scope-creeping, papering over a symptom);
- gaps the owner would miss on a casual skim.

The reply for a run that produced a trail ends with an attention section. Its first line names the reviewer's tier (for example `reviewed by worker tier`), never a model name. Then each flag points to specific rows or moments. "No flags" is a valid value. A flag that exposes a wrong row is fixed by a superseding row, as above.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. `column -s$'\t' -t <logfile>` renders it in a terminal; GitHub renders a committed TSV as a table.

## Composing

Other skills route their audit trail here instead of inventing one. Reference this skill by name and let it own the format; do not restate the columns. Prefer evidence produced by committed scripts over hand-made one-offs.

Source: pstack skills/show-me-your-work/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
