---
name: correct
disable-model-invocation: true
description: "Turn a repeated correction of agent behavior into a deterministic check instead of another prose rule: find the mistake class, encode it at the strongest layer that works (config, guard hook, test), prove it blocks the bad case and passes the good one, and record it in the rule-coverage map. Use for /skill:correct, or when the user corrects the same mistake a second time."
---

A rule an agent can ignore is a wish. Every repeated correction becomes a check, or the reason it cannot is written down.

## 1. Find the mistake class

- Source: an open obligation of the `mistake` tool (`action: "list"`), the correction the user just made, what keeps getting blocked (`bun ~/.omp/agent/harness/guard-blocks.ts`, `bun ~/.omp/agent/harness/gate-stats.ts`), or past corrections mined from `~/.omp/agent/history.db` (`history.prompt`). In a project, the "never" and "must" lines of its `AGENTS.md` are candidates: each becomes a rule or stays prose with the reason written next to it.
- Name the class, not the instance: "installs with npm", not "ran npm i left-pad".
- Count occurrences you can cite. One occurrence of a cheap, unambiguous rule is enough; a judgment call needs two or more.

## 2. Pick the strongest layer that works

Two targets. Pick by where the mistake lives.

**Harness** (agent behavior in any project). In order; stop at the first that fits:

1. **Make it impossible**: config or model routing (`config.yml`, `model-tiers.json`), removing a tool or option.
2. **Block it deterministically**: a pure checker in a module under `~/.omp/agent/harness/guard/` (like `machine-rules.ts` or `external.ts`), wired into `guardToolCall` of `extensions/orchestrator-guard.ts`; or, for what a session leaves in the code it wrote, a class of the done gate (`~/.omp/agent/harness/gate/`). The block message names the rule and the right alternative.
3. **Catch it after the fact**: a check in `harness-tools.ts` (`harness_doctor`, token audit) that reports it, or a project rule file (`.omp/rules/*.md` with `scope: tool:edit(<glob>)`) that fires on the edit.
4. **Prose**: one line in `RULES.md` or `AGENTS.md`, only for judgment no check can decide.

New files never go directly in `extensions/`: every `.ts` there loads as an extension. Tests live in `~/.omp/agent/harness/tests/`.

**Project repo** (agents keep writing the same wrong code in one codebase). In order:

1. **Architecture**: one owner per piece of state, one supported way per task, internals hidden so the wrong import fails, the old way deleted.
2. **Types**, then **lint**: a type that makes the bad state unrepresentable; a rule in the repo's kit under `.omp/lint/` (ast-grep; `bun ~/.omp/agent/harness/gate/rules.ts <repo> --init` creates the kit, templates for a banned API and an import boundary are in `~/.omp/agent/harness/gate/templates/`). A rule's `message` names what to use instead, `metadata.origin` names the mistake it encodes, and its test holds the mistake as an `invalid` case and the alternative as a `valid` one; the done gate refuses a rule without them.
3. **Tests**: fix or delete tests that pass when behavior breaks or fail when only internals change.
4. **Prose** in the project `AGENTS.md`, for judgment calls only.

Order of work in a project repo: stop the bleeding first, then pay down.

1. **Gate new occurrences**: land the type or the rule first, in its own commit. `bun ~/.omp/agent/harness/gate/rules.ts <repo> --adopt <rule-id>` records the rule once together with the occurrences that already exist; from then on the done gate refuses every new occurrence in the files a session changes.
2. **Ratchet the existing ones**: `.omp/lint/baseline.json` holds the count per rule. It only goes down: `--update` records a lower count and refuses a higher one.
3. **Clean up the old ones**: migrate existing occurrences in batches, one module or directory per commit, each batch behavior-preserving (the ulw Refactoring playbook: pin, change, re-capture), then `--update`. A mechanical migration is one codemod script (ast-grep), not N workers.
4. **Close it**: at zero the baseline entry is gone and the rule is a plain error. Delete the prose line it replaced.

There are no per-line exceptions: the done gate refuses suppression comments, skipped tests, and edits that weaken an existing rule, baseline or `.omp/gate.json`. Only the user accepts a weaker gate, with `/gate-ok`.

A rule that already exists in prose but the mistake repeated is unenforced: fix it at a higher layer in the same change.

## 3. Prove it

1. Harness: add must-block and must-pass rows to the test file of the module you changed under `~/.omp/agent/harness/tests/`. The must-pass column holds the nearest legitimate commands, so the check cannot be a blanket ban. `cd ~/.omp/agent/harness && bun run check` is green (the commit hook runs it too).
2. Project: `bun ~/.omp/agent/harness/gate/rules.ts <repo>` prints `rules: ok`, and the rule fails on the mistake (its `invalid` case, or the real past instance).
3. Live: `cd /tmp && omp -p '<ask it to do the bad thing and report the tool response verbatim>'` shows the block message. Existing sessions keep the old extension until they restart.

## 4. Record it

- Close the obligation: `mistake` tool, `action: "resolve"`, with the cause, the check's kind and path, and the command that runs it.
- Harness rules: add or update the row in `~/.omp/agent/harness/rule-coverage.md` (status `code+test`).
- If the prose line is now redundant, shorten it to the guidance that saves a blocked call; never keep two full statements of one rule.

## Output

- Mistake class and the occurrences cited.
- Layer chosen, and why the stronger layers did not fit.
- Files changed, test result line, live block message.
