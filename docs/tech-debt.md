# Tech debt ledger (2026-10-21)

Survey taken on 3319335 before any cleanup. Baseline: 508 tests in 81 files, 0 fail, 32.2 s wall (`bun test`).
Line counts: hub/main.ts 1319, hub/lanes.ts 1144, hub/discord.ts 908, hub/i18n.ts 894, hub/orchestrator.ts 758,
hub/custom.ts 709, web/js/30-notices.js 588. hub/notices.ts, web/js/10-decision-card.js and web/js/30-notices.js
are being changed by another worker: findings there are listed as "defer".

## Oversized files (target: no hub/*.ts over 800 lines)

- hub/main.ts 1319: `route()` alone is 520 lines (659-1178); startup (Bun.serve, timers, restore) at 1180-1257.
- hub/lanes.ts 1144: lane lifecycle, event reading, worktree ops, budget/brief gates, views in one file.
- hub/discord.ts 908: channels/threads (185-346), inbound (708-771), `connect` 138 lines.
- hub/i18n.ts 894: the en/ko message catalogs are lines 48-852.

## Oversized functions (80+ lines)

- hub/main.ts:659 route 520
- hub/prompts.ts:75 createPrompts 247 (factory; closure-scoped state)
- hub/token-audit.ts:84 analyze 190; :285 findingsOf 86; :399 runAudit 96
- hub/harness.ts:249 harnessGraph 184
- hub/discord.ts:771 connect 138
- hub/control.ts:391 execute 137
- hub/orchestrator.ts:229 readEvents 125; :472 start 93
- hub/summaries.ts:69 createSummarizer 110
- hub/lanes.ts:390 readEvents 99; :524 spawn 81
- hub/harnessprojects.ts:92 buildProject 97
- hub/sendlog.ts:31 createSendLedger 87
- extension/guard.ts:766 installGuard 355; extension/token-audit.ts:267 analyze 162
- test-only fixtures: hub/runtime/scenario.ts, omo-probes.ts, claude-probes.ts
Only `route` is split in this pass (it is what makes main.ts too big); the rest are noted, not changed.

## Dead code

Exports with no reference anywhere (not even in their own file or in tests):
- hub/summaries.ts:189 `summariesIdle`
- hub/selfupdate.ts:103 `updateSettings`, :194 `currentJob`
- hub/config.ts:203 `updateConfig`
- hub/queue.ts:30 `hasQueued`
- extension/schema.ts:34 `schemaOf`

Exports used only inside their own module (the `export` keyword is dead surface): about 150 symbols across hub/,
extension/ and onboard/ (types, constants and helpers); e.g. apikey-policy `pinnedAccount`, live-guard `isTempPath`,
lanes `checkBrief`/`LANE_MIN_HOURS`, discord `deleteMessage`/`editedText`, selfupdate `setSettings`.
Test hooks (`resetStickyForTest`, `resetFallbackState`, `settleRefreshes`, `installClock`) stay: tests need them.

## Legacy paths

- hub/config.ts:34-77 `LEGACY` + `migrateModels`: moves pre-2026-10-20 model keys (orchestrator/lanes `.model`,
  `.thinking`, `.fallback`, lanes `.worker_model`/`.worker_fallback`) into `models`. ~/.dotz/config.json has only
  `runtime` under orchestrator/lanes and a `models` block; the migration already ran (config.json.bak-models-2026-10-20…).
  Also used by `updateModels` (config.ts:151), the setup.ts:58 `priorSelector` fallback and hub/model-config.test.ts.
  Verdict: remove.
- hub/notices.ts:374 `backfillNotices`: one-time build of notices.json from history; ~/.dotz/notices.json exists.
  Verdict: dead for this install, but defer (file under edit by another worker).
- hub/discord.ts:640 `embeds: []` on edit: clears embeds of old Discord messages, which still exist in channels. Keep.
- `PI_AGENT_DIR` fallbacks (apikey-policy.ts:12, cleanup.ts:23, runtime/omo-hosts.ts:14): an env name the omp
  runtime still sets. Keep.
- `legacyError` in lanes.ts:307 and orchestrator.ts:167 is a misnomer for the non-failover error path, not legacy data.

## Duplication

- Temp-folder regex `^/(private/)?(tmp|var/folders)/`: hub/live-guard.ts:10 `TEMP_PATH`, hub/cleanup.ts:17 `TEMP_CWD`,
  hub/lanes.ts:1098 `TEMP_RE` are identical -> one copy (live-guard). discord.ts:305 and harnessprojects.ts:192
  match /tmp only (different behavior): keep.
- Atomic write: hub/config.ts:195 `writeAtomic` vs inline tmp+rename in hub/receipts.ts:111 (tmp name adds a uuid;
  both are synchronous, so the pid-only name cannot collide within one process) -> receipts uses writeAtomic.
- JSON-with-fallback readers in hub (account-sticky.ts:66, account-alias.ts:14, apikey-policy.ts:28): each validates a
  different shape. Keep.
- localStorage JSON readers in web/js (02:108, 07:34, 08:150, 16:4, 23:41; 09:5 defer): same try/parse/catch with
  different shape checks -> one `lsJson(key, fallback)` in 01-core.js where the fallback semantics match.
- Regex-escape: hub/accounts-api.ts:29 and web/js/02-basic-markdown.js:12 are identical, but web cannot import hub
  (web/js is concatenated into app.js by hub/webapp.ts). Keep.
- Decision parsing: hub/choices.ts `parseDecisions` vs web/js/10-decision-card.js `parseChoices` share regex bodies.
  Defer (file under edit).
- Error/failover path: lanes.ts:300-330 and orchestrator.ts:160-190 run the same failover-then-error shape on
  different targets. Diverges per target; keep.

## Tests

- Slow files (junit times): onboard/onboard.test.ts 15.9 s (two `setup.ts --answers` runs, 10.5 s and 5.3 s),
  hub/receipts.test.ts 9.3 s (about 1 s per test), hub/selfupdate.test.ts 1.8 s. These two files are half the suite.
- Sleep/timing: hub/sendlog.test.ts:86,95 `await Bun.sleep(0)` to let a promise settle -> await the ledger's own
  result. hub/account-rules.test.ts:141,205 child scripts `Bun.sleep(20000)` stand in for "never exits" (the test waits
  on the kill result, not on time; keep the idea, use a never-resolving promise).
- Prose-pinning candidates (assertions on sentences, not fields): hub/accounts-api.test.ts (55 phrase assertions),
  hub/livestatus.test.ts (14), onboard/onboard.test.ts menu-line equality, hub/runtime/claude.test.ts,
  hub/fallback-revert.test.ts:136,151,192, extension/guard.test.ts:135, hub/runtime/pool-blocked.test.ts:119.
  hub/notices.test.ts (51) defer. Each one keeps its machine-checked part (fields, sentinels, codes).
- Overlap: hub/model-config.test.ts migration tests go with the legacy path. Lane tests that each boot a fake lane
  (claim, lane-runtime, lane-owner-note, asks, retain-nudge, fallback-chain) are checked pairwise for repeated
  assertions in the test pass.

## Memory, tokens, speed

- Module-level maps and arrays in hub/ (about 40): almost all are bounded by the number of targets, lanes or
  watches, or are pruned (discord `handled`/`recentTexts`, push `recent`, compress `memo`, events ring buffers,
  hygiene `endedSeen`). One grows with traffic: hub/conversations.ts:66 `incoming` keeps every incoming message id
  per target until the gateway restarts (unread counting). Follow-up: cap it at the read position; it is a behavior
  change, so it is not part of this cleanup.
- Per-request work: inbox.jsonl/outbox.jsonl are about 430 KB each; history reads tail them (events.ts reads the last
  150 lines at start). No hot path re-reads a whole log per request.
- Prompt size: hub/prompt-budget.ts caps MODE/RULES/LESSONS/owner/boundaries templates in bytes and is tested; the
  i18n split leaves the text byte-identical, so prompt cost is unchanged.
- Test speed: the suite's time is two files (above); fixed there.
- hub/runtime/ is owned by a parallel memory change (worker caps, idle-lane stop, reaping) and is left out of the splits.

## Outcome

Tests: 508 in 81 files, 32.2 s -> 504 in 81 files, about 7 s, 0 fail. Rebased on ad81231 (main's notices, memory caps,
limits.ts, laneidle.ts, runtime/senpi-bin.ts): 534 in 85 files, 31.9 s -> 530 in 85 files, 7.7 s, 0 fail.
Largest hub file: 1319 lines -> 795.

- Split (no behavior change; an old-vs-new sandbox boot answered 22 GET routes identically): hub/main.ts 1319 -> 327
  (+ routes.ts, routes-settings.ts, routes-lanes.ts, routes-util.ts, outbound.ts, intake.ts, lanewire.ts);
  hub/lanes.ts 1144 -> 40-line facade (+ lanestate, laneops, lanerun, laneevents, lanefailover, lanereport, laneprompt,
  lanetree, lanegates, laneviews); hub/discord.ts 908 -> 795 (+ discord-format.ts); hub/i18n.ts 894 -> 64
  (+ i18n-en.ts, i18n-ko.ts). Main's dynamic-limit code from ad81231 went into lanelimits.ts (laneLimits, launchWait,
  laneCapacity), laneops.ts (queue, begin, parkLane), lanerun.ts (worker slots at spawn) and lanestate.ts (parked,
  waiting); limits.ts, laneidle.ts and runtime/senpi-bin.ts are unchanged. The `lanes.ts?tag` test imports no longer isolate state, so lanestate.ts has
  `resetLaneStateForTest()`, called by the nine lane test files.
- Removed: the six unreferenced exports, the 2026-10-20 model-key migration (config.ts LEGACY/migrateModels, setup.ts
  legacy reads, 3 migration tests), `export` on about 180 module-private symbols, two copies of the temp-path regex,
  five hand-rolled localStorage JSON readers in web/js (now `lsJson` in 01-core.js).
- Tests: onboard 15.9 s -> under 1 s (the launchctl stub now answers the permission probe, so setup no longer retries
  for 5 s), receipts 9.3 s -> 1.3 s (throwaway HOME, no login profile per run); sendlog waits on the ledger's own
  signals, account-rules uses a never-ending child instead of a 20 s sleep; wording-only assertions in accounts-api,
  onboard, claude, pool-blocked, fallback-revert and guard now check fields or the catalog's own copy; one duplicate
  pool-blocked test merged into hub/runtime/pool-blocked.test.ts.
- Kept on purpose: receipts.ts' own atomic write (the extension imports it, and config.ts has load-time side effects);
  tmp-only regexes in discord.ts/harnessprojects.ts (different behavior); the deferred items above.
- Follow-ups: conversations.ts `incoming` growth; `bun test --randomize` fails 3-6 order-dependent tests inside single
  files (same on the base commit); notices backfill once the notices work lands.
- Found, not fixed in this lane (owner-visible, a behavior change): the project screen (web/js/19-project-main.js
  pmLanes/pmSessionRow) titles a lane with its key (account-switch, speed-analysis) when the lane has no `title`, and
  its second line is the lane's raw `lastText`, which is the agent's English progress text.
