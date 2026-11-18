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
| `DOTZ_WORKER_GATE=<agent dir>` | the orchestrator and conversation sessions, unless `workers.harness_gate` is false, and only with the harness installed | not read by the harness; the dotz extension reads it (extension/worker-gate.ts) |

A rename or a new meaning needs both sides in one step.

## 2. What loads where

dotz runs each session in one of two modes (`laneMode` in hub/lanestate.ts). Every session starts from
`--no-extensions --extension <dotz extension>` and the dotz overlay; the mode decides what the harness adds.

- Assistant mode: the orchestrator, conversation sessions, and every lane that is not coding. No harness extension, rule, skill
  or prompt text. Their replies are the assistant's, and the harness's reply checks do not fit them.
- Coding mode: an omp lane whose work is code in a git repo, and only that. The same, plus the harness done gate
  (`<agent dir>/extensions/done-gate.ts`) right after dotz's extension. It loads when `lanes.harness_gate` is not false (unset
  means on) and both `extensions/done-gate.ts` and `harness/gate/bootstrap.ts` exist (hub/done-gate.ts). Nothing else of the
  harness loads: no guard, rule, skill or other extension. Missing files: the lane starts without the gate; one log line, and
  only when the setting is explicitly true.
- A lane's mode is set once, at launch (`mode` in `lane.json` and on the lane in `/api/state`): the `mode` the launch asked for
  (`dotz_lane`, `POST /api/lanes`), else coding when the lane got a git worktree, else assistant. A `lane.json` from before modes
  holds no `mode` and reads by the same rule from its worktree. `dotz_lane` action `mode` (`POST /api/lanes/<name>/mode`) changes
  it and restarts the lane on its session so the gate loads or drops; omp only, any other runtime refuses, because only omp can
  load the gate. A switch to coding bootstraps the worktree before the resumed session's first message; any other restart or
  resume is not bootstrapped again.
- Task workers of the orchestrator and of conversation sessions: with `workers.harness_gate` not false (unset means on) and the
  same two files present, the hub sets `DOTZ_WORKER_GATE` and the dotz extension loads the gate inside each task subagent
  only (extension/worker-gate.ts). It imports two exports of the deployed harness: `registerDoneGate` from
  `extensions/done-gate.ts` (never the default export, so no `mistake` tool and no `/gate-*` commands) and `needsBootstrap`
  from `harness/gate/bootstrap.ts`. The main agent's run registers nothing: its prompt, tools and turns are the same with the
  setting on or off. The gate sees the worker as a main session without a UI (`agent.kind` "main", `hasUI` false, no `ui`).
  omp fires no `session_stop` for a subagent, so the stop judgement runs at the worker's final message (an
  `assistant_message` without tool calls) when the worker changed files in a git repo; a refusal goes back to the worker as
  a steer and it takes another turn. OmO does not get it.
- The hub runs the gate bootstrap for a fresh lane worktree, and the dotz extension runs it for a worker's repos (its cwd
  repo at its first prompt, each changed repo before the stop judgement, once per repo per process); the model never does.
  A repo whose checks all fail (`nothing-passed`) is recorded by the harness and not bootstrapped again, so it does not loop.
- Open: a worker in an isolated copy (`isolated: true`) of a checkout that holds an untracked, script-written
  `.omp/gate.json` gets that file copied; the harness records the script's writes per checkout, so the copy is not
  bootstrapped again and the gate refuses its first stop once (`verify:gate-not-from-script`). The orchestrator's cwd (the
  data dir) has no such file today.

## 3. Replies the gate passes

`ok`, `-` and `[later]` are dotz protocol answers. The done gate passes them in every reply stage.

## 4. Restart

- A dotz session restarts only through the gateway: `<data dir>/restart-pending.json` holds new workers and launches while
  a restart waits (extension/restart-hold.ts), and a refused start leaves `restart-held` (a lane's in its folder, the
  orchestrator's in the data dir) so the next gateway start tells it to go on.
- The harness's own session restart (the `session_restart` tool, the restart after a harness deploy) is for the owner's
  interactive sessions. It is not loaded in dotz sessions and must not restart one.
- Task workers never leave deferred checks: without a UI the gate's stop waits for running checks inside the worker's run,
  and the gateway counts that run as a running subagent while a restart waits.
- Open: while a restart waits, a lane's done-gate checks left running (the harness's deferred checks, `pendingLater` in
  `harness/gate/later.ts`) do not count as busy work for the gateway. A lane runs in RPC mode, where omp gives `hasUI`
  true, so its gate can defer a check at a stop.
