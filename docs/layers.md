# Layers: chat, project, session, subagent

Owner request 2026-10-21. This file is the design of record for the four work layers, what lives in each, how reports
travel up, the data model and its migration, and the screen map per device class. Code that changes a layer cites it.

## 1. The layers

| Layer (owner word) | Was | What it is for | Who runs it | Where the owner talks to it |
|---|---|---|---|---|
| 채팅 (chat) | chat | the super-orchestrator: routes every request, owns the whole picture | the main orchestrator | web 채팅 (main), Discord chat / dm |
| 프로젝트 (project) | work channel / 구성 project band | every long-term secretary role: continuous, recurring or routine work (monitors, schedules, logins, mail watch and auto-reply are examples) with a goal and progress | the orchestrator acting in the project's channel (`ch:<id>`) = the project orchestrator | web 프로젝트 -> project chat, Discord work channel |
| 세션 (session) | lane | one small-to-medium job with one goal (a feature, a migration, a research pass) | a dotz session process (`dotz_lane`) | web 세션, Discord session channel / thread |
| 서브에이전트 (subagent) | worker | one parallel piece inside a session or the orchestrator turn | `task` children | shown under their parent, never addressed directly |

Rules:
- Chat decides where a request goes: answer directly, hand it to a project (`ch:<id>`), or start a session.
- A project is any long-term role the assistant plays for the owner as their secretary (owner 2026-10-21: the listed
  kinds are examples, not the boundary): whatever repeats, must keep running, or keeps being looked after over time.
  Examples: monitors, schedules, routines, logins to keep, mail watch + auto-reply, a recurring report, keeping an eye
  on a service, an ongoing personal errand. Such work is never a bare chat timer or a loose session: chat creates (or
  reuses) the project first, then the monitor, schedule or session inside it.
- A project may run sessions (`home: "ch:<id>"`); a session started from chat with no project stays a top-level
  session. A session never owns a monitor or a schedule; it reports and ends.
- Subagents belong to exactly one parent (chat, a project turn or a session) and report only to it.
- OmO evidence: OmO layers the same way (session -> `task` children -> teams); a child's result is delivered to its
  parent as a completion notification and "an idle session is always woken" (OmO CHANGELOG, Stop hook waits for
  background subagents, #2077). dotz keeps that contract one level up (session -> chat).

## 2. Names (owner-facing vs internal)

- Owner-facing words: 프로젝트, 세션 (was 레인), 서브에이전트 (was 워커). English UI: project, session, subagent.
- The old owner-facing meaning of "세션" (an agent's conversation record: session file, rotate, handover, "같은 세션으로
  다시 시작") becomes **대화 기록** (en: conversation). "인계" stays.
- Internal identifiers stay: the `dotz_lane` tool, `lane:<name>` targets, `~/.dotz/lanes/<name>/`, `lane.json`,
  `config.lanes`, `/api/lanes/*`, the `lane/<name>` git branch, `[lane exited]` gateway notices. Changing them would break
  running sessions and stored state for no owner-visible gain. Agent-facing prompt text says "session (dotz_lane)" so
  the agent maps the word to the tool.
- Every project and session has an owner-facing **title**: 2-4 plain words in the owner's language about the work
  ("디스코드 설정", "메일 자동답장"). Never a repo name, folder name, key or codename (owner 2026-10-17). The key
  (`name`) stays internal.

### Naming path (the "dotz" bug)

Seen on a second Mac: onboarding, then "Discord 설정해줘" ran as a project named `dotz`. Cause, in code:
- `hub/custom.ts` projectsView groups sessions by folder and names the group `basename(path)` -> `dotz`.
- `lane.json` does not store the title, so nothing better was available; `hub/discord.ts` laneChannel falls back to the
  lane key when no title is given.

Fix:
- `dotz_lane` launch requires `title`; the gateway rejects a title that equals the key, the folder or repo basename,
  or is codename-shaped (ASCII `[a-z0-9._-]+` only) with a one-line reason, so the agent retries with plain words.
  The title is stored in `lane.json` and returned in `/api/state` lanes.
- A project's title comes from, in order: the stored project record (§4), the pinned name, the work channel name, the
  title of the session that started it (its first session), and only then the folder basename.
- Work channel names (`dotz_channel create`) get the same check as session titles.

## 3. Report flow (nothing lost, nothing twice)

```
subagent --completion--> session --report--> chat (orchestrator)
                              \--> session channel/thread + report.md (always)
project turn (orchestrator in ch:<id>) --> project channel; chat gets one pointer line
```

- A session report is written to its channel and `report.md` first, then relayed (hub/lanerelay.ts): `[ask]`,
  `[fail]`, `[done]` and untagged go in whole, `[run]` stays on disk, duplicates are dropped, reports during a busy
  turn are steered in at once.
- `[ask]` is stored as `pendingAsk` (lane.json + pending-ask.md) until the owner (or the orchestrator) writes to the
  session, so a restart never loses it. The owner sees it once per surface: the session's chat (decision card), the
  home "답 필요" list, Discord session channel (buttons). The orchestrator is told once and is not asked to repeat it.
- Project-homed sessions report the same way; the orchestrator handles the report in that project's channel.

## 4. Data model and migration

New file `~/.dotz/projects.json` (hub/projects.ts), keyed by the project key already used by the web (`ch:<id>` or
`dir:<path>`):

```json
{ "projects": { "ch:123": {
  "title": "메일 자동답장", "purpose": "새 메일을 보고 정해진 답을 보내요",
  "goal": "회사 메일 응답 자동화", "milestones": [{ "text": "감시 등록", "done": true }],
  "paused": false, "updated": "2026-10-21T..." } } }
```

- Absent file = today's behaviour. A record overrides the derived title/purpose; the derived project list
  (projectsView) is unchanged otherwise. The work channel setup's `purpose` stays the source until the owner edits it
  on the project page; an edit writes both (setup purpose and the record) so the orchestrator prompt and the page agree.
- Monitors (hub/watch.ts) belong to a project through their `channels` (already stored); schedules and routines through
  their `target` (`ch:<id>`). `paused` on a watch stops its timer without deleting it.
- lane.json gains `title` (optional on read; old files show the key until relaunched).

API (all behind the hub token, JSON):
- `GET /api/custom/project?key=` adds `record` (the stored fields), `monitors` (id, name, command summary,
  every_minutes, on, pattern, lastRun, lastOk, nextAt, fails, paused), `routines`/`schedules` scoped to the project.
- `PUT /api/projects` `{ key, title?, purpose?, goal?, milestones?, paused? }` -> the merged record.
- `PATCH /api/watches/<id>` `{ every_minutes?, pattern?, on?, paused? }` -> the watch.
- `PATCH /api/schedules/<id>` `{ every_minutes?, at?, text?, paused? }` -> the schedule.
- `GET /api/todo?target=main|lane:<n>|ch:<id>` -> `{ phases: [{ name, tasks: [{ content, status }] }], at }` from the
  latest `todo` tool result `details` in the target's OmO session file, or `{ phases: [] }`.

## 5. Screens

NAV: 홈, 채팅, 프로젝트, 세션, 설정. 구성 (the harness map) is a row under 설정 and opens as a sub-view; old `#harness`
links still open it.

- 프로젝트 list: one card per project: title, purpose line, status dot, progress `n/m`, counts (sessions, monitors).
- 프로젝트 main: header (title, purpose; tap to edit in place) and an "프로젝트 채팅" button that opens the project
  orchestrator chat. Then: 목표와 진행 (goal + milestones, progress bar, add/check/edit), 루틴과 모니터링 (each row:
  name, interval, last / next run, health; edit interval / pattern, pause / resume), 세션 (rows with status, opens the
  session), 최근 결과.
- 세션: running sessions as a list of cards (title, project, status, waiting question, subagents n/m), ended ones folded.
- 채팅: target switcher groups 채팅 / 프로젝트 / 세션; the header names the layer. A todo strip sits above the timeline
  (current item + done/total, tap to open the phased list, hidden when empty or all done; reference: herdr-web-ui's
  plan chip). A decision card docks above the composer while the target waits on the owner: the question, numbered
  options as full-width rows (the recommended one tagged), tap sends the option number as the owner's message; typing
  still works.

Device classes (CSS px; foldable values at DPR 2.625, source: herdr-web-ui-browser docs/foldable-testing.md, Samsung
emulator skins and GSMArena):

| Class | Viewports | Layout |
|---|---|---|
| bar phone | 360x800, 390x844 | one column, bottom nav |
| Fold8 cover | 475x751 | one column, bottom nav |
| Fold8 Ultra cover | 411x960 | one column, bottom nav |
| Fold8 inner | 696x933 | two-column cards where they fit, side nav |
| Fold8 Ultra inner | 859x954 | two columns, side nav |
| tablet | 768x1024, 1024x768, 1024x1366, 1366x1024 | two columns, side nav |
