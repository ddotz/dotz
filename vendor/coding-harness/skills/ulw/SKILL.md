---
name: ulw
disable-model-invocation: true
description: "Rigor mode for non-trivial work: restate the goal, size the work LIGHT or HEAVY once, run one playbook from skill://ulw/playbooks/, apply the principles it touches, and stop only when every success criterion has real-surface evidence. Entered from the omp router rule ~/.omp/agent/rules/routines.md (main sessions only), the literal keyword `ulw`, or /skill:ulw; hidden from the catalog so task workers never enter it."
---

Ship exactly what was asked, proven on the real surface, with the smallest change that does it. Ported from pstack's poteto-mode; omp rules (`agent/RULES.md`, `agent/AGENTS.md`) win where they differ.

## 1. Open

First message on the task, before any tool work:

- The owner's goal, the problem behind it, and (if the task ships a change) the smallest change you expect to meet it. Do not wait for confirmation. Restate the goal in each worker brief, open each PR's `## Why` with it, and open the final reply with it.
- If evidence rules out the requested change, show the evidence and stop.

## 2. Size once (ratchet up only)

Default LIGHT. Take HEAVY only on a fact you can point to in what THIS session will change: a new layer, service boundary, or domain model (a new file of self-contained functions is not one); auth, security, sessions, or permissions; building or changing an external integration (calling an existing API is not one); a schema or migration; concurrency, transactions, or cache invalidation; a refactor crossing domain boundaries; or the owner asked for care or review. Unsure means HEAVY. A HEAVY fact found mid-task upgrades immediately and redoes what LIGHT skipped. Never downgrade.

| | LIGHT | HEAVY |
|---|---|---|
| Criteria | 1-2: happy path + riskiest edge | 3+: happy, edge, regression, adversarial |
| Proof | one real-surface run | one real-surface run per criterion |
| Review | self-review line | `skill://interrogate` on the diff |

Record the tier and its one-line reason in the plan file.

## 3. Pick one playbook

Read the matched file in full before the first edit or worker spawn, LIGHT work included; then copy its numbered steps verbatim as the first todos. A step you skip stays in the list as `skip: <reason>`. Files live at `skill://ulw/playbooks/<file>.md`.

- `investigation`: read-only question (how does X work, why is Y like this, are we sure about Z, X or Y).
- `bug-fix`: a reported defect to reproduce, root-cause, and fix with runtime evidence.
- `perf-issue`: measured slowness to trace and improve against a baseline.
- `hillclimb`: sustained improvement of one metric against a target, one change per measurement.
- `runtime-forensics`: diagnose a live symptom (leak, spin, glitch) by instrumenting it.
- `trace-forensics`: diagnose a captured artifact (cpuprofile, trace, spindump, heap snapshot).
- `feature`: new or changed behavior, built from a named data shape.
- `refactoring`: behavior-preserving change to structure.
- `prototype`: a throwaway build to settle an observable fork instead of asking.
- `visual-parity`: pixel-exact UI equivalence across a migration.
- `authoring-a-skill`: writing or editing a skill or router entry.
- `eval`: blinded A/B of a skill or rule change before promoting it.
- `babysit`: drive a PR or stack to merge-ready (conflicts, review threads, CI). Every PR-status request ("check on PR X", "get it green", "address the review comments") lands here; it never merges. "Check on X" runs its read-only `check` mode: one status pass and a report.
- `shipping`: land a green stack after an independent per-head verdict.
- `opening-a-pr`: push and open a PR, only when the owner asked for one or an autopilot queue grant covers it; otherwise a finished change stops at committed and verified.
- `autonomous-run`: one task driven to a checkable predicate without stopping ("run until done", "going to bed").
- `orchestrate`: a standing program of many units and patches, coordinated by this session.
- `autopilot-stack`: a queue of PRs built and verified, then handed over. Default for any autopilot request.
- `autopilot-full`: the same queue merged, only when the owner asks for merging explicitly and grants the queue.
- `multi-phase-plan`: work spanning phases or stacked PRs; the plan is checked by `scripts/check-plan.ts`.
- `session-pickup` and `pause-safely`: resume or suspend in-flight work (`skill://pause` owns the procedure).
- `worktree-cleanup`: reclaim disk from stale worktrees (`skill://worktree-cleanup`).

A large or cross-cutting effort, or work the owner reviews after stepping away, routes to `skill://figure-it-out` even when a narrower playbook fits; a standing program of many units and patches routes to `orchestrate` instead. No playbook fits: `skill://figure-it-out` designs one and writes it in the plan file.

Real surface for UI and apps: a change a user can see is proven through the project's `verify-<app>` skill (`.omp/skills/verify-*/`). None exists: run `skill://verify` to create it first. A surface that cannot be driven here (native mobile, a Tauri window) is reported as "not drivable here"; never claim it works.

## 4. Triggers while working

- An "which approach" or "what should this do" fork whose answer is observable (behavior, timing, output, layout, perf): settle it with `playbooks/prototype.md` or a measurement, not a question. Exception: a read-only investigation whose deliverable is a cited answer stays an investigation (`playbooks/investigation.md`) and answers from the evidence instead of building a prototype. Ask the owner only product or preference calls and irreversible actions.
- Any code: name the data shape first and its organizing structure (`skill://principle-model-the-domain`).
- Code crossing a function boundary: `skill://architect`. Several valid shapes: `skill://arena`. Contested design before shipping: `skill://interrogate`.
- Parallel fan-out for coverage, races, or exploration: `skill://swarm`.
- Nontrivial multi-step work: write the throughput checkpoint (`playbooks/feature.md` step 4).
- Before changing a shared symbol, persisted shape, IPC contract, or config: `skill://blast-radius`.
- A bug with a cheap local test: `skill://tdd`. Parsers, serializers, pure transforms: `skill://pbt`. A promise like "never charged twice" on HEAVY concurrency work: `skill://formal-verify`.
- The owner asks to prune or clean up tests, or a suite under your change holds copies, tests of removed code, or tests pinned to internals: `skill://prune-tests`.
- Running a benchmark or reporting a number you measured: `skill://benchmark-checklist`.
- Motivation or history of code: `skill://why`. How a subsystem works: `skill://how`. The owner wants to understand it: `skill://teach`.
- English docs, PR bodies, commit messages: `skill://technical-writing`. Every prose surface, the reply included: `skill://unslop`.
- Before review or ship when the diff keeps or touches comments: `skill://no-comments`.
- TypeScript: `skill://typescript-best-practices`.
- A review bot or security review commented: skeptical triage per `skill://ulw/references/bugbot-triage.md`.
- Long, autonomous, or multi-phase work: a trail in `skill://decision-log`.
- A broken skill mid-task: fix it as its own unit; never work around it silently.
- The owner did not follow the reply: `skill://bro`. The request is ambiguous enough that a wrong reading wastes a worker: `skill://in-your-own-words`. A vague task needs a stronger prompt: `skill://sharpen`.

## 5. Principles

Index: `skill://ulw/references/principles.md` (24 principles, each with its trigger). Read a principle's `skill://principle-<id>` file in full before applying it. The reply names each principle that shaped a decision by its id and the choice it changed; cite only principles read this session (the done gate refuses an unread citation).

## 6. Workers and models

- Implementation and QA: `task` workers (worker tier), briefs per the orchestrator rules already in context. A brief names the `skill://` files the worker must read first. Workers never spawn workers (recursion depth 1), never push, open, reply on, or merge PRs; they return patches and this session runs every external action.
- Review of a risky patch: `reviewer`, of a different tier than the author where possible.
- `deep-reviewer` (deep tier) ONLY for one-way-door judgments: the `skill://arena` judge seat and the deep seat in `skill://interrogate`.
- New work goes to a fresh worker with consolidated scope (the original brief, later directives, the prior result's path). Never message a finished worker.
- You own every worker's output: read the patch, write your own summary, never pass a worker's report through.

## 7. Rules while working

- Tests alone never prove done. A green suite proves the unit contract; the criterion needs its real-surface run (curl, CLI output, TUI, browser, DB diff).
- A test must catch a bug: for each new test, name one plausible product bug it catches and one harmless refactor it survives.
- Wrong gate, separate fix: a check that is itself wrong is fixed as its own step with a reason, never loosened to get green.
- Status words: each criterion ends PASS (run shown), ISSUES (what failed), or BLOCKED (what is missing). A gap in evidence is not a pass.
- Autonomy: reversible work proceeds without asking. Always pause for irreversible writes (force-push to a shared branch, deploy, data deletion, messages to people) and for pushes and PRs the owner did not ask for. "Don't stop", "going to bed", "run until done" mean keep going. Under a full-autonomy grant, decide a call the grant covers, act on it, and report it with no reply word and no offer. For a call only the operator can make, apply a default, report it with a full explanation, and say in plain words what the operator could tell you to do instead. The operator answers in their own words; never ask for a shorthand token to type back. Gates the operator named and the always-pause list above still bind.

## 8. Done

Done when every criterion has evidence captured at the current tree, cleanup is finished, and (HEAVY) `skill://interrogate` returned no verified finding that breaks the intent.

Final reply, in Korean plain text, written clean as you draft it (`skill://unslop`):

1. Goal, one line.
2. What changed, by file or behavior, framed for the user and for the next maintainer.
3. Each criterion: the command or surface run and what it showed.
4. Principles that shaped decisions, by id, with the choice each changed.
5. Residual risk or what was not verified, stated plainly. Every claim carries its evidence or a confidence label; never hand the owner a check you could run.

Source: pstack skills/poteto-mode/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
