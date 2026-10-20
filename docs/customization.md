# Customization layer (`~/.dotz/custom`)

Every install wants something different on its web app: one owner wants a disk-space card on 홈, another wants their
side projects and a morning routine pinned in the sidebar. The custom layer lets the bot add these for its owner by
writing files in the data folder. The repo is never forked, and no gateway restart is needed.

## Why it looks like this: comparison with OmO

- OmO splits work by project folder. Its sessions live in `~/.omo/agent/sessions/<cwd-encoded>/`, one folder per
  working directory, and it keeps per-cwd state in `~/.omo/agent/projects/`.
- OmO's gateway pins a chat to a session through bindings: `~/.omo/agent/gateway/gateway.sqlite`, table `bindings`
  (`platform` discord, `chat_id`/`thread_id` -> `session_durable_id`). On Discord the owner sees one channel per
  project, fixed in the server sidebar (for example `#💬-tern` for the tern project).
- dotz mirrors the parts that fit. A project is a folder: lanes are grouped by their `cwd`, and the work channel a lane
  lives in (`channels.json` `homes` / `work`) is pinned with it. The web sidebar plays the role of the Discord channel
  list, and manual pins add projects that have no lane yet.
- dotz does not copy OmO's long-lived session per project. dotz keeps one orchestrator and one lane per goal, so a
  project page lists that folder's lanes and messages the orchestrator, tagged with the project.

## Folder layout

```
~/.dotz/custom/
  cards/<id>.json              a card, spec only
  cards/<id>/card.json         a card as a folder ...
  cards/<id>/render.js         ... with an optional render script
  pins.json                    sidebar: projects, routines, links
```

The gateway reads the folder on every `GET /api/custom`. A change shows up on the next page refresh: this is a hot
reload. Only new dotz code needs a gateway restart. A missing folder is an empty layer, not an error.

Templates: `docs/custom-examples/cards/disk-free/card.json` and `docs/custom-examples/pins.json`.

## Cards

`id` is the file or folder name and must match `^[a-z0-9][a-z0-9-]{0,39}$`. The gateway reads at most 30 cards and
rejects files over 16 KB.

| Key | Type | Meaning |
|---|---|---|
| `title` | string, 1-40, required | card title |
| `note` | string, max 120 | meta line under the title |
| `view` | `text` (default), `stat`, `list`, `kv` | how `data` is drawn |
| `text` | string | static content when there is no `command` |
| `command` | string | data command, run with `/bin/sh -c` |
| `cwd` | path | working folder of the command, `~` expanded |
| `every_minutes` | number >= 1, default 10 | how long the command output is cached |
| `timeout_seconds` | 1-60, default 10 | kill deadline of the command |
| `link` | `https://...` or `#view` | where a tap on the card goes |
| `order` | number | lower first, then by id |
| `actions` | array, max 4 | buttons on the card, see below |

Unknown keys are ignored.

### Actions: the card's own logic

A card can carry up to 4 buttons. Each one has a `label` (1-20 characters) and exactly one of these:

- `command`: runs like the data command (same `cwd` and timeout). The page toasts the first output line, and the card
  re-runs its data command and redraws.
- `prompt`: goes to the orchestrator as an owner web message, `[카드 <title>] <prompt>`, so the bot does the work.

`confirm: true` makes the page ask before running. A bad action makes the whole card invalid. The command text
stays in the card file: the page only sends the card id and the action index, so the web can trigger only what the
file declares.

So one card covers content (`text`, or the `command` output drawn by a view or by `render.js`) and logic (`actions`).

### Data command

The command runs the way `dotz_watch` runs its checks: through the same `exec` helper (`hub/watch.ts`), with a
timeout, its output cached in memory. Its stdout is trimmed. If the output parses as JSON, `data` is the parsed value.
Otherwise `data` is the text, up to 4000 characters. A request returns the cached value and refreshes it in the
background once it is older than `every_minutes`. Only the very first request waits for the run. A non-zero exit or a
timeout sets `error` to the output tail, keeps the last good `data` and marks it `stale` (the card shows `오래된 값`).
One card never runs twice at the same time.

### Views

- `text`: a string, or `{ "text": string }`.
- `stat`: `{ "value": string|number, "label"?: string, "sub"?: string }`, or a plain string or number (the value).
- `list`: an array of strings, or of `{ "title": string, "sub"?: string, "url"?: string }`. The card shows up to 50 rows.
- `kv`: an object (key -> value), or an array of `[key, value]` pairs.

### render.js

`render.js` is optional, for a card the four views cannot draw. It is a browser ES module:
`export default function render(data, ctx)`, where `ctx = { el, card }` and `el` is the page's `el(tag, props, ...kids)`
DOM helper. It returns a DOM node or a string, which is shown as text. The page loads it from
`/api/custom/render?id=<id>&v=<rev>`, where `rev` is the file's mtime. If the script throws or fails to load, only
that card turns into an error card.

## Sidebar pins: `pins.json`

```json
{
  "projects": [{ "name": "dotz 게이트웨이", "path": "~/Code/dotz", "channel": "<discord channel id>", "note": "..." }],
  "hide_projects": ["dir:~/Code/old"],
  "routines": [{ "id": "morning-check", "name": "아침 점검", "prompt": "...", "target": "main", "schedule": { "at": "09:00" } }],
  "links": [{ "name": "Cloudflare", "url": "https://dash.cloudflare.com" }]
}
```

- Project: `name` (max 40) is required, plus `path` and/or `channel`. `note` is optional.
- Routine: `id` (the card id rule), `name` (max 40) and `prompt` (1-4000 characters) are required. `target` is `main`
  (the default) or `lane:<name>`. `schedule` is optional and takes either `{ "every_minutes": >= 5 }` or
  `{ "at": "HH:MM" }` (daily, in the owner's time zone), not both.
- Link: `name` (max 40) and an `http(s)` `url`.

### Projects (auto plus manual)

- Each lane belongs to the project `dir:<cwd>` (home shown as `~`), named after the folder. Lanes in temp folders are
  skipped.
- The work channel a lane lives in (`homes[lane]`) is that project's channel. A work channel no lane points to becomes
  its own project, `ch:<id>`.
- A manual pin merges into the auto project with the same path or channel. Otherwise it creates a new project. The
  pin's name wins, and pinned projects come first, in file order. Auto projects follow, newest lane first, at most 12.
- `hide_projects` hides auto projects by key. It never hides a manual pin.

The project page (`#project/<key>`) reads `GET /api/custom/project?key=<key>`: a summary strip (running lanes, lanes
waiting on the owner, last activity), the lanes with their last report line (from `lanes/<name>/report.md`, which
outlives a gateway restart), finished time, verified or reported-only, resume and clean-up; the latest results (lane
`[done]`/`[fail]` reports, the folder's verification receipts, the newest commits, newest first); for a git folder the
branch, uncommitted file count, last 5 commits and `lane/*` branches not merged into main; the open tasks of
`state.json` that name the project (in the gateway's own checkout, also those that name no other project), a tap sends
one as a request; and the work channel, threads, lane channels, routines, schedules and watches tied to it. Two
columns from 1100px, one on a phone. The request box sends to the orchestrator (prefixed
`[프로젝트 <name> · <path>]`), to a running lane of the project, or asks the orchestrator for a new lane.

### Routines

One click on a routine sends `[루틴 <name>] <prompt>` as an owner web message, to the orchestrator or to the lane in
`target`. A routine with `schedule` keeps exactly one `dotz_schedule` entry whose text starts with
`[routine:<id>:<hash6>] ` (`hash6` = sha1 of the routine's JSON). The gateway syncs these entries at start and whenever
`pins.json` changes: it removes stale ones (the id is gone, the routine changed, or its schedule was removed) and adds
missing ones. Schedules without the `[routine:` tag are never touched.

## Validation: a broken file never breaks the page

Everything is validated at the boundary, in `hub/custom.ts`:

- A card with bad JSON, a bad id, a missing title or a wrong value comes back as `{ id, file, error }`. 홈 draws it as
  an error card and keeps rendering the rest.
- A `pins.json` that does not parse adds `{ file: "pins.json", error }` to `errors`, and the pins are empty. Auto
  projects are still listed.
- A single bad entry in `pins.json` is dropped with its own `errors` entry. The other entries stay.

## HTTP API

All routes sit behind the same auth as every other `/api` route.

- `GET /custom.js`: the web side (`web/custom.js`).
- `GET /api/custom` returns `{ dir, cards, projects, routines, links, errors }`.
- `GET /api/custom/render?id=<id>` returns the card's `render.js`.
- `POST /api/custom/refresh {id}` re-runs a card's command now.
- `POST /api/custom/action {id, index}` runs a card action. It returns `{ ok, code, output, card }` for a command, or
  `{ ok }` for a prompt.
- `POST /api/custom/routine {id}` runs a routine now.

구성 lists every card, routine and the pins file under the form `웹 맞춤`.

## Rule for the bot

Anything this layer can express goes to `~/.dotz/custom`, and the bot checks it with `GET /api/custom` (`errors` is
empty, the card has `data`). Only a need the layer cannot express (a new view type, a new API, gateway behavior) goes
to the dotz source, as a lane on the dotz repo (MODE.md, Customization).
