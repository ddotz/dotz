# dotz (땃쥐모드)

An always-on, Dori-style global orchestrator. A gateway process (launchd `dev.dotz.gateway`) hosts the orchestrator
as a headless OmO session, so no terminal has to stay open. You talk to it from Discord or a tailnet-only web app.
Project work runs in lanes: one headless OmO session per project folder, each with its own Discord channel. The bot's
name is chosen in setup; 땃쥐 is the default and is used in the examples below.

**Runtime.** Every role (orchestrator, lanes and their task workers) runs on OmO (`omo`, package `omo-ai`) unless
`config.json` names another runtime (`runtime`, `orchestrator.runtime`, `lanes.runtime`). Setup writes `"omo"` for both
roles, an unknown name falls back to OmO, and the gateway's small model calls (translation, card summaries) use OmO
too. omp (oh-my-pi) and Claude Code are explicit opt-ins; what changes then is in "Runtime differences".

## Install and onboard

```bash
curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh                 # install, then the wizard
curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh -s -- --service  # also start the gateway service
```

`install.sh` (POSIX sh, macOS and Linux) installs bun when missing (bun.sh installer), installs OmO (`bun add -g --trust
omo-ai`) unless `DOTZ_HARNESS` says otherwise or another harness is already there, downloads the code to
`~/.local/share/dotz` (`DOTZ_HOME`), creates the data dir `~/.dotz` (`DOTZ_DIR`, nothing in it but what the wizard writes)
and runs the wizard on the terminal (`/dev/tty`, so it works under `curl | sh`). Source: the GitHub tarball of
`DOTZ_REPO` (default `ddotz/dotz`) at `DOTZ_REF` (default `main`); while the repo is private it uses `GITHUB_TOKEN` /
`GH_TOKEN` or an existing `gh` login; `DOTZ_TARBALL` (https URL, `file://` or a path) replaces GitHub. Running it again
is the upgrade: the code is replaced, the data dir kept, the wizard skipped (`--setup` runs it) and the gateway
restarted when its service runs this copy. `--uninstall` removes the code and the service (only a service file that runs
this copy; a gateway from another checkout is never touched), `--purge` the data dir too. Other options:
`--answers FILE`, `--tailscale`, `--no-open`, `--no-service`, `--no-setup`, `--yes`. From a checkout:
`bun setup.ts --load --tailscale --open` (interactive; or `--answers answers.json`).

The tools step installs (after asking) and signs in Aside (app, CLI and CLI login), Tailscale and zele (mail and
calendar; `bun add -g zele`, accounts through zele's own login). Tailscale on macOS comes from Homebrew
(`tailscale-app`), and the app's bundled CLI (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) is used when
`tailscale` is not on PATH. A missing tool is skipped with a note; Aside is not asked on Linux.

The wizard's first step is the harness: it lists OmO, omp, Claude Code and Codex with their install state, takes OmO
by default (Codex is listed but has no adapter yet), installs OmO with bun when it is the pick and missing, and checks
the login without reading credentials (`omo auth check --json`: an account pool with at least one account counts as
signed in; `claude auth status`). Sign-in itself happens in the harness (`omo`, then `/login`; another `/login` adds an
account to the pool). The pick is written to `orchestrator.runtime` and `lanes.runtime`; `--answers` takes `runtime`
(`omo` | `omp` | `claude`) and `install_harness: true`. Tailscale is optional: without it the web app stays off and
Discord works. On Linux setup writes a systemd user unit (`~/.config/systemd/user/dotz-gateway.service`)
instead of the launchd plist and skips the Aside and macOS-permission steps.

The wizard (Korean) then asks for the bot's name, character and tone (presets or your own line; Enter takes the default,
a short casual-polite tone), the notice style, what the bot calls you (optional; empty = no
title at all) and an optional avatar, then Discord and web access. The identity
lands in `~/.dotz/identity/IDENTITY.md` and drives everything: how the bot talks, its Discord username/avatar, the
category names (`<name>`, `<name> 작업`), and the terminal phrase
"<name>모드 켜" (omp only). Re-run setup any time to change it; existing answers are the defaults.

Setup writes `~/.dotz/config.json` (no secrets, `runtime: "omo"` for the orchestrator and lanes), keeps the bot token in
`~/.dotz/secrets/` (0600), generates and (with `--load`) starts the gateway service, and runs `tailscale serve` for
the web app on the tailnet only: an interactive run with web logins does it itself, an `--answers` run only with
`--tailscale`. The gateway re-checks on every start: with web logins set and no proxy on `web.tailscale_https_port`, it
runs the same `tailscale serve` (a port another service already serves is left alone and logged). OmO sessions get the dotz extension from the gateway (`--extension`); nothing is installed into OmO's
agent directory. Only when omp is installed is the extension also linked into omp (`~/.omp/agent/extensions/dotz`) for
terminal mode. Setup prints the bot invite link, then the web address as the last block (`웹 앱 주소: https://...`,
plus a line on opening it from another device). With `--load` it first waits until the gateway (40 s) and the
tailnet serve (15 s) answer; `--open` opens the browser only once both did.

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
macOS attributes every protected access by the gateway and everything it spawns (agent sessions, osascript, aside,
git) to `bun`:
the prompts and the Settings entries are for the bun binary, not your terminal. Setup asks for them once, up front:
Full Disk Access (no prompt, you switch it on in Settings; it also covers Desktop/Documents/Downloads and removable and
network volumes), Files and Folders for Desktop, Documents and Downloads (prompts), Automation for System Events (prompt),
and Accessibility (Settings). The probes run as a short launchd job (`dev.dotz.permprobe`) so the answers are for bun
too. `bun setup.ts permissions` runs the same step any time and is safe to rerun (granted items are skipped);
`bun setup.ts permissions --check` only prints the state and never raises a dialog. New grants apply to the running
gateway after `launchctl kickstart -k gui/$(id -u)/dev.dotz.gateway`.

Discord: create a dedicated bot in the Developer Portal, enable the MESSAGE CONTENT intent, give its token to setup,
and invite it with the printed link. The gateway creates two categories named after the bot, e.g. "땃쥐" (the main
channels 대화, 알림, 작업로그) and "땃쥐 작업" (one channel per project, topic or lane, named plainly with no emoji). Every text channel in these two categories
is a work channel; threads in them are sub-items. It listens to nothing else, and only the configured owner id can
command it.

## Use

- Discord: write in 대화 (or DM the bot) for anything; it routes each part to the project channel it belongs to and
  splits long-running work into a new channel. Write in a project channel or a thread to work on just that; write in a
  lane channel to talk to that lane directly.
- Web: `https://<this-machine>.<tailnet>.ts.net:<tailscale_https_port>` (allowed Tailscale logins only).
- Terminal (omp only): the terminal client is part of the dotz extension, which is installed only into omp. In an
  omp session say "<name>모드 켜" and your input goes to the orchestrator, replies appear there; "<name>모드 꺼" ends
  it. Interactive OmO sessions don't load the extension, so there is no terminal mode on OmO.

## Commands

Owner messages that start with `/` (web chat box) or `/`/`!` (any bot channel in Discord) followed by a known command
name are answered by the gateway itself and never reach the orchestrator; unknown names in Discord fall through to it.
`POST /api/command {"text": "/status"}` runs the same parser.

| Command | Effect |
| --- | --- |
| `/help`, `/status`, `/lanes` | commands, orchestrator/lane/Discord state (with context usage and compaction state), lane list |
| `/context` | per session (orchestrator and every lane): context tokens, context window, percent, compaction state |
| `/compact <orchestrator\|<lane>>` | compact that process's context; queued after the current turn if it is working |
| `/model [orchestrator\|lanes\|workers\|<lane>] [<model>] [<thinking>] [--force]` | show or set model and thinking level; a model may be a unique part of its name; `workers` sets `models.workers` |
| `/effort <target> <level> [--force]` | thinking level: off, minimal, low, medium, high, xhigh, max, auto |
| `/restart gateway\|orchestrator\|<lane>`, `/stop <lane>`, `/resume <lane> [text]`, `/abort [orchestrator\|<lane>]` | process control (restart and resume keep the session; `gateway` waits until the orchestrator and lanes are idle, at most 20 min) |
| `/providers`, `/quota` | logins and keys (masked) plus providers you can add, usage limits per provider and model window |
| `/login [<provider>]`, `/login <provider> <code or redirect URL>`, `/login cancel`, `/logout <provider>` | sign in (prints a link; the second form finishes a login opened on another device), cancel a pending login, sign out |

Model changes: `orchestrator`, `lanes` and `workers` are saved in `~/.dotz/config.json` under one block,
`models.<target>.{model,thinking,fallback}` (an older file's `orchestrator.{model,thinking,fallback}`,
`lanes.{model,thinking,fallback,worker_model,worker_fallback}` are moved there on the next start, the old file kept as
`config.json.bak-models-<time>`). The web UI edits a target's model, effort and fallback order on one screen (설정 →
모델 · 폴백; the composer's model chip links to it), and `PUT /api/models {target, model?, thinking?, fallback?}` takes
the same three. The orchestrator restarts on a new model or level (immediately when
idle, after the running turn otherwise) as a fresh session with a handover, and its next turn re-writes the prompt
cache prefix at about 2x input cost; the handover drops the old context instead of re-caching it, so no `--force` is
needed. `lanes` applies to lanes launched afterwards (free, no confirmation); `<lane>` is saved on that lane and
restarts its process on the same session.

**Force rule for running lanes.** Anthropic invalidates the message cache when the output effort changes, so changing a running lane's model or effort re-writes that lane's
whole context into the cache. `/model <lane> ...` and `/effort <lane> ...` on a running lane are therefore refused
with a warning that names the lane's current context tokens; repeat the command with `--force` (or `force`) to apply
it. The API (`PUT /api/models`) answers 409 `{requires_force: true, context_tokens}` until the body has
`"force": true`; the web UI shows that warning as a confirm dialog and then sends with force.

**Context and compaction.** Context tokens come from each assistant message's usage and from the session's
RPC `get_state` / `get_session_stats` (`contextUsage`: tokens, window, percent; OmO and omp speak the same pi RPC).
`/compact` sends the RPC `compact`: immediately when the session is idle, otherwise the state is `queued` and it is
sent right after the next `agent_end` (a compact aborts a running turn, so it is never sent mid-turn). States: `queued`, `compacting`,
`done` (with time and the size before), `error`; they show in `/context`, `/status` and the web UI.
Compaction rewrites the conversation into a summary, so the prompt cache is re-written once on the next turn.

**Lane worker model.** A lane plans and reviews on its own model and delegates implementation, tests, renders and grind
work to task workers on a cheaper model: `models.workers` in `config.json` (default
`anthropic/claude-sonnet-5-5:high`; `/model workers <model> [<thinking>]` or the web UI's model page writes it). How
the lane session gets it depends on the runtime (OmO: an `omo.json` profile; omp: a config overlay), see "Runtime
differences". The `dotz_lane` launch tool takes an optional `worker_model` that is stored on the lane and wins over `models.workers`.
The lane brief contract tells the lane to review a worker's diff itself before applying it. A running lane keeps its
worker model until it restarts.

**Model fallback chains.** When a model fails at request time (usage limit, outage), the next model of a chain takes
over. Three chains, each a list in `config.json`: `models.orchestrator.fallback`, `models.lanes.fallback` (every lane's own
model) and `models.workers.fallback` (the lanes' task workers); an entry is a model selector (`provider/id[:thinking]`, the
thinking level of the failing turn when omitted). They apply the next time a session starts and are edited on the web
UI's 모델 · 폴백 screen (under each target's model and effort: drag an item or use its arrow buttons to reorder, "모델
추가" picks from the model catalog the target's harness can run, the model answering now is marked "사용 중") or with
`PUT /api/models {target, fallback}` (`PUT /api/fallbacks {target, chain}` still works). On OmO the gateway drives
every chain itself; on omp a chain of bare models is left to omp (see "Runtime differences"). Every switch writes one line (`모델 폴백: A → B (사유)`): the orchestrator's goes
to the alert channel (a silent switch to a weaker model went unnoticed once), its task workers' to worklog, a lane's and
its workers' to the lane's channel; none of them wakes the orchestrator, and
while a fallback may follow, a failed request is not acted on for 3 seconds (so a usage limit the runtime falls back
from does not pause the session or send a lane-error report). For a chain walked by the runtime (omp), which never
walks back by itself (an Anthropic refusal also walks the chain), the gateway sends an RPC `set_model` for the configured model (with its thinking level) and posts
`원래 모델(…)로 되돌렸어요`: before the next prompt after a refusal or a provider error, after the reset for a usage limit
(the error's retry-after or the usage report, else 15 minutes) when idle or before the next prompt. At most once per
fallback: if the restored model falls back again in that same turn it stays on the fallback. A runtime without
`setModel` stays on the fallback until restarted, and the alert says so. A chain the gateway drives itself is untouched.

An entry of the orchestrator or lane chain can be an object with conditions, which the gateway switches itself (restart on
the same session, as a model switch does; the task workers' chain stays bare models): `when` (`"quota"` = only after the
previous entry hit a usage limit, `"error"` = after a provider error, default any), `cap` (`{period: "month"|"day",
usd?, tokens?}`: stop using the entry once the spend it caused in the KST month/day reaches it, then the next entry; none
left: the process pauses with an alert until the period ends), `revert` (go back to an earlier entry when its limit
resets, at the next idle moment) and `key_file` (the same model billed through an API key stored in the file
`<data dir>/secrets/<key_file>`; the key reaches the process only through its environment, never a config, log, event
or report). Spend (tokens, USD from the model catalog's prices) is counted per key/model in `<data dir>/fallback-usage.json`.
An API-key entry runs as its own provider `<provider>-apikey`, registered inside the session by the dotz extension
(the runtime prefers a stored login over an API key for the provider's own id); `anthropic`, `openai` and `openrouter` are
built in, other providers need `base_url` and `api` on the entry. The key goes over https only, to `api.anthropic.com`,
`api.openai.com`, `openrouter.ai` or a host listed in the top-level `key_hosts` array of `config.json`; an entry pointing
anywhere else is refused when saved and never started. The key file's name must contain `api-key` or `api_key`.

**Lane context management.** Five `lanes.*` keys in `config.json` (all optional): `compact_at` (default `400000`
tokens; the hub compacts an idle OmO lane at that value, on omp it goes into the lane's overlay) and `keep_recent`
(default `40000`, omp only); `nightly_at` (default `"04:30"`, gateway-local time, `"off"` disables),
`nightly_compact_at` (default `300000` tokens) and `rotate_mb` (default `50`) drive the nightly hygiene. Once a day at
`nightly_at` every idle lane is checked: a session file over `rotate_mb` MB starts a fresh session with a handover
(recent exchanges plus a note to re-read its brief and last report; same model, folder and goal; the reload turn posts
no report), otherwise a context of `nightly_compact_at` tokens or more is compacted. Working, rate-limited and stopped
lanes are skipped. Each action goes to the hub log and the activity feed, nothing to Discord. The last run date is kept
in `~/.dotz/lane-hygiene.json`; a run missed while the gateway was down is made up a minute after the next start.
Settings apply when a lane starts or resumes.

**Memory guard.** One scan of a huge tree or a multi-GB file can grow an orchestrator or lane session to tens of GB.
Every 30 s the
gateway reads each agent's RSS; one over `lanes.max_rss_gb` (default `8`, `0` turns the guard off) is restarted on
the same session, and a lane that was working resumes with a note that names the cause. The lane channel (or alert,
for the orchestrator) gets one line. After 3 restarts of the same agent within an hour the guard leaves it running
and says so once.

**Worktree cleanup (omp only).** Two minutes after the start and then hourly, the gateway deletes task-worker isolation worktrees
that `omp worktree list --json` marks with an `orphanReason` (no live job) and that were not modified for an hour. Only
paths under `~/.omp/wt/` are touched; they are made writable first (retained worktrees hold read-only files that make
`omp worktree clear` fail). The count and freed space go to the hub log.

**Nightly token audit.** At `token_audit_at` (default `"04:30"`, `"off"` disables) the gateway scans every OmO and omp session
active in the last 24h (orchestrator, lanes, task workers) without any model call and writes
`~/.dotz/logs/token-audit-YYYYMMDD.md`: cache busts, idle wakes, error streaks, repeated tool calls, big contexts, big
workers and Fable or max/xhigh use. A class flagged on consecutive days is marked as recurring. A short alert goes out
only when something is flagged, and the reflection digest cites the result. Nothing is changed automatically. 14 days of
totals stay in `~/.dotz/token-audit.json`. Try it with `bun hub/token-audit.ts --dry [--hours N]`.

**Worker guard and harness commands** (`extension/guard.ts`, `extension/harness-tools.ts`, `extension/token-audit.ts`) load with
the dotz extension into every session it is in: the orchestrator, lanes and their workers (and omp terminals). `guard.enabled: false` turns the guard off.
- *Briefs* (`task` calls of the main agent): blocked without a done-condition line (`Acceptance:`, `Done when:`, ...), over
  `max_brief_chars` (8000) characters, or with a fenced code block over `max_fence_lines` (40) lines; every brief gets a
  budget line (answer length, context budget); writing workers are forced `isolated` in a git repo and checkout paths in the
  brief become cwd-relative. Worker output over `max_output_chars` (2000) is trimmed in the orchestrator's context
  (`history://<id>` keeps the full text).
- *Review before apply*: `git apply <x>.patch` is blocked until the patch was read in the session. A message to a finished
  worker is blocked (spawn a new one).
- *Workers*: external-impact commands (`git push`, `gh` writes, publish, deploy, `ssh`/`scp`/`rsync`, outbound HTTP writes,
  plus your `external_commands`) are blocked and handed back; the first compaction steers a worker to wrap up and the second
  disables its tools; the 1h cache TTL is dropped (5-minute cache).
- *Loops*: the same tool call (or a 2-4 call cycle) repeated with unchanging results is blocked; after more ignored blocks a
  human is asked, a headless session is told to stop. `repeat_block_threshold` (8) sets how many calls it takes.
- *Searches*: recursive grep/find/rg/du/ls -R of `/`, `~`, `~/Library` or with an unquoted shell expansion is blocked.
- *Budget gate*: a `task` call is blocked when the Anthropic 5h window would drop under `budget_margin_percent` (10) after the
  job's estimate (`budget_default_estimate_percent` 15, or an `Estimate: N%` line in the brief) until `/budget-ok`
  (`override_minutes`, 30). The 7d window is only shown. The usage data comes from `omp usage`, so without omp
there is no gate. `budget_gate: false` turns it off.
- *State*: spawned workers, results and unapplied patches are kept per project (and lane) under
  `<agent dir>/orchestrator-state` (`~/.omo/agent` on OmO; `ORCH_GUARD_STATE_DIR` overrides) and re-injected after a compaction or a new session.
- `/compact-switch provider/model[:thinking]` compacts on the current model (cache still warm, only above
  `switch_compact_min_tokens`, 50000) before switching. `/doctor [fix]` (and the `harness_doctor` tool) checks context,
  session file size, model vs default role, last rate limit, quota, open workers/patches, guard health and orphaned omp RPC
  hosts; `/handover [note]` starts a fresh session with recent reports, git status and open workers;
  `/token-audit [hours]` (and `harness_token_audit`) is the on-demand form of the nightly audit and writes
  `~/.dotz/logs/token-audit-session-YYYYMMDD.md`. `guard.harness_tools: false` leaves these out.
- *Owner rule, off by default*: `ask_before_expensive: true` with `expensive_models: ["fable", ":max", ":xhigh"]` (substring
  of a model selector; `:level` for a thinking level) blocks `task` workers on those models and flags a main session on one
  until `/fable-ok` or `DOTZ_OWNER_ASKED_FABLE=1` (set by the gateway for `owner_asked_for_fable` lanes); `/doctor` and the
  audit report them too.
- Config: the `guard` object in `config.json`, every key optional (`enabled`, `max_brief_chars`, `max_fence_lines`,
  `max_output_chars`, `worker_answer_chars` 800, `worker_context_tokens` 400000, `budget_gate`, `budget_margin_percent`,
  `budget_default_estimate_percent`, `override_minutes`, `repeat_block_threshold`, `switch_compact_min_tokens`,
  `external_commands` (regex strings), `ask_before_expensive`, `expensive_models`, `defer_to_installed`, `harness_tools`).
- *Already installed copies*: the runtime lists no loaded extensions to an extension, so the guard looks for
  `<agent dir>/extensions/orchestrator-guard.ts` (and `harness-tools.ts` for the commands), unless discovery is
  switched off or the config disables it. When it exists, this copy leaves those hooks to it (the same hooks
  twice would double every block, steer and state write) and logs one warning per process; `/doctor` reports which copy
  is in effect. `guard.defer_to_installed: false` runs this copy anyway.

**Off-machine backup.** The nightly snapshot (a local git repo of `~/.dotz` rules, lessons, identity and settings) is
pushed to `backup.remote` when that key is set (off by default). Files that look like secrets are kept out of the commit,
and a push with secret-like content in its history is refused. A remote URL with embedded credentials is refused too.
Failures go to the hub log and to the owner at most once a day.

**omp update check (omp only).** At `omp_update.at` (default `"04:20"`) the gateway runs `omp update --check`. `omp_update.mode`
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

The gateway and the dotz extension read both roots at runtime (cached by file mtime). A malformed folder is skipped and
the reason is written to `hub.log` (and returned as `skipped_dirs` by `GET /api/features`). `GET /api/features` marks
every feature, folder or not, as `origin: "shipped" | "personal"`. The web UI shows that distinction (배포용/개인용 tags,
the 출처 filter in the 기능 목록) only with `ui.origin_view` (see below).

Each feature also carries a `summary`: its text as two short lines in the identity's main language (the cards show it, with the original in the tooltip). Summaries are cached in `<DATA_DIR>/cache/card-summaries.json` (keyed by language and text, entries no longer used are dropped on rewrite) and filled in the background by `hub/summaries.ts`, one small tiny-model call per batch of ~40 new or changed texts; texts already short and in the language cost no call, and on a failed call the original is shown and the fill retries with backoff.

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
  same `addWatch` at gateway start, and removed when the feature is disabled (at the next start if the folder is flipped later).
- `schedule.json` (one schedule) is recognised but not run yet: the schedule store has no stable id to de-duplicate on restart.
- `GET /api/features` lists each folder under the form "기능 폴더" (plus one entry per deny line). The 구성 tab turns a
  switch into a request to the main orchestrator, which flips `enabled` in that `feature.md`. Deny changes apply at once,
  prompt text from the next session or after compaction.

## API additions

All behind the same auth as the rest of `/api`.

- `GET /api/models`, `PUT /api/models {target: "orchestrator"|"lanes"|"workers"|"lane:<name>", model?, thinking?, force?}`; `GET /api/models` also carries `fallbacks: {max, orchestrator|lanes|workers: {chain: [entry + used?/down?], hub_driven, active: [model ids answering now]}}`; `PUT /api/fallbacks {target: "orchestrator"|"lanes"|"workers", chain: [model | {model, when?, cap?, revert?, key_file?}]}` replaces one chain (validated against the model catalog; applies at the next process start)
- Agent runtime selection (설정 > 실행 하네스): `GET /api/runtimes` -> `{current: {orchestrator, lanes}, checklist, runtimes: [{id, label, installed, version?, path?, hasAdapter, usable, reason?, roles, report: {at, version, verdict, counts}|null, state, switchable, refusal}]}`
  for `omo`, `omp`, `claude`, `codex` (`?refresh=1` re-detects); `GET /api/runtimes/<id>` -> `{report, state}` (full last report
  and the running check's progress); `POST /api/runtimes/<id>/verify {real: true}` starts the compatibility check in the background (each run starts ~14 paid
  sessions, so without `real: true` it answers 400 with the last report; probe processes outside a check need `DOTZ_E2E=1`; 202, poll the
  GET; progress also streams as `{kind: "runtime_check"}` on `/api/events`); `POST /api/runtimes/<id>/use {roles?: ["orchestrator","lanes"]}`
  writes `orchestrator.runtime` / `lanes.runtime` to `config.json` and answers 409 with `{error}` when the runtime is not installed or has no
  dotz adapter, has no report, its verdict is `blocked`, or the report was made for another version. `omo` (the default) is
  never refused while it is installed, and `omp` (the original baseline, opt-in) needs no report. Nothing is restarted: the change applies when the orchestrator / lane process next starts.
  The check (`hub/runtime/verify.ts`) runs the adapter's probes for 14 items (core: `turn`, `model_effort`, `resume`, `usage_report`,
  `deny_lines`); a failing core item blocks the switch, a failing non-core item is `adapted` (the hub substitutes, e.g. handover from the
  saved session, own compaction timing, hub-side deny re-check, own model fallback) or `disabled` (dotz tools, worker spawn, isolated
  patches, tool intent are turned off for that runtime). The last report per runtime is `<data>/runtime-checks/<id>.json`, the probe
  log `<id>.log`. The hub drives every fallback chain on OmO (see below); on omp it drives a chain with conditions, caps, revert or
  API-key entries and leaves a chain of bare models to omp; on Claude Code the models go as a plain `--fallback-model` list.

**Runtime differences.** OmO is the default; the first bullets say how dotz runs on it, the last ones what changes
when omp is selected.
- *Fallback chain*: OmO runs with `--no-model-fallback` (its own chain would follow the owner's global OmO settings, and the
  per-process RPC override is refused on a resumed session). The hub drives every OmO chain itself: on a usage limit or
  provider error it restarts the process on the same session with the next entry (bare entries go back to the primary once
  it is usable again), logs `모델 폴백: … → …` and, for the orchestrator, alerts the owner. API-key entries start on the entry's
  base model and switch to the key provider the dotz extension registers (`pi.registerProvider`; not yet
  exercised live on OmO). Probe: `fallback_chain`.
- *API keys while 미설's account is pinned* (hub/apikey-policy.ts): while OmO's subscription pin names `miseol-shared`,
  no API-key entry runs and key variables are stripped from spawns. The owner's temporary lift is
  `~/.dotz/api-allow-while-pinned` holding an expiry in epoch seconds: before it keys are allowed under the pin, at it the
  ban is back by itself. Remove the lift early with `rm ~/.dotz/api-allow-while-pinned` (read on every check, no restart).
- *Worker patch review*: the guard runs on OmO task calls (`prompt` / `tasks[].prompt`): the brief rules apply, a writing worker
  in a git repo is made `isolated: true, apply: false, merge: "patch"` (read-only agents such as explore/librarian run in
  place), the completion's `isolation: retained via … -> <root.patch>` line is kept as `<id>.patch`, and `git apply` of a patch
  (in an OmO `eval` cell or bash) is refused until the patch was read. A repo OmO reports `isolation_unavailable` for (e.g. over
  its snapshot budget) gets in-place workers. Probe: `workers_isolated_patch`.
- *Lane worker model*: OmO task workers take their model from OmO's categories (`omo.json`), so each lane spawn writes
  `profiles.dotz-workers-<model>` into `~/.omo/omo.json` (every category on the lane's worker model, then
  `models.workers.fallback`) and starts the lane with `OMO_PROFILE` naming it; the owner's own OmO sessions, which set no
  profile, keep their categories. With an `omo.jsonc` dotz writes nothing and the workers keep OmO's categories.
- *Memory*: OmO's memory is turned off for dotz sessions; durable facts go to RULES.md / LESSONS.md / state.json (MODE.md).
- *Needs the `omp` binary on any runtime*: the budget gate on spawns and the Anthropic quota numbers (`omp usage`), the
  provider list, API keys, login and logout (`omp auth`, `omp login`, `omp auth-broker`; below), the nightly
  `omp worktree` cleanup, the orphaned omp RPC host reaper and the omp update check. Without omp installed they see
  nothing (the budget gate does not gate). On OmO the Anthropic account a role runs on is read from OmO's account pool.
- *When the runtime is omp*: the dotz extension is linked into `~/.omp/agent/extensions/dotz`, so omp terminals get
  terminal mode, the worker guard and harness commands. Each lane start or resume writes
  `~/.dotz/lanes/<name>/omp-overlay.yml` and starts omp with `--config=<that file>` (the orchestrator gets
  `omp-orchestrator-overlay.yml`): `modelRoles.task` plus `task.agentModelOverrides` for `task` and `scout` set to
  `@task` (worker model); `retry.fallbackChains` for a chain of bare models, keyed by the exact primary model and by role
  `task` for workers (omp walks it itself; the hub drives chains with conditions, caps, revert or API keys);
  `compaction.modelThresholds` (`f<compact_at>`) and `compaction.keepRecentTokens` (`keep_recent`), so omp compacts a
  lane itself. omp has `supportsPerMessageEffort=false` for anthropic, which is behind the force rule.
- `GET /api/context`: `{note, processes: [{name, kind, status, running, model, tokens, window, percent, compaction: {state, at, tokensBefore, error}}]}`
  for the orchestrator and every lane; `POST /api/compact {target: "orchestrator"|"<lane>"}` compacts (or queues) one.
- `GET /api/activity?source=orchestrator|lane:<name>&limit=N`: in-memory ring (300) of what an agent session did; the
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
- **구성 view** (`#harness`, nav item after 레인): the harness as a map of the main line (inputs -> gateway -> orchestrator -> lanes -> workers): one big card per stage with one short label on each arrow, the inputs listed as rows on one card, and the support systems and prompt files of a stage as small status chips on its card ("함께 도는 것"; warn/err chips are tinted and counted on the card). Hovering or focusing a chip or card lights up and draws its connections; a click opens its description, live facts and editors. "자세히" (remembered in `localStorage`) switches to the full graph with every node and edge; on a phone the same stages are a vertical list. Built live from the running process and `~/.dotz`. The view writes nothing: every change (a setting, a RULES/LESSONS/IDENTITY edit, a 기능 목록 switch) is sent to the main orchestrator through `POST /api/message` as a "[구성 탭 수정 요청]" text (a setting: label, config path, current -> new, when it applies; a file: path, a compact line diff of the draft or only the changed line ranges when it is over 6000 characters, plus an optional note; a switch: `<name> 끄기/켜기 (<source>)`), and the orchestrator applies it. `GET /api/harness` -> `{nodes: [{id, kind, group, label, summary, desc, status?, facts, settings: [{key, label, value, type: "text"|"number"|"bool"|"select"|"model"|"effort", options?, editable, applies: "live"|"restart"|"next-turn", source, default?, pending?}], file?}], edges: [{from, to, label}]}` (`pending`: the stored value differs from what this process started with, so it applies after a gateway restart). `GET /api/harness/file/<name>` reads `RULES.md`, `LESSONS.md`, `identity/IDENTITY.md` and `MODE.md` (`{name, label, path, text, exists, editable, bytes, modified, applies, note, cap}`). Discord ids, tokens, ports and `web.allow_logins` are shown as "설정됨"/counts and are never editable from the tab. The map only reads the omp-side `orchestrator-guard` extension's presence; it does not edit it.

**`ui.origin_view`** (`config.json`, default `false`, read at start): a developer-facing switch for the 구성 view. Off,
the view and its requests are exactly as described above and the shipped product shows no shipped/personal distinction.
On, `GET /api/harness` adds `origin_view: true`, `data_dir`, and per node `origin: "shipped" | "personal"` (RULES,
LESSONS, IDENTITY and the omp worker-guard extension are personal; MODE and the gateway's own systems are shipped),
`custom: [{key, label, value, default, unit?}]` (editable settings whose value differs from their default; only settings
that have a default) and, for a personal prompt file, `fileMeta: {bytes, modified}`. The web UI then marks every card,
chip and row that holds something of this user's with a small "내 설정" badge (stage cards add counts such as "바꾼 값 2 ·
내 기능 1"; personal features per stage come from `GET /api/features` `stage` + `origin`), shows a one-line legend in the
bar, adds a segmented 전체 | 커스텀만 (remembered in `localStorage`) next to 기능 보기 / 자세히 (커스텀만 lists, per stage, the
personal files and extensions, the changed settings as "label: value (기본 default)" and the personal features; on a phone
it is a list), shows the node's side and the default beside changed values in the sheet, shows the 배포용/개인용 tags and
출처 filter in the 기능 목록, and gives shipped feature folders a switch. Every request then carries a scope line right
after "[구성 탭 수정 요청]": `범위: 개인 (<~/.dotz path or config.json:key>)` or `범위: 배포 (<repo path>)`, and the same
tag sits next to each request button. config.json settings and RULES/LESSONS/IDENTITY are 개인; turning a shipped
feature folder off or on defaults to a personal override (`~/.dotz/features/<id>/` with the same id) and offers
"배포 파일 변경 요청" (`features/<id>/feature.md` in the repo, `범위: 배포`) as an explicit second choice.

**프로젝트 band** (always on, not behind `ui.origin_view`): below the main map the 구성 view lists every lane that is tied to a
work channel or a home channel as one card per project, side by side (a horizontal scroll row; on a phone the cards stack
vertically). `GET /api/harness` carries them as `projects: [...]`, one per such lane (`channels.json` `lanes`/`homes`; a lane
with neither is not a project). Each entry has `id` (the lane name), `name`, `status`, `channels: [{id, name, kind:
work|home|thread}]`, `cwd` (+ `repo`/`branch` for a worktree lane), `fields` = `{model, effort, worker_model, worker_effort,
runtime, fallback, worker_fallback}` where every field is `{value, source: "global"|"project", global?}` (`global` only
when the project differs; fallback values are `[{model, when?, cap?, revert?}]` read from `models.lanes.fallback` /
`models.workers.fallback`; `runtime` is the global `lanes.runtime`/`runtime`/omp unless the lane state carries `runtime`),
`overrides` (how many fields differ), `files` (instruction files found in the lane folder: `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, `.cursorrules`, `CONVENTIONS.md`, `.github/copilot-instructions.md` and the entries of `.omp/`: name, size,
mtime, first heading only, never content), `setup` (the channel's purpose, login names and health, monitors, standing
behaviour; no `basis`, no secrets), `features` (skills under the folder's `.omp/skills`, `.claude/skills`,
`.agents/skills` and watches tied to the project's channels or folder), `deny` (the `- deny:` lines of the instruction
files' `## Blocked commands` section) and `map` (the project's own nodes and edges). A differing value is drawn like the 내 설정
marker (`--mine` badge "바뀜", global value struck through, → project value); an equal one is muted with "전역 기본".
Clicking a card opens the project's own map (its channels -> gateway -> orchestrator -> that lane -> its workers, the
instruction files and project-only features as chips on the lane card), with a back button; the URL hash
`#harness/project/<id>` restores it on reload. Lane model, effort, worker model/effort and runtime are editable through
requests as on the main map. In the project view every request carries `범위: 프로젝트 (<channel name> · <cwd>)` and the
tag sits next to each request button, whether or not `ui.origin_view` is on.

Provider management calls the `omp` binary (see "Runtime differences"). The gateway keeps no credentials of its own:
API keys added through it go into omp's credential store
(`omp auth import`), sign-out removes the login or key there (`omp auth-broker logout <provider>`), and keys are shown
only masked (`sk-…a1b2`), never written to `config.json`, events or logs. omp sessions read them from that store. Only API-key providers omp documents an env var for are accepted for `POST /api/providers`.

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
Running sessions keep their loaded token until they restart.

Throwaway sessions stay off the live gateway (`hub/live-guard.ts`): a gateway on a temp data dir (or `DOTZ_DRY_RUN=1`) does not
connect to Discord, and an orchestrator or lane process the live gateway did not start (its parent is not `hub.pid`), a runtime
probe, or a `DOTZ_DRY_RUN=1` session writes its gateway calls to `$TMPDIR/dotz-dry-run.jsonl` instead of sending them and may not
write into the live data dir. `DOTZ_ALLOW_LIVE=1` lets a deliberate end-to-end run through. The Claude account the orchestrator
and lanes run on is kept by `hub/account-sticky.ts` (switches and their reasons: `account-switches.jsonl`, usage screen).

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
  session; 429 resume, crash restart, rotation past 50MB or 150K context), `lanes.ts` (brief contract, worktrees,
  persistence and resume across restarts, exit/429 handling, 15-minute progress posts), `context.ts`
  (context usage and compaction state shared by orchestrator and lanes), `hygiene.ts` (nightly lane compaction and
  rotation, orphaned worktree cleanup), `schedule.ts` (reminders), `discord.ts`
  (eyes receipt, typing, 429 retry, heartbeat check, identity sync), `control.ts` (model/effort switching, context and
  compaction, slash commands), `providers.ts` (keys, login/logout, model catalog, quota), `activity.ts` (runtime activity
  rows and task-worker lists to the terminal-view feed),
  `events.ts`, `config.ts`, `i18n.ts` (message catalog and language selection), `language.ts` (language detection), `summaries.ts` (cached two-line card summaries).
- `hub/runtime/` agent runtimes: `types.ts` (the adapter interface: `AgentProcess`, `AgentEvent`, `SpawnOpts`),
  `omo.ts` (the OmO adapter: spawn arguments, provider names, compaction frames, worker profile), `omp.ts` (the omp
  adapter, whose RPC reader `omo.ts` reuses: lane config overlay, RPC frames to events, handover text from a saved
  session), `claude.ts`, `index.ts` (registry; `orchestrator.runtime` / `lanes.runtime` / `runtime` in `config.json` pick one,
  default `omo`, an unknown name is logged and falls back to OmO). The orchestrator and lanes hold the policy and only
  see events. `verify.ts` detects the installed harnesses and runs the compatibility check before a switch (see API additions). `bun test` replays recorded omp frames and two state-machine scenarios against goldens captured before the
  adapter existed (`hub/runtime/fixtures`).
- Audit against Dori / dori-kit / 오모냥: `docs/audit-2026-10-16.md`.
- `extension/index.ts` dotz extension (loaded by OmO and omp sessions): orchestrator tools, terminal thin client (omp), the worker guard and harness commands (`guard.ts`, `guard-config.ts`, `harness-tools.ts`, `token-audit.ts`).
- `web/index.html` web app. `MODE.md` the behaviour contract (`MODE.ko.md` the same in Korean). `hub/threads.ts` the Discord thread rules (table in MODE "Threads"). `setup.ts` onboarding.
- Runtime data: `~/.dotz` (config, secrets, state, inbox/outbox, lanes, logs).

### Generic vs. per-install settings

The repo holds only generic defaults; everything about one owner lives in `~/.dotz`. Later wins:

| what | generic default (repo) | per install (`~/.dotz`) |
|---|---|---|
| behaviour contract | `MODE.md` / `MODE.<lang>.md` | `MODE.<lang>.md` or `MODE.md` (replaces the repo file) |
| identity, language, tone, how the owner is addressed, timezone | none (machine zone, no title) | `config.json` `identity` {name, language, tone, address, timezone, notices}, `identity/IDENTITY.md` |
| models | `hub/config.ts` DEFAULT | `config.json` orchestrator / lanes |
| channels | names from the identity's language (`hub/i18n.ts` channelNames) | `discord-channels.json` (ids, work channels, threads) |
| boundaries, owner facts | empty templates | `memory/boundaries.md` (verbatim don'ts), `memory/owner.md` |
| standing rules, blocked commands | none | `RULES.md` (overrides MODE), words in `RULES.history.md` |
| lessons | none | `LESSONS.md` |
| project specifics | shipped `features/` | `features/` (same name wins), channel setups |
