# Module map

Paths only; each file's header comment says what it does. Tests sit next to their module as `*.test.ts`.

## Entry points

- `hub/main.ts` gateway process (startup, timers, shutdown, restart gate)
- `setup.ts` + `onboard/` install wizard (`harness.ts`, `service.ts`, `tailscale.ts`, `aside.ts`, `discord.ts`, `permissions.ts`)
- `extension/index.ts` agent-side extension (`guard.ts`, `guard-config.ts`, `harness-tools.ts`, `output-cap.ts`, `compact-kept.ts`, `schema.ts`, `token-audit.ts`)

## Gateway core

- config and process: `hub/config.ts`, `hub/lock.ts`, `hub/shutdown.ts`, `hub/restart.ts`, `hub/live-guard.ts`, `hub/systemdeny.ts`
- HTTP: `hub/routes.ts` -> `hub/routes-settings.ts` -> `hub/routes-lanes.ts`, helpers `hub/routes-util.ts`, web assets `hub/webapp.ts`, `hub/compress.ts`, files `hub/files.ts`
- message flow: inbound `hub/intake.ts`, outbound `hub/outbound.ts`, send ledger `hub/sendlog.ts`, prompt queue `hub/prompts.ts`, web queue `hub/queue.ts`, background workers `hub/bgwork.ts`, event bus `hub/events.ts`
- orchestrator: `hub/orchestrator.ts`, `hub/context.ts`, `hub/fallback.ts`, `hub/rate-alert.ts`, `hub/outlang.ts`, `hub/tone.ts`
- text: `hub/i18n.ts` (+ catalogs `hub/i18n-en.ts`, `hub/i18n-ko.ts`), `hub/language.ts`, `hub/prompt-budget.ts`

## Lanes (sessions)

- public facade `hub/lanes.ts` (re-exports; owns the stall/progress timers)
- state `hub/lanestate.ts`, lifecycle ops `hub/laneops.ts`, process run/recover `hub/lanerun.ts`, event reading `hub/laneevents.ts`, failover `hub/lanefailover.ts`, reports `hub/lanereport.ts`, prompts `hub/laneprompt.ts`, worktrees `hub/lanetree.ts`, launch gates `hub/lanegates.ts`, views `hub/laneviews.ts`, launch limits `hub/lanelimits.ts` (machine limits `hub/limits.ts`)
- around lanes: `hub/lanewire.ts` (report handlers), `hub/lanerelay.ts`, `hub/lanevis.ts`, `hub/lanetrash.ts`, `hub/laneidle.ts`, `hub/asks.ts`, `hub/hygiene.ts`, `hub/cleanup.ts`, `hub/memguard.ts`, `hub/receipts.ts`

## Channels and notices

- Discord: `hub/discord.ts`, `hub/discord-format.ts`, `hub/threads.ts`, `hub/workchannels.ts`, `hub/livestatus.ts`, `hub/askbuttons.ts`, `hub/choices.ts`
- web state: `hub/notices.ts`, `hub/conversations.ts`, `hub/reads.ts`, `hub/projectchat.ts`, `hub/projects.ts`, `hub/todo.ts`, `hub/activity.ts`, `hub/custom.ts`
- push: `hub/push.ts`, `hub/webpush.ts`

## Accounts, providers, runtimes

- accounts: `hub/account-sticky.ts`, `hub/account-rules.ts`, `hub/account-alias.ts`, `hub/accounts-api.ts`, `hub/usage-account.ts`
- keys and providers: `hub/providers.ts`, `hub/apikey-store.ts`, `hub/apikey-policy.ts`, `hub/auth.ts`, `hub/control.ts`
- runtimes: `hub/runtime/index.ts`, `hub/runtime/types.ts`, adapters `hub/runtime/omo.ts`, `hub/runtime/omp.ts`, `hub/runtime/claude.ts`, support `hub/runtime/detect.ts`, `hub/runtime/verify.ts`, `hub/runtime/omo-hosts.ts`, `hub/runtime/senpi-bin.ts`, `hub/runtime/claude-deny-hook.ts`, probes and test fixtures `hub/runtime/*-probes.ts`, `hub/runtime/scenario.ts`

## Background jobs

- `hub/watch.ts`, `hub/monitors.ts`, `hub/schedule.ts`, `hub/reflect.ts`, `hub/token-audit.ts`, `hub/session-sources.ts`, `hub/summaries.ts`, `hub/update.ts`, `hub/selfupdate.ts`, `hub/backup.ts`, `hub/zele.ts`, `hub/aside.ts`
- harness views: `hub/harness.ts`, `hub/harnessprojects.ts`, `hub/features.ts`, `hub/featuredirs.ts`

## Web app

- `web/index.html`, `web/sw.js`, `web/custom.js`, `web/manifest.webmanifest`
- `web/js/NN-*.js` and `web/css/*.css`: classic scripts concatenated in filename order into one app.js by `hub/webapp.ts` (shared globals; `01-core.js` holds the common helpers)
