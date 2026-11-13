# Fleet: the owner's gateways as one pool of computers

Every dotz gateway of one owner on one tailnet already finds, pairs with and reads the others (`docs/peer-monitoring.md`).
Fleet adds three things on top of that trust: each gateway tells its peers how busy it is, one sheet shows every computer
with a plain state, and a session can start on another computer, picked by the owner or, when the switch is on, placed
there because this computer is full. The receiving gateway runs the work as its own session, under its own rules.

## What the pool adds

- Gateways that sign in to the same subscription account share its usage limit (`hub/limit-peer.ts` tells the others when
  a 리셋권 is spent). Moving a session to another computer does not add tokens.
- What the pool adds is room: memory and CPU for more sessions at once. A computer's session cap comes from its own free
  memory and load (`hub/limits.ts` for sessions, `hub/convcapacity.ts` for conversation sessions), so a second computer
  with free memory runs sessions this one would make wait.
- A computer signed in to a different account adds that account's limit too. The usage limit stays per computer: a
  computer paused on its limit is 꽉 참 for placement, whatever the others have left.

## Load (owning gateway answers, any paired gateway asks)

- `GET /api/peer/load`, in `PEER_GET` (`hub/peer-auth.ts`): the same two gates as `/api/peer/monitoring` (tailnet login
  and the peer token). The body, version `v` = `FLEET_V` (1):
  `{ v, name, at, sessions: { live, cap, reason }, lanes: { active, cap, waiting, reason? }, waitlist, paused, working, running: [{ kind, title, status }] }`.
  - `sessions`: conversation sessions live now and the cap with its reason (`maxLiveView`).
  - `lanes`: running sessions, the cap, how many wait for room and why (`laneCapacity`).
  - `waitlist`: items held for a usage-limit reset (`stateWaitlist`). `paused`: the orchestrator is paused on a usage limit.
  - `working`: the orchestrator or a session is in a turn now. `running`: at most 20 rows, a session's title only.
  - Never in it: account ids or names, project paths or content, briefs, reports, chat text.
- It answers with an `ETag` and `304` to `If-None-Match`, like the monitoring snapshot. A peer that answers 404 is older
  than Fleet: it is listed online with no load, and nothing is placed on it. `GET /api/fleet` gives it `online: true`, `load: null`,
  `legacy: true` and `state: "busy"` (`fleetState(null, true)`), and the sheet shows its old 연결됨 instead of a state label.

## The fleet list (local hub side)

- `GET /api/fleet` returns this computer first, then every paired computer from `knownComputers()` (relay and public rows
  left out): `[{ name, url, self, online, state, load }]`. An offline or unreachable peer is `state: "offline"`, `load: null`.
- Reads are cached like the peer list (`cached` in `hub/peers.ts`): a peer's load is kept 20 s and refreshed behind the
  request while stale, with a 2.5 s timeout. A `peer_counts` frame from that peer's event stream (`hub/peer-stream.ts`)
  drops its entry. The page asks only when the computer sheet is open. No model call and no timer that wakes a model.

## States (`fleetState`, one function for the sheet and for placement)

| state | 화면 | when |
|---|---|---|
| `offline` | 연결 안 됨 | no answer, or tailscale says the node is offline |
| `full` | 꽉 참 | sessions at the cap (`lanes.active >= lanes.cap`), sessions waiting for room, or paused on a usage limit |
| `busy` | 작업 중 | not full, and the orchestrator or a session is in a turn |
| `idle` | 여유 | otherwise |

A computer has room when its state is `idle` or `busy`. The reason under 꽉 참 is the cap's own reason (memory, CPU, the set
number) or the usage limit.

## Screen

- The computer chip's sheet (`web/js/33-peers.js`) is the fleet view: one row per computer as today, with the state pill
  in place of 연결됨 and one quiet line of what runs there (session titles). No new top-level screen.
- A session placed on another computer shows that computer's name on its row here (`load.running` of that computer, and
  the local record of what this computer sent there).

## Starting work on another computer

- The owner picks: `dotz_lane launch {computer}` (the owner's words name it, e.g. "맥북에서 해"), and from the web, the
  computer sheet's 여기서 시작 fills the chat input with that computer's name, so the request goes through the same
  orchestrator and launch rules.
- Placement by this computer: when `POST /api/lanes` would make a launch wait for room here (`launchWait`) and
  `fleet.auto_place` is `true` (ships `false`), the launch goes to the computer with room that has the project, `idle`
  before `busy`, then the most free session slots. None fits: it waits here as today.
- Checks before sending, each a plain refusal: the computer is paired and online, its `v` equals `FLEET_V`, it has room
  (manual pick: not `offline`), and the project exists there. A project is the same when the peer's project list
  (`GET /api/peer/projects`, each entry with `repo`: the normalized `origin` URL, no credentials) has the same repo. A project
  that is not a git repo with a remote lives only on its computer and is never moved. The branch to work from must be
  pushed (`git branch -r --contains HEAD`), or the launch is refused with "먼저 푸시".
- The forward: `POST /api/peer/act` action `launch` with `{ v, repo, branch?, title, brief, why, hours?, est?, owner_asked_for_lane?, conv }`; `branch` is the sender's current branch, and the receiver refuses when its folder is on another.
  The brief passes the same secret check as `dotz_peer` (`extension/peer-secrets.ts`). Model, worker model and `force`
  are never forwarded: the receiver uses its own.
- The receiver finds its project folder for `repo`, refuses a dirty working tree, runs `git pull --ff-only` (never a copy),
  then starts the session through its own `POST /api/lanes` route: its title rule, Done-when check, budget gate and
  session cap apply, and a refusal comes back as the answer. The session records `peer: { name, conv }`.
- Results come back: each report of such a session also goes to the asking gateway as `/api/peer/act` action
  `lane-report` `{ lane, title, text }` (a report that looks like it carries a secret is replaced by a note), which lands in the asking conversation like a local session's report, with
  `<computer> · <title>`. A question in it is answered from here with the existing `message` action, target `lane:<name>`.
  The asking gateway keeps `{ lane, computer, conv, title }` in `fleet-sent.json` for the sheet; it is dropped when the
  final report (`[done]` or `[fail]`) arrives. The asking gateway finds the conversation from that file, never from the report.
- Code: `hub/fleet-launch.ts` (`normRepo`, `placeLaunch`, the receiver and the report path); `POST /api/lanes` takes `computer`
  (a name other than this computer; answer `{ ok, placed, lane }`) and passes `peer` only from a launch that came from another
  computer, which is never placed on again. One `hub.log` line per placement decision.
- Reused plumbing: the peer trust, `/api/peer/act` and its proxy, the handoff's ack path (`ackHandoff`) for the report
  call, `dotz_peer`'s secret check, and the lane launch route itself. The handoff (`dotz_peer handoff`) stays for moving
  open work by the owner's word; `launch` is for new work.

## What stays on its computer

Mail, watches, schedules, standing permissions, logins and secrets, model and account choice, the budget gate's numbers,
project folders that are not a pushed git repo. A payload carries no secret, token, password, personal data or mail content.

## GOAT, compared (MIT, `github.com/goat-si/goat`, read 2026-11-13)

- Joining: a desktop or server-only install (`install-goat-server.sh --tailscale`) prints one-time pairing links (5 min);
  SSH hosts are reached over SSH. dotz pairs by tailnet login with no link (`hub/peer-pair.ts`).
- State: every 30 s a host samples load per core, CPU, free memory, disk and event-loop stalls, and holds a pressure level
  (ok / elevated / critical) with 3 min to rise and 5 min to clear (`fleet/pressure/pressureModel.ts`). Host status
  carries threads running, waiting and queued. dotz already has the cap from free memory and load, so Fleet reports that.
- Placement: `fleet/resources/placementRules.ts` refuses a host that is outside the selector, does not hold the project,
  is unreachable or stale, cordoned, or (for automatic work only) critical or at its cap; a person's own launch is never
  refused by caps. The survivors are scored by quota left and running tasks (`channels/channelPlacement.ts`). Projects
  belong to one environment; a repo identity correlates clones but never routes work by itself.
- Queue: GOAT Bot runs at most four items per requester (`WORKERS_PER_REQUESTER = 4`), the rest wait in order. dotz caps
  by free memory instead, and the waitlist holds work for a usage-limit reset.
- Results: a thread on another machine reports to the asking app through `remoteReports/`; its answers and approvals stay
  in the asking conversation. dotz does the same with `lane-report` and the `message` action.
- OmO and Aside: Aside has session hosts (`aside host list`, `aside --host`) for its own browser sessions; OmO has no
  remote host for agent sessions. Fleet does not depend on either.

## Out of scope

The pool is the paired gateways only. A machine without a gateway (an SSH server) and rented cloud machines were weighed and left out by the owner: a new computer joins by installing dotz and pairing, like any other.
