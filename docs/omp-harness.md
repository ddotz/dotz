# dotz and an omp harness: the boundary

dotz on omp can share the machine with an omp harness the owner installs in `~/.omp/agent` (extensions, a done gate, a
guard, session restart). Both sides change on their own, so what one side relies on from the other is written here. A
change to any line below updates this file in the same commit, and the harness side follows this file, not the other way.
dotz's own sessions load none of that install's extensions: a coding-mode lane loads the copy of the harness that dotz ships and
installs in its own data dir (section 5). The limit: a dotz session still runs on the owner's omp agent dir, so a rule or an
agent in `~/.omp/agent` with the same name as one in the payload shadows the payload's in coding sessions, by omp's own
precedence. Removing that is a separate change: a `PI_CODING_AGENT_DIR` of dotz's own that shares only the auth.

## 1. Which session is which (environment)

The hub sets these on every omp process it spawns (hub/runtime/omp.ts); the harness reads them to tell dotz sessions from
the owner's own.

| variable | set for | the harness uses it for |
|---|---|---|
| `DOTZ_RUNTIME=omp` | every dotz process | done gate: skip the `plain` and `report` stages and the skill reminder (`inDotz`) |
| `DOTZ_LANE=<name>` | a lane | guard: worker state per lane; repeat guard: no UI confirm, refuse instead |
| `DOTZ_ORCHESTRATOR=1` | the orchestrator and conversation sessions | repeat guard: no UI confirm, refuse instead |
| `DOTZ_CONV=<key>` | a conversation session | not read by the harness |
| `DOTZ_CODING_HARNESS=<payload dir>` and `HARNESS_AGENT_HOME=<payload dir>` | a coding-mode omp lane (a process spawned with `SpawnOpts.codingHarness`); the hub's gate bootstrap of its worktree gets `HARNESS_AGENT_HOME` too | the dotz extension reads `DOTZ_CODING_HARNESS`: its copies of checks the payload's own extensions cover stand down, and only the rules dotz alone has stay in its guard (extension/guard-dotz.ts: a lane merges only through `dotz_merge`, shared dotz files are written by their owner, the quick chat's reach, usage-limit stop lines, eval-started workers, the expensive-model gate); `HARNESS_AGENT_HOME` is the payload folder the payload's extensions resolve their files and state from |

A rename or a new meaning needs both sides in one step.

## 2. What loads where

dotz runs each session in one of two modes (`laneMode` in hub/lanestate.ts). Every session starts from
`--no-extensions --extension <dotz extension>` and the dotz overlay; the mode decides what the harness adds.

- Assistant mode: the orchestrator, conversation sessions, and every lane that is not coding. No harness extension, rule, skill
  or prompt text. Their replies are the assistant's, and the harness's reply checks do not fit them.
- Coding mode: an omp lane whose work is code in a git repo, and only that. The same, plus the coding harness payload in
  `<data dir>/coding-harness` (section 5): its `done-gate`, `orchestrator-guard` and `harness-tools` extensions right after
  dotz's extension, then the payload folder itself (its rules and agents), and its skills and `AGENTS.md` through the overlay
  (hub/done-gate.ts `codingHarnessFiles`). It loads when `lanes.harness_gate` is not false (unset means on) and a finished
  install of the payload is there (`codingHarnessDir`, section 5). The owner's `~/.omp/agent` is never a fallback: without the payload the lane starts without the
  harness; one log line, and only when the setting is explicitly true.
- A lane's mode is set once, at launch (`mode` in `lane.json` and on the lane in `/api/state`): the `mode` the launch asked for
  (`dotz_lane`, `POST /api/lanes`), else coding when the lane got a git worktree, else assistant. A `lane.json` from before modes
  holds no `mode` and reads by the same rule from its worktree. `dotz_lane` action `mode` (`POST /api/lanes/<name>/mode`) changes
  it and restarts the lane on its session so the harness loads or drops; omp only, any other runtime refuses, because only omp can
  load the harness. A switch to coding bootstraps the worktree before the resumed session's first message; any other restart or
  resume is not bootstrapped again.
- Task workers of the orchestrator and of conversation sessions run no done gate; the orchestrator checks a worker's result.
- The hub runs the gate bootstrap for a fresh lane worktree, and the dotz extension runs it for a worker's repos (its cwd
  repo at its first prompt, each changed repo before the stop judgement, once per repo per process); the model never does.
  Both run it with the payload as `HARNESS_AGENT_HOME`. A repo whose checks all fail (`nothing-passed`) is recorded by the
  harness and not bootstrapped again, so it does not loop.
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

## 5. The coding harness payload

- `vendor/coding-harness/` in the dotz code is a pinned copy of the harness's public payload, produced by the harness repository's
  `agent/harness/ship.ts`. It is never edited by hand: `bun scripts/sync-coding-harness.ts <harness checkout> [--commit <rev>]`
  ships into a sibling folder and swaps it in, so a failed ship keeps the old copy. `vendor/coding-harness/SHIPPED_FROM` holds the
  harness commit. The `vendor/` segment is what the harness's own done gate reads as vendored code, so a session that syncs a
  new copy is not judged for the copied lines.
- Install: `hub/coding-harness-install.ts` runs once at every gateway start whose runtimes include omp, and `hub/main.ts` waits for it
  before it starts the orchestrator and restores lanes, because both read the folder when they spawn. The wait is bounded (the
  `bun install` step stops after 120 s) and an install that fails is logged, never thrown. Every dotz version change
  (self-update, a re-run of `install.sh`, a `git pull`) ends in a gateway restart, so this one place sees each new copy;
  `install.sh` and `setup.ts` need no step of their own. It fills `<data dir>/coding-harness` (never `~/.omp/agent`) and is
  idempotent: with `SHIPPED_FROM` and `harness/.setup-version` equal to the vendored commit, no `INSTALLING` marker and the
  dependencies in place it changes nothing. Any other state starts by writing `INSTALLING` and ends by removing it, so the
  folder counts as installed (`codingHarnessDir`) only when `SHIPPED_FROM` is there and `INSTALLING` is not: not before the first
  install, not while one runs, and not after one failed, until a later start succeeds (a spawn that needs it then starts without
  the harness, section 2). Files: `SHIPPED_FILES` first lists every path the old and the new tree name; the
  files the old install listed and the new tree dropped are deleted (one already gone is fine, an entry that leaves the folder, is
  absolute or runs through a symlink is skipped), then the new tree's files are replaced (a path through a symlink refuses the
  install; a file or folder in the way that `SHIPPED_FILES` does not list fails it, and a shipped folder may become a file and
  the reverse); then `SHIPPED_FILES` lists the new tree only and `harness/.setup-version` and `SHIPPED_FROM` name the commit.
  Anything else in that folder (`gate-state/`, `orchestrator-state/`, `harness/logs/`, the harness's own state) is left alone.
  `bun install --frozen-lockfile` runs in `harness/` only when its `package.json` or `bun.lock` changed since the last
  successful install or `node_modules` is missing; one that fails or is stopped makes the install failed.
- The gateway's own environment never names a payload: omp spawns strip an inherited `HARNESS_AGENT_HOME` and
  `DOTZ_CODING_HARNESS`, and get them only from the hub's decision for that process (`codingHarnessEnv`); the
  bootstrap child is stripped the same way.
- A coding-mode lane is spawned with it: `hub/done-gate.ts` finds the folder with `codingHarnessDir(DATA_DIR)` and `hub/lanerun.ts`
  passes it as `SpawnOpts.codingHarness` (section 2). The orchestrator and conversation sessions never get it.
- `hub/check.ts` scans `hub/`, `extension/`, `features/`, `onboard/`, `firstrun/`, `web/`, `site/` and `setup.ts`, so
  `vendor/` and `scripts/` are outside every rule by their place. The root `package.json` has no workspaces and the
  release install runs `bun install` at the root only, so `vendor/coding-harness/harness/package.json` joins neither.
