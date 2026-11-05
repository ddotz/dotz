# Module map

Paths only; each file's header comment says what it does. Tests sit next to their module as `*.test.ts`.

## Entry points

- `hub/main.ts` gateway process (startup, timers, shutdown, restart gate)
- `setup.ts` + `onboard/` install wizard (`harness.ts`, `service.ts`, `tailscale.ts`, `aside.ts`, `discord.ts`, `permissions.ts`)
- `firstrun/` first-run web onboarding between hub and onboard: the marker (`first-run.ts`, `first-run-boot.ts`), the gate and its jobs (`setup-gate.ts`, `setup-jobs.ts`, `setup-state.ts`, `setup-term.ts`, `setup-apply.ts`) and the shared answers/apply/scan/exec code; it may import hub and onboard, and only `hub/main.ts`, `hub/routes.ts`, `hub/routes-settings.ts` and `setup.ts` import it
- `extension/index.ts` agent-side extension (`guard.ts`, `guard-config.ts`, `harness-tools.ts`, `output-cap.ts`, `owner-values.ts`, `task-cap.ts`, `compact-kept.ts`, `schema.ts`, `token-audit.ts`)

## Gateway core

- config and process: `hub/config.ts`, `hub/opener.ts` (browser opener, WSL detection), `hub/lock.ts`, `hub/shutdown.ts`, `hub/restart.ts`, `hub/live-guard.ts`, `hub/systemdeny.ts`
- HTTP: `hub/routes.ts` -> `hub/routes-settings.ts` -> `hub/routes-lanes.ts`, helpers `hub/routes-util.ts`, web assets `hub/webapp.ts`, `hub/compress.ts`, files `hub/files.ts`
- message flow: inbound `hub/intake.ts`, outbound `hub/outbound.ts`, send ledger `hub/sendlog.ts`, prompt queue `hub/prompts.ts`, web queue `hub/queue.ts`, background workers `hub/bgwork.ts`, event bus `hub/events.ts`
- request tracking: a worker is linked to its owner message at spawn (`hub/prompts.ts` WorkLink, `*-links.json` beside `pending.json`, survives a restart); each spawned worker gets its own line, its result answers exactly that message, a short todo-closing last message never replaces its report (`hub/bgwork.ts` reportOf), and `hub/waitcheck.ts` wakes the session once, bounded and with no model call before that, when a request stays open for 2 minutes with nothing running
- orchestrator: `hub/orchestrator.ts`, `hub/context.ts`, `hub/fallback.ts`, `hub/rate-alert.ts`, `hub/outlang.ts`, `hub/tone.ts`
- text: `hub/i18n.ts` (+ catalogs `hub/i18n-en.ts`, `hub/i18n-ko.ts`), `hub/language.ts`, `hub/prompt-budget.ts`

## Lanes (sessions)

- public facade `hub/lanes.ts` (re-exports; owns the stall/progress timers)
- state `hub/lanestate.ts`, lifecycle ops `hub/laneops.ts`, process run/recover `hub/lanerun.ts`, event reading `hub/laneevents.ts`, failover `hub/lanefailover.ts`, reports `hub/lanereport.ts`, prompts `hub/laneprompt.ts`, worktrees `hub/lanetree.ts`, launch gates `hub/lanegates.ts`, views `hub/laneviews.ts`, launch limits `hub/lanelimits.ts` (machine limits `hub/limits.ts`)
- around lanes: `hub/lanewire.ts` (report handlers), `hub/lanerelay.ts`, `hub/lanevis.ts`, `hub/lanetrash.ts`, `hub/laneidle.ts`, `hub/asks.ts`, `hub/hygiene.ts`, `hub/cleanup.ts`, `hub/memguard.ts`, `hub/receipts.ts`

## Channels and notices

- send approvals: `hub/attach-check.ts` (does a mail draft's text match its files: the send gate and the card's 첨부 확인 line), `hub/approval-queue.ts` (one card at a time per conversation), `hub/approval-send.ts` (the gateway sends an approved draft itself, in order per place), `hub/approval-batch.ts` + `hub/approval-wire.ts` (batch / triage answers, `/api/approvals`, grouped by app instance)
- Discord: `hub/discord.ts`, `hub/discord-format.ts`, `hub/threads.ts`, `hub/workchannels.ts`, `hub/livestatus.ts`, `hub/askbuttons.ts`, `hub/choices.ts`
- web state: `hub/notices.ts` (facade; the importers keep it, the code sits in `hub/notices-store.ts` (list, upsert, event feed, settle, replay), `hub/notices-types.ts`, `hub/notices-wiring.ts` (resolvers and hooks main.ts plugs in), `hub/notices-rules.ts`, `hub/notices-lanes.ts`, `hub/notices-read.ts`, `hub/notices-viewing.ts`, `hub/notices-decisions.ts`, `hub/notices-stored.ts` (runs once on load), `hub/notices-drafts.ts`, `hub/notices-answers.ts`, `hub/notices-signals.ts`, `hub/notices-bell.ts`), `hub/conversations.ts`, `hub/reads.ts`, `hub/projectchat.ts`, `hub/projects.ts`, `hub/todo.ts`, `hub/activity.ts`, `hub/custom.ts`
- notice classes: `hub/notice-class.ts` (`noticeClass`: 답변 필요 / 경고 / 결과 / 새 소식 / 대화 / 기록, with push, badge and pin), read by the bell tabs (`web/js/31-conversations.js`), web push and Discord's ping
- Discord connection: `hub/discord-connection.ts` (`/api/discord/connection` GET/PUT/DELETE and `/check`: bot token file, server and owner id, `restart_needed` until the gateway restarts; the token is never returned)
- Discord routing: `hub/discord-post.ts` (`<DATA_DIR>/discord-post.json`; kind and per-notice-class switches, `postClass` names a post's class, `/api/discord/post`; the web app always gets everything, 설정 → 앱 · 알림 adds "디스코드로도 보내기" per class)
- push: `hub/push.ts` (per-class switches in config `notify.push`, `/api/push/classes`; news also per app, `custom/apps.json <app>.push`), `hub/webpush.ts`
- per-install custom code (not part of the product): `hub/custom.ts` (cards, pins, routines), `hub/plugins.ts` (plugin hooks, see `docs/custom-plugins.md`; loaded from `<DATA_DIR>/custom/plugins/`)
- mail: `hub/mail-move.ts` (moves a stored mail to another mail app, `/api/mail/move`)
- mail: `hub/mail-delete.ts` (삭제하면 원본도 삭제: the source adapters behind the owner's delete, `/api/mail/delete-original`)
- Relay chat (a computer reached only through a messenger, the adapter's `relay`): `hub/relay-route.ts`, web `web/js/42-relay-chat.js`

## Accounts, providers, runtimes

- accounts: `hub/account-sticky.ts`, `hub/account-rules.ts`, `hub/account-alias.ts`, `hub/accounts-api.ts`, `hub/usage-account.ts`
- keys and providers: `hub/providers.ts`, `hub/apikey-store.ts`, `hub/apikey-policy.ts`, `hub/auth.ts`, `hub/control.ts`
- runtimes: `hub/runtime/index.ts`, `hub/runtime/types.ts`, adapters `hub/runtime/omo.ts`, `hub/runtime/omp.ts`, `hub/runtime/claude.ts`, support `hub/runtime/detect.ts`, `hub/runtime/verify.ts`, `hub/runtime/omo-hosts.ts`, `hub/runtime/senpi-bin.ts`, `hub/runtime/claude-deny-hook.ts`, probes and test fixtures `hub/runtime/*-probes.ts`, `hub/runtime/scenario.ts`

## Background jobs

- code health gate: `hub/engineering-rules.ts` (detectors), `hub/engineering-rules.test.ts` (ceilings, `docs/engineering-standards.md`), `hub/git-hooks.ts` (points a clone at `.githooks`, whose pre-push runs that test)
- `hub/watch.ts`, `hub/monitors.ts`, `hub/schedule.ts`, `hub/reflect.ts`, `hub/token-audit.ts`, `hub/session-sources.ts`, `hub/summaries.ts`, `hub/update.ts`, `hub/selfupdate.ts`, `hub/update-now.ts` (the top update bar's one tap: download and test, restart when work ends, turns after the tap held on disk and delivered after the restart), `hub/backup.ts`, `hub/zele.ts`, `hub/aside.ts`
- harness views: `hub/harness.ts`, `hub/harnessprojects.ts`, `hub/features.ts`, `hub/featuredirs.ts`

## Web app

- `web/index.html`, `web/sw.js`, `web/custom.js`, `web/manifest.webmanifest`
- `web/js/NN-*.js` and `web/css/*.css`: classic scripts concatenated in filename order into one app.js by `hub/webapp.ts` (shared globals; `01-core.js` holds the common helpers)
