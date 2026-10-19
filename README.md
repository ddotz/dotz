# dotz (땃쥐모드)

An always-on, Dori-style global orchestrator for omp. A gateway process (launchd `dev.dotz.gateway`) hosts the
땃쥐 orchestrator as a headless omp session, so no terminal has to stay open. You talk to it from Discord, from a
tailnet-only web app, or from any omp terminal after saying "땃쥐모드 켜". Project work runs in lanes: one headless omp
orchestrator per project folder, each with its own Discord channel.

## Install and onboard

```bash
git clone <this repo> ~/Code/dotz
cd ~/Code/dotz
bun setup.ts --load --tailscale     # interactive; or --answers answers.json
```

The wizard (Korean) asks for the bot's name, character and tone (presets or your own line; Enter takes the default,
the short casual-polite tone of the 오모냥 secretary), the notice style, what the bot calls you (optional; empty = no
title at all) and an optional avatar, then Discord and web access. The identity
lands in `~/.dotz/identity/IDENTITY.md` and drives everything: how the bot talks, its Discord username/avatar, the
category names (`<name>`, `<name> 작업`), and the terminal phrase
"<name>모드 켜". Re-run setup any time to change it; existing answers are the defaults.

Setup writes `~/.dotz/config.json` (no secrets), keeps the bot token in `~/.dotz/secrets/` (0600), links
the plugin into omp (`~/.omp/agent/extensions/dotz`), generates and (with `--load`) starts the launchd gateway,
and (with `--tailscale`) serves the web app on the tailnet only. It prints the bot invite link.

**Language.** `identity.language` in `config.json` (a code such as `ko`, `en`, `ja`) is the identity's main language.
Setup writes it automatically, detected from the script of the identity answers (Hangul `ko`, kana `ja`, Han only `zh`),
else from the system locale, else `en`, and puts a `- Language:` line in `IDENTITY.md`; a re-run keeps an existing
value, and you can edit it by hand (restart the gateway to apply). When the key is missing (older installs) the
gateway detects the language the same way from `identity.character` and `identity.tone` while it runs. Everything the
gateway tells its agents follows it, so replies stay in that language: the contract, the lane footer, the
`[dotz gateway]` notes, the `[handover]` memo, inbox hints and the nightly review prompt. Korean and English have
originals. Any other language gets the English text plus one line, `Reply to the owner in <language> (<code>).`, at the
end of each prompt that carries instructions (the orchestrator's first prompt, the lane footer, the lane rotation note,
the nightly review). The bracket tags (`[dotz gateway]`, `[handover]`, `[dotz lane <name>]`, `[dotz inbox]`) stay
literal in every language. The contract file for a language other than English is looked up as
`~/.dotz/MODE.<lang>.md`, then `MODE.<lang>.md` in the repo, then the English `~/.dotz/MODE.md` and the repo's
`MODE.md`, so a translation for another language is a drop-in file.

Onboarding also asks for the macOS permissions (`onboard/permissions.ts`). The gateway is a launchd job whose program is `bun`, so
macOS attributes every protected access by the gateway and everything it spawns (omp, osascript, aside, git) to `bun`:
the prompts and the Settings entries are for the bun binary, not your terminal. Setup asks for them once, up front:
Full Disk Access (no prompt, you switch it on in Settings; it also covers Desktop/Documents/Downloads and removable and
network volumes), Files and Folders for Desktop, Documents and Downloads (prompts), Automation for System Events (prompt),
and Accessibility (Settings). The probes run as a short launchd job (`dev.dotz.permprobe`) so the answers are for bun
too. `bun setup.ts permissions` runs the same step any time and is safe to rerun (granted items are skipped);
`bun setup.ts permissions --check` only prints the state and never raises a dialog. New grants apply to the running
gateway after `launchctl kickstart -k gui/$(id -u)/dev.dotz.gateway`.

Discord: create a dedicated bot in the Developer Portal, enable the MESSAGE CONTENT intent, give its token to setup,
and invite it with the printed link. The gateway creates two categories: "땃쥐" (the main channels 대화, 알림, 작업로그)
and "땃쥐 작업" (one channel per project, topic or lane, named plainly with no emoji). Every text channel in these two categories
is a work channel; threads in them are sub-items. It listens to nothing else, and only the configured owner id can
command it.

## Use

- Discord: write in 대화 (or DM the bot) for anything; it routes each part to the project channel it belongs to and
  splits long-running work into a new channel. Write in a project channel or a thread to work on just that; write in a
  lane channel to talk to that lane directly.
- Web: `https://<this-machine>.<tailnet>.ts.net:<tailscale_https_port>` (allowed Tailscale logins only).
- Terminal: in any omp session say "땃쥐모드 켜"; your input then goes to 땃쥐 and replies appear there.
  "땃쥐모드 꺼" returns the terminal to normal.

## Commands

Owner messages that start with `/` (web chat box) or `/`/`!` (any bot channel in Discord) followed by a known command
name are answered by the gateway itself and never reach the orchestrator; unknown names in Discord fall through to it.
`POST /api/command {"text": "/status"}` runs the same parser.

| Command | Effect |
| --- | --- |
| `/help`, `/status`, `/lanes` | commands, orchestrator/lane/Discord state (with context usage and compaction state), lane list |
| `/context` | per process (orchestrator and every lane): context tokens, context window, percent, compaction state |
| `/compact <orchestrator\|<lane>>` | compact that process's context; queued after the current turn if it is working |
| `/model [orchestrator\|lanes\|workers\|<lane>] [<model>] [<thinking>] [--force]` | show or set model and thinking level; a model may be a unique part of its name; `workers` sets `lanes.worker_model` |
| `/effort <target> <level> [--force]` | thinking level: off, minimal, low, medium, high, xhigh, max, auto |
| `/restart gateway\|orchestrator\|<lane>`, `/stop <lane>`, `/resume <lane> [text]`, `/abort [orchestrator\|<lane>]` | process control (restart and resume keep the session; `gateway` waits until the orchestrator and lanes are idle, at most 20 min) |
| `/providers`, `/quota` | logins and keys (masked) plus providers you can add, usage limits per provider and model window |
| `/login [<provider>]`, `/login <provider> <code or redirect URL>`, `/login cancel`, `/logout <provider>` | sign in (prints a link; the second form finishes a login opened on another device), cancel a pending login, sign out |

Model changes: `orchestrator`, `lanes` and `workers` are saved in `~/.dotz/config.json` (`orchestrator.{model,thinking}`,
`lanes.{model,thinking}`, `lanes.worker_model`). The orchestrator restarts on a new model or level (immediately when
idle, after the running turn otherwise) as a fresh session with a handover, and its next turn re-writes the prompt
cache prefix at about 2x input cost; the handover drops the old context instead of re-caching it, so no `--force` is
needed. `lanes` applies to lanes launched afterwards (free, no confirmation); `<lane>` is saved on that lane and
restarts its process on the same session.

**Force rule for running lanes.** Anthropic invalidates the message cache when the output effort changes, and omp has
`supportsPerMessageEffort=false` for anthropic, so changing a running lane's model or effort re-writes that lane's
whole context into the cache. `/model <lane> ...` and `/effort <lane> ...` on a running lane are therefore refused
with a warning that names the lane's current context tokens; repeat the command with `--force` (or `force`) to apply
it. The API (`PUT /api/models`) answers 409 `{requires_force: true, context_tokens}` until the body has
`"force": true`; the web UI shows that warning as a confirm dialog and then sends with force.

**Context and compaction.** Context tokens come from each assistant message's usage and from omp's own
`get_state` / `get_session_stats` (`contextUsage`: tokens, window, percent), per process. `/compact` sends omp's RPC
`compact`: immediately when the process is idle, otherwise the state is `queued` and it is sent right after the next
`agent_end` (omp aborts a running turn to compact, so it is never sent mid-turn). States: `queued`, `compacting`,
`done` (with time and the size before), `error`; they show in `/context`, `/status` and the web UI.
Compaction rewrites the conversation into a summary, so the prompt cache is re-written once on the next turn.

**Lane worker model.** A lane plans and reviews on its own model and delegates implementation, tests, renders and grind
work to task workers on a cheaper model: `lanes.worker_model` in `config.json` (default
`anthropic/claude-sonnet-5-5:high`; `/model workers <model> [<thinking>]` or the web UI's model page writes it). At
every lane start or resume the gateway writes `~/.dotz/lanes/<name>/omp-overlay.yml` (`modelRoles.task` plus
`task.agentModelOverrides` for `task` and `scout` set to `@task`) and starts omp with `--config=<that file>`. The
`dotz_lane` launch tool takes an optional `worker_model` that is stored on the lane and wins over `lanes.worker_model`.
The lane brief contract tells the lane to review a worker's diff itself before applying it. A running lane keeps its
process's overlay until it restarts.

**Lane context management.** Five `lanes.*` keys in `config.json` (all optional): `compact_at` (default `400000`
tokens) and `keep_recent` (default `40000`) go into each lane's `omp-overlay.yml` as `compaction.modelThresholds`
(`f<compact_at>` for the lane model and its worker model) and `compaction.keepRecentTokens`, so omp compacts a lane
itself at 400K and keeps the last 40K; `nightly_at` (default `"04:30"`, gateway-local time, `"off"` disables),
`nightly_compact_at` (default `300000` tokens) and `rotate_mb` (default `50`) drive the nightly hygiene. Once a day at
`nightly_at` every idle lane is checked: a session file over `rotate_mb` MB starts a fresh session with a handover
(recent exchanges plus a note to re-read its brief and last report; same model, folder and goal; the reload turn posts
no report), otherwise a context of `nightly_compact_at` tokens or more is compacted. Working, rate-limited and stopped
lanes are skipped. Each action goes to the hub log and the activity feed, nothing to Discord. The last run date is kept
in `~/.dotz/lane-hygiene.json`; a run missed while the gateway was down is made up a minute after the next start.
Settings apply when a lane starts or resumes.

**Memory guard.** omp runs its bash tool's coreutils (grep, cat, find, ...) and the task workers inside the agent's own
process, so one scan of a huge tree or a multi-GB file can grow an orchestrator or lane to tens of GB. Every 30 s the
gateway reads each agent's RSS; one over `lanes.max_rss_gb` (default `8`, `0` turns the guard off) is restarted on
the same session, and a lane that was working resumes with a note that names the cause. The lane channel (or alert,
for the orchestrator) gets one line. After 3 restarts of the same agent within an hour the guard leaves it running
and says so once.

**Worktree cleanup.** Two minutes after the start and then hourly, the gateway deletes task-worker isolation worktrees
that `omp worktree list --json` marks with an `orphanReason` (no live job) and that were not modified for an hour. Only
paths under `~/.omp/wt/` are touched; they are made writable first (retained worktrees hold read-only files that make
`omp worktree clear` fail). The count and freed space go to the hub log.

**Nightly token audit.** At `token_audit_at` (default `"04:30"`, `"off"` disables) the gateway scans every omp session
active in the last 24h (orchestrator, lanes, task workers) without any model call and writes
`~/.dotz/logs/token-audit-YYYYMMDD.md`: cache busts, idle wakes, error streaks, repeated tool calls, big contexts, big
workers and Fable or max/xhigh use. A class flagged on consecutive days is marked as recurring. A short alert goes out
only when something is flagged, and the reflection digest cites the result. Nothing is changed automatically. 14 days of
totals stay in `~/.dotz/token-audit.json`. Try it with `bun hub/token-audit.ts --dry [--hours N]`.

**Off-machine backup.** The nightly snapshot (a local git repo of `~/.dotz` rules, lessons, identity and settings) is
pushed to `backup.remote` when that key is set (off by default). Files that look like secrets are kept out of the commit,
and a push with secret-like content in its history is refused. A remote URL with embedded credentials is refused too.
Failures go to the hub log and to the owner at most once a day.

**omp update check.** At `omp_update.at` (default `"04:20"`) the gateway runs `omp update --check`. `omp_update.mode`
is `"check"` by default (one worklog line per new version, nothing installed). `"install"` runs `omp update` and
restarts the gateway once it is idle. `"off"` disables the check. Installs managed by another program (Tern) are
skipped. `bun hub/update.ts --check-now` prints the result.

## Feature folders (shipped and personal)

One feature = one folder `<id>/` (`<id>` is `[a-z0-9-]`, up to 40 chars) in one of two roots:

- **Shipped** (`features/` in this repo): features that come with dotz for every user. Only generic, owner-neutral
  content belongs here.
- **Personal** (`<DATA_DIR>/features/`): this owner's own rules (which machine handles mail, browser habits, …). A
  personal folder with the same `<id>` replaces the shipped one, so a user turns a shipped feature off or changes it by
  copying it into the personal root and editing the copy.

The gateway and the omp extension read both roots at runtime (cached by file mtime). A malformed folder is skipped and
the reason is written to `hub.log` (and returned as `skipped_dirs` by `GET /api/features`). `GET /api/features` marks
every feature, folder or not, as `origin: "shipped" | "personal"`, and the 기능 목록 filters by it (출처).

`feature.md` starts with a frontmatter block, then the body:

```
---
name: Short name
what: One line saying what it does
trigger: 도구 실행 직전      # one of TRIGGERS in hub/featuredirs.ts (same list as the 기능 목록 filter)
stage: guard                 # a harness node id (an unknown id is shown under "rules")
enabled: true                # optional, default true
applies_to: all              # optional: orchestrator | lanes | workers | all (default all)
deny:                        # optional, one "- <regex> | <reason>" per line
  - curl\b.*evil\.example | evil.example is off limits
---
Advisory text. It is appended to the owner rules in the orchestrator prompt (and after compaction) and to the lane
brief footer, one `### <name>` heading per feature, cut at 12,000 characters like RULES.md.
```

- **Advisory**: the body only. The model is asked to follow it. Disabled features are not injected. `applies_to`
  picks the audience (`workers`-only text reaches the lane footer with a note to pass it on in worker briefs).
- **Enforced** (the feature shows as enforced; a feature with a body and enforcement shows both parts):
  `deny` lines block bash commands exactly like the RULES.md `- deny:` lines (orchestrator, lanes, their workers; also
  `POST /api/watches` commands); `watch.json` (one entry in the shape `POST /api/watches` takes) is added through the
  same `addWatch` at gateway start and on toggle, and removed when the feature is disabled.
- `schedule.json` (one schedule) is recognised but not run yet: the schedule store has no stable id to de-duplicate on restart.
- `GET /api/features` lists each folder under the form "기능 폴더" (plus one entry per deny line);
  `POST /api/features/dir-<id>/toggle {enabled}` flips `enabled` in that `feature.md` only (atomic write, previous text
  kept as `feature.md.bak`). Deny changes apply at once, prompt text from the next session or after compaction.

## API additions

All behind the same auth as the rest of `/api`.

- `GET /api/models`, `PUT /api/models {target: "orchestrator"|"lanes"|"workers"|"lane:<name>", model?, thinking?, force?}`
- `GET /api/context`: `{note, processes: [{name, kind, status, running, model, tokens, window, percent, compaction: {state, at, tokensBefore, error}}]}`
  for the orchestrator and every lane; `POST /api/compact {target: "orchestrator"|"<lane>"}` compacts (or queues) one.
- `GET /api/activity?source=orchestrator|lane:<name>&limit=N`: in-memory ring (300) of what an omp process did; the
  same items stream on `/api/events` as `{kind: "activity", ...}` (live only, not in the inbox/outbox files).
- `GET /api/providers` -> `{providers: [{id, name, auth: "oauth"|"api_key"|"none", account?, masked?, models, in_use, can_login, can_logout}], addable: [{id, name, kind: "oauth"|"api_key"}]}`
  (`addable` = providers the runtime supports that are not configured yet); `POST /api/providers {provider, key}` saves
  an API key, `DELETE /api/providers/<id>` removes only that saved key.
- `POST /api/providers/<id>/login` -> `{ok, login_id, url, needs_code, prompt?, instructions?}`;
  `POST /api/providers/<id>/login/complete {login_id, code}` -> `{ok, provider, status: "done"|"waiting", ...}`;
  `GET /api/providers/<id>/login?login_id=` -> `{status: "waiting"|"done"|"failed", error?}`;
  `DELETE /api/providers/<id>/login` cancels; `POST /api/providers/<id>/logout` -> `{ok}`.
- `GET /api/quota`: usage per provider and window (per-model windows such as the Fable one included);
  providers with credentials but no usage report are listed under `unavailable` with a plain reason.
- `POST /api/command {text}`, `POST /api/gateway/restart`, `POST /api/orchestrator/restart|abort`, `POST /api/lanes/<name>/restart|resume|abort`; `POST /api/lanes {..., worker_model?, est?}` launches a lane. `est` is the job's expected use of the 5h window in percent (default 15; also read from an `Estimate: N%` line in the brief): the launch is refused when less than 10% of the 5h window would remain; the 7d window is shown in the message but never refuses. Fable and max/xhigh-effort models (`model`, `worker_model`) need `owner_asked_for_fable: true`.
- **구성 view** (`#harness`, nav item after 레인): the harness as a left-to-right graph (inputs -> gateway -> orchestrator -> lanes -> workers, with the prompt files and the support systems around them), built live from the running process and `~/.dotz`. Click a card for its description, live facts and editors. `GET /api/harness` -> `{nodes: [{id, kind, group, label, summary, desc, status?, facts, settings: [{key, label, value, type: "text"|"number"|"bool"|"select"|"model"|"effort", options?, editable, applies: "live"|"restart"|"next-turn", source, default?, pending?}], file?}], edges: [{from, to, label}], restart_pending}`. `PATCH /api/harness/config {path, value}` edits an allow-listed `config.json` key (type-checked; `null` restores the default): orchestrator/lane/worker model and effort go through the same code as `PUT /api/models`; the rest are written atomically (previous file kept as `config.json.bak`) and answer when they apply (`live`, `next-turn`, or after a gateway restart). Discord ids, tokens, ports and `web.allow_logins` are shown as "설정됨"/counts and refused with 400. `GET|PUT /api/harness/file/<name>` reads/writes `RULES.md`, `LESSONS.md` and `identity/IDENTITY.md` (atomic, previous text kept as `<name>.bak`, warnings for over-long files and malformed `- deny:` lines); `MODE.md` is read-only. The map only reads the omp-side `orchestrator-guard` extension's presence; it does not edit it.

The gateway keeps no credentials of its own: API keys added through it go into omp's credential store
(`omp auth import`), sign-out removes the login or key there (`omp auth-broker logout <provider>`), and keys are shown
only masked (`sk-…a1b2`), never written to `config.json`, events or logs. Every orchestrator and lane process reads
them from that store. Only API-key providers omp documents an env var for are accepted for `POST /api/providers`.

Sign-in (subscription/OAuth) runs `omp login <provider>` server-side with piped stdin: the gateway reads the authorize
URL from its output and returns it. If the browser that opens the URL runs on this machine, omp's own localhost
callback finishes the login (poll `GET .../login`). Anywhere else (a phone, say) the redirect to `localhost` fails, so
the owner pastes the authorization code or the whole redirect URL from the address bar; the gateway writes it as one
line to omp's stdin, which is exactly what the terminal prompt accepts, and waits up to 60 s for the result. Device-code
providers need no paste: `instructions` carries the code to enter and `status` flips to `done`. Providers whose sign-in
asks something first (an enterprise URL, an email) answer with `needs_code: true`, a `prompt` and possibly an empty
`url`; the answer goes through `complete` the same way, and `complete` then returns `status: "waiting"` with the next
step. The provider list comes from `omp auth-broker list`, not from this repo. One login at a time; it is killed after
10 minutes. Code, URL and process output are held in memory only and never logged or stored.

Logout runs `omp auth-broker logout <provider>` (deletes the provider's credentials from omp's store) and removes the
key saved through the gateway. Keys supplied through the gateway's own environment variables cannot be removed here.
Running orchestrator and lane processes keep their loaded token until they restart.

## Updating a running gateway

The launchd job keeps the old code until it is restarted. Restart it from the gateway (`/restart gateway` or
`POST /api/gateway/restart`): it waits until the orchestrator and every lane are idle (at most 20 min), then exits and
launchd starts the new code. `launchctl kickstart -k gui/$(id -u)/dev.dotz.gateway` restarts at once and cuts running
turns short.

Nothing is lost either way: a message counts as handled when it is answered, not when it arrives. Unanswered prompts
(including messages still being coalesced) are kept in `~/.dotz/pending.json` and delivered again on the next start;
lanes that were working resume their session and say so in their channel; owner messages sent while the gateway was
down are fetched after it reconnects (last 12 h). No owner message stays silent: if nothing is posted to the asking
channel within 60 s, a working orchestrator is told to post a progress note there, and a working lane's channel gets a
short "received, answering when the current step ends" notice from the gateway.

## Layout

- `hub/` gateway: `main.ts` (API, auth, routing, auto-reply, budget gate on lane launch), `orchestrator.ts` (headless
  session; 429 resume, crash restart, rotation past 50MB or 150K context), `lanes.ts` (brief contract, worker-model
  overlay, persistence and resume across restarts, exit/429 handling, 15-minute progress posts), `context.ts`
  (context usage and compaction state shared by orchestrator and lanes), `hygiene.ts` (nightly lane compaction and
  rotation, orphaned worktree cleanup), `schedule.ts` (reminders), `discord.ts`
  (eyes receipt, typing, 429 retry, heartbeat check, identity sync), `control.ts` (model/effort switching, context and
  compaction, slash commands), `providers.ts` (keys, login/logout, model catalog, quota), `activity.ts` (omp frames to the terminal-view feed),
  `events.ts`, `config.ts`, `i18n.ts` (message catalog and language selection), `language.ts` (language detection).
- Audit against Dori / dori-kit / 오모냥: `docs/audit-2026-10-16.md`.
- `extension/index.ts` omp extension: orchestrator tools, terminal thin client, nothing in lanes.
- `web/index.html` web app. `MODE.md` the 땃쥐 contract (`MODE.ko.md` its Korean original). `setup.ts` onboarding.
- Runtime data: `~/.dotz` (config, secrets, state, inbox/outbox, lanes, logs).
