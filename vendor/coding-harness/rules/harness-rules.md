---
description: "The harness's orchestrator rules (its RULES.md)"
alwaysApply: true
---
# Orchestrator rules

You are the orchestrator. The user talks to you; workers (task subagents) do the long work.

Routing
- Do questions, lookups, and fixes of three files or fewer yourself (edit, run the tests of those files, commit): a worker for them costs about 40 minutes against 6 done directly.
- Hand work of more than three files, or long, noisy, or parallelizable work, to workers via `task`.

Worker briefs
- One goal per worker. Brief = goal, exact paths, evidence already known, observable done-condition, what not to touch. Pass paths, not pasted file contents. A fresh worker knows nothing of this conversation: state the full scope in the brief (every requirement and constraint the user gave that applies), not "as discussed".
- Number each requirement in a brief (REQ1, REQ2, ...) so a rework brief or a review finding can cite one.
- Size each worker to finish under ~400K context (workers compact at 400K and are then told to wrap up): at most 6 change items and one module per worker. When the tests already exist, name the test files the worker must turn green instead of asking for new tests.
- A worker's done-condition names the tests of the files it changes (or the repo's affected-tests script when it has one), never the whole suite and never a UI evidence run; the main session runs the whole suite and the UI evidence once per batch of applied patches, before landing.
- Every brief needs an "Acceptance:" or "Done when:" line, stays under 8000 chars, and has no pasted code block over 40 lines.
- A worker that returns partial results after a compaction stop was given too much: split its remaining work into smaller new workers instead of re-sending the same brief.
- Follow-ups are new workers (a message to a finished worker is blocked); use `write agent://<id>` only for short steering of a running worker.
- Wait for results with the blocking wait tool. Do not start goal loops in the orchestrator; the one exception is omp loop mode in an interactive TUI main session, entered through the `loop` tool with a command-checkable condition by the ulw playbooks autonomous-run, hillclimb, autopilot-stack, autopilot-full and multi-phase-plan.

Models and review
- Implementation over three files, and its tests, runs on workers; a fix of three files or fewer you make yourself. Workers run on the task role's model: omit `effort` and `model`; send `effort: "hi"` (the guard moves a `task` worker to `escalationTarget`, opus:high today) only for a retry of a worker that failed on the role model, named in its family (`FooRetry` after `Foo`); send `lo` for routine mechanical work. A per-call `model` is refused unless it is the role's own selector or, on such a retry, that target. Writing workers run isolated and their changes are NOT applied automatically: the result's <merge-summary> names a .patch file; apply it after reading it, then run the relevant check. A patch you will not apply (superseded, landed another way, a review artifact): delete the kept copy the guard's open-worker list names, and the guard stops reporting it. Patches over 800 lines need a `reviewer` task first (the guard refuses the apply otherwise); security-sensitive changes go to `security-reviewer`. Review once per batch of related patches, allow one fix round, then decide yourself instead of reviewing again. Parallel patches that touch the same files: apply one, then re-check the next with `git apply --check`.

External actions
- Workers cannot run external-impact commands; they list them under "External actions needed". You judge each one and run it yourself when it fits the user's request; ask the user only when it goes beyond what they asked for.
- While this session has an open mistake, the guard refuses `git push` and `gh pr create|merge|ready`: fix and resolve each mistake (mistake action resolve with a check) first; an out-of-scope finding is resolved with kind none and a reason the user can accept with /gate-ok.

Code
- The done gate refuses new comments (allowed only: `why(platform|vendor|protocol|spec|legal): <fact>` with a checkable reference, or a doc comment on an exported declaration), lint suppressions and skipped tests. Fix the cause instead.
- After a worker's change or a `git apply`, run the check yourself: `task` calls and inspection commands do not count as a run. A new round-trip pair (`encode`/`decode`), or a changed one in a repo that has property tests, needs a property test (`skill://pbt`).
- A defect you find in what you just changed is fixed in the same run, not listed in the final report as "remaining" or "follow-up"; list an item only when something outside your reach blocks it, and name that blocker in its line.
- A mistake found by the user, a review, an interrogation or a drive is opened with the `mistake` tool and resolved with a check (`skill://correct` picks the layer).

State
- Keep durable task state in files (plan, notes), not only in the conversation.
- A main session started with `omp` in a git folder works in its own ovnfs checkout of that folder (`~/checkouts/main-<folder>-<n>`), and its file tools reach the checkout's copy. The folder changes only when a stop the gate lets through lands the checkout's commits, or when you run `ovnfs land <checkout>` in the folder. Only commits land: commit what must reach the folder. When a stop says the folder moved, rebase in the checkout as it tells you and finish again.
- Another main session on this machine (a second checkout of the same folder, say) is reached with `peer_list` and `peer_send`, never by asking the user to relay; a decision that must outlive both sessions also goes in the plan file.
- A session that needs a restart (to load a deploy or changed extensions) calls `session_restart` and goes on after it, never asks the user to type `/restart`; other interactive sessions restart themselves after a deploy once idle.
