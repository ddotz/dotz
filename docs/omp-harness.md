# dotz and an omp harness: the boundary

dotz on omp can share the machine with an omp harness the owner installs in `~/.omp/agent` (extensions, a done gate, a
guard, session restart). Both sides change on their own, so what one side relies on from the other is written here. A
change to any line below updates this file in the same commit, and the harness side follows this file, not the other way.

## 1. Which session is which (environment)

The hub sets these on every omp process it spawns (hub/runtime/omp.ts); the harness reads them to tell dotz sessions from
the owner's own.

| variable | set for | the harness uses it for |
|---|---|---|
| `DOTZ_RUNTIME=omp` | every dotz process | done gate: skip the `plain` and `report` stages and the skill reminder (`inDotz`) |
| `DOTZ_LANE=<name>` | a lane | guard: worker state per lane; repeat guard: no UI confirm, refuse instead |
| `DOTZ_ORCHESTRATOR=1` | the orchestrator and conversation sessions | repeat guard: no UI confirm, refuse instead |
| `DOTZ_CONV=<key>` | a conversation session | not read by the harness |

A rename or a new meaning needs both sides in one step.

## 2. What loads where

- Orchestrator and conversation sessions: `--no-extensions --extension <dotz extension>` and the dotz overlay. No harness
  extension, rule, skill or prompt text. Their replies are the assistant's, and the harness's reply checks do not fit them.
- Lanes: the same, plus the harness done gate (`<agent dir>/extensions/done-gate.ts`) when `lanes.harness_gate` is true and
  both `extensions/done-gate.ts` and `harness/gate/bootstrap.ts` exist (hub/done-gate.ts). Missing files: the lane starts
  without the gate, one log line.
- Task workers of the orchestrator: being added (the worker gets the gate's code stages, main turns stay as they are).
- The hub runs the gate bootstrap for a fresh worktree; the model never does. A repo whose checks all fail
  (`nothing-passed`) must not loop.

## 3. Replies the gate passes

`ok`, `-` and `[later]` are dotz protocol answers. The done gate passes them in every reply stage.

## 4. Restart

- A dotz session restarts only through the gateway: `<data dir>/restart-pending.json` holds new workers and launches while
  a restart waits (extension/restart-hold.ts), and a refused start leaves `restart-held` (a lane's in its folder, the
  orchestrator's in the data dir) so the next gateway start tells it to go on.
- The harness's own session restart (the `session_restart` tool, the restart after a harness deploy) is for the owner's
  interactive sessions. It is not loaded in dotz sessions and must not restart one.
- Open: while a restart waits, a lane's done-gate checks left running (the harness's deferred checks) do not count as busy
  work for the gateway.
