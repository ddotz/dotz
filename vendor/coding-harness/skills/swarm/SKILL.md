---
name: swarm
disable-model-invocation: true
description: "Fan out N parallel workers from the main session, drain them with a blocking wait, and return one report. Entered from ulw for parallel coverage, races, gauntlets, exploration, or any task that splits into independent slices."
---

The main session fans out and aggregates. Workers never spawn workers (recursion depth 1), so a swarm is one flat batch of `task` calls.

## Phases

Open one todo per phase: Frame, Canary, Fan out, Aggregate, Report.

### Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape: partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare the selection rule before spawning: `first pass`, `rank all`, or `best-of`.
3. Pick the agent per worker: `scout` for read-only work, `task` for writing, `reviewer` or `security-reviewer` for review seats. Tier and speed come from the role. For a clearly hard slice, raise `effort` one level; never more. Never write a model name. For a tier race, name each arm's role up front.
4. Give each writing worker its own output. Two or more writers in one call run isolated (`isolated: true`; the guard forces it for parallel writers, a lone writer runs in place), so each returns a patch and nothing is applied until you read it; when the repo uses bun, each runs bun install in its worktree first, and you apply the patches one by one. Slices that touch the same files will conflict: partition by file or module, or apply one patch and `git apply --check` the next.
5. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method: sample count, what one sample is, order. The worker records both in its result.
6. Check shared resources. Isolated worktrees share this machine's ports, browsers, simulators, and disk. Cap parallel lanes that use one of those, or give each its own port.

### Canary

Run one unit first, alone. Read its result against the brief. A brief that makes one worker misread the goal will make all N misread it. Fix the brief, then fan out the rest.

### Fan out

Spawn all remaining workers in ONE `task` batch. Each brief stands alone and follows the limits in `agent/RULES.md`:

- one goal and one module, at most 6 change items,
- the goal, scope, exact slice or race arm, how to verify, and what to report,
- an `Acceptance:` or `Done when:` line, under 8000 characters, no pasted code block over 40 lines (pass paths),
- the exact `skill://` files the worker must read first,
- "do not spawn, push, open or merge PRs, or write to GitHub; list those under External actions needed",
- a final answer of at most ~800 characters, led by `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it. Wait with a blocking `wait`; never poll.

### Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names and respawn that worker once as a new worker. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the declared selection rule. Read each merge-summary patch before applying it, then run the relevant check yourself. Do not paste raw worker dumps.

### Report

Return one consolidated report: a result list (slice, verdict, evidence), one-line issues, gaps or dropouts, and the race rule when used. Plain text in the terminal, no table markup.

Source: pstack skills/swarm (MIT, skill://ulw/references/LICENSE-pstack).
