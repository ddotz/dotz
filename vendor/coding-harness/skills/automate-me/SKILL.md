---
name: automate-me
disable-model-invocation: true
description: "Mine the user's own omp prompts for repeated corrections and working habits, confirm each with the user, and turn them into AGENTS.md edits or checks. Entered when the user asks to capture how they work (\"내 습관 반영\", \"automate me\"), or every few weeks of active use."
---

Goal: fewer repeated corrections. Output goes into the files agents already read (`~/.omp/agent/AGENTS.md`, project `AGENTS.md`) or into a check via `skill://correct`. Never create a second preferences file that drifts from them.

## 1. Extract (script, no model reading raw transcripts)

    bun skill://automate-me/scripts/mine.ts --since <date> --out /tmp/automate-me.jsonl

- Source: `~/.omp/agent/history.db` (only what the user typed), each prompt paired with the end of the reply it answered (`prev`). Scratch dirs and the dotz gateway are skipped.
- `--since`: the last commit date of `~/.omp/agent/AGENTS.md` (`git -C ~/.omp/agent log -1 --format=%cs -- AGENTS.md`), so a rerun mines only new history. First run: omit it.
- Under 30 prompts: say the history is thin, mine anyway, and treat every finding as low confidence.

## 2. Find signals

Read the JSONL yourself; above ~300 rows, split it by date into 3 slices and give each to one `task` worker with the categories below. A signal counts when it appears at least twice (in 2+ slices when sliced). Drop single occurrences.

- Corrections: the user rejects, redoes, or repeats an instruction ("아니", "왜 또", "다시", "하지 말라고"). Read `prev` to see what the agent did.
- Response shape: length, language, format, what the user asks to remove or add.
- Verification posture: what the user checks by hand or asks to be shown.
- Delegation and cost: model, worker, and quota remarks.
- Process: commit, branch, deploy, naming, file-location habits.

For each signal: one sentence, the evidence (2+ quotes with dates), and whether `AGENTS.md` already says it (grep it). Already stated but still corrected = the prose is not working: route it to `skill://correct`.

## 3. Confirm with the user

Ask in rounds of 1-2 questions (the `ask` tool), each candidate with options: add as written / reword / drop / make it a check. End with one free-form question for anything missed. Never write a habit the user did not confirm; history shows what happened, including mistakes the user put up with.

## 4. Write

- Confirmed preferences: edit `AGENTS.md` in place (the section where it belongs, one line each, no duplicate of an existing line). Keep only rules that differ from default agent behavior.
- Repeated corrections: hand the list to `skill://correct` so each becomes a guard, test, or config where possible.
- Commit the harness change with the eval `commit` namespace.

## 5. Reply

Prompts mined and date range; each confirmed item and where it went; items dropped and why; corrections handed to `correct`.
