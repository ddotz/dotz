---
name: interrogate
disable-model-invocation: true
description: "Adversarial review where several isolated agents try to break a change or design and only findings proven by a run survive. Use for /skill:interrogate, 'tear this apart', 'stress test this', adversarial or multi-model review of a diff. Reports findings; never applies fixes."
---

Opinions are cheap; a failing command is not. Keep only what a run proves.

## Frame

1. Scope: what the user names. Otherwise the branch diff from its merge base with the default branch, plus uncommitted changes.
2. Intent: restate in one paragraph what the change must do, from the user's message, commit messages, and PR text. Ask the user only when the intent is genuinely unclear.

## Fan out

One `task` batch, every seat `isolated: true` (requires a git repo and plan mode off; isolation snapshots uncommitted changes into each worktree):

| Seat | Agent | When |
|---|---|---|
| Implementer's eye | `task` | always |
| Reviewer's eye | `reviewer` | always |
| Deep seat | `deep-reviewer` | one-way door only: a schema/migration, public API or wire format, auth/security, data deletion, or anything costly to undo after it ships. HEAVY alone does not qualify. |

Each brief carries the scope, the intent, and this assignment:

> Break this change. Prove each finding with a run against the real code: a failing test, a repro script, or command output showing the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding as: title, exact command, the output it printed, the output the intent requires. Leave out anything you did not run, including style, naming, structure, and risks that need a future change to matter. No findings is a valid result.
>
> Acceptance: every reported finding has a command and its captured output.

## Verify

Rerun every finding's command yourself. Keep a finding only when the output shows the failure AND the failure breaks the stated intent. Merge findings that share a root cause. Drop the rest.

## Output

- **Intent**: the restatement.
- **Findings**: per verified finding, the command, its output, how it breaks the intent, which seats found it, and a fix plan (the smallest change that makes the command pass, and the file it lands in). Say "no verified findings" when none survive.
- **Evidence**: every repro path and captured output file in one list, so the caller can rerun them.
- **Dropped**: per seat, how many findings were dropped and why (not reproduced, not against intent, style only).

Do not fix anything here; fixing is the caller's next step.
