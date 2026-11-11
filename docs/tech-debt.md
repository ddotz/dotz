# Tech debt ledger (2026-11-11)

What is still open after the 2026-11-11 cleanup. Items that were cleaned are in git history, not here. Numbers come from
`bun hub/engineering-rules.ts`; the ceilings they are held to are in hub/engineering-ceilings.json.

Measured now: swallowed errors hub 192, web 69, features 27, extension 11. Non-atomic writes hub 43, features 8.
Same-name helpers `readJson` 13, `json` 5, `git` 6, `shq` 5, `sleep` 3, `sameOrigin` 3. Import cycles 5. Hub modules
docs/ARCHITECTURE.md does not name: 150. Fixed sleeps in tests 3, wall-clock budget files 0.

## Defects (fixing them changes behaviour, so they are not refactors)

- A file that failed to parse is overwritten with a near-empty one: hub/discord-connection.ts `updateDiscord` and
  hub/config.ts `updateNotifyPush` (config.json, every other section is lost), hub/outbound.ts (pending.json, read
  at load), hub/user-apps.ts (custom/apps.json, a file the owner writes), hub/convsessions.ts (a conversation's
  pending.json), extension/guard.ts `loadState` (the worker state). hub/config.ts already has `readJsonOrQuarantine`
  for this.
- extension/index.ts reaches hub/config.ts (through hub/systemdeny.ts and hub/clone-identity.ts, for `writeAtomic`
  alone), so every agent session creates the data folder, the template files and the hub token as an import side effect.
- hub/clone-identity.ts `commitContentRefusal` checks the words of the `git commit` command, not the body of a `-F`
  file: a clean message is refused when the file's path holds a listed word, and a listed word in the body passes.
- hub/runtime/test-slot.ts `isFullSuite` reads the command line from `ps`, so `-t "a b"` splits in two and a one-file
  run counts as a full run.
- The pre-push limit check says "over a limit" when hub/engineering-rules.test.ts only timed out on a busy machine.
- Module-level maps with no delete path: hub/discord.ts `sentAt`, `notWork`, `unplaced`; hub/intake.ts `lastAsked`;
  hub/lanereconnect.ts `counted`; hub/laneresume.ts `named`; hub/custom.ts `gitCache`; hub/conversations.ts `known`.
  Not read for another bound.
- The `dotz_*` tool descriptions in extension/index.ts are about 17,000 characters per request and under no budget
  (hub/prompt-budget.ts covers the templates only). Shortening them changes what the model reads.

## Oversized files and functions

- hub/orchestrator.ts 1060, `createOrchestrator` 972: resume state, the model chain, `readEvents` and `start` share
  one closure, so a split needs a deps object first.
- hub/discord.ts 948 (`connect` 152), hub/custom.ts 900 (its routes and file shapes are a public surface:
  docs/customization.md, docs/custom-plugins.md), hub/messenger-agent.ts 870, hub/providers.ts 825 (in a cycle with
  hub/api-budget.ts and hub/fallback.ts).
- Factories that hold state throughout: `createPrompts` 706, `createKakaoWeb` 649, `createEngine` 624,
  `installGuard` 375, `createBgWork` 373.
- web/js/30-kakao.js 1200 of 1200 and web/js/30-monitoring.js 993 of 1000. A split waits for their screen text to
  move to web/i18n: hub/web-i18n-check.ts allows a new web/js file no Hangul literal at all, and these two hold 376
  and 410.

## Dead surface

- `export` on names no other file uses: about 620 in hub/ and features/, 41 in extension/. The dead-export check
  counts words, so a name used twice in its own file passes.
- 49 functions only tests call (for example hub/ui-surfaces.ts `extractOpenSites`, hub/kakao/draft.ts
  `pickDraftModel`, hub/accounts-api.ts `switchText`). Test seams (`reset...ForTest`, `set...Runner`) stay.
- hub/selfupdate.ts `onLocalSaved`: only hub/selfupdate-local.test.ts sets it.
- Test fixtures in the hub/ root beside shipped code: hub/test-web.ts, hub/test-signing.ts, hub/test-pane-cards.ts,
  hub/selfupdate-fixture.ts, hub/ask-normalize.fixture.ts.
- hub/mail-card-menu-web.test.ts and hub/mail-list-web.test.ts still query `.mr-slot`, a class no code makes.
- localStorage readers still hand-rolled: web/js/15-attachments.js and web/js/13-snapshot.js (their catch does more than fall back),
  web/js/33-peers.js, web/js/09-needs-you.js and web/js/23-installable-app-web.js (tests such as
  hub/peers-web.test.ts, hub/web-attn.test.ts and hub/notice-open.test.ts run those files without web/js/01-core.js,
  where `lsJson` and `lsSet` live).

## Duplication

- `readJson`: four bodies are identical (hub/usage-account.ts, hub/model-runner.ts, hub/account-sticky.ts,
  features/reply-drafts/lib/settings.ts), but no module without load-time side effects is there to hold one copy.
- Atomic write: five helpers (hub/config.ts, hub/comments/store.ts, hub/kakao/onboard.ts,
  features/reply-drafts/lib/settings.ts, features/publish-voice/lib/store.ts) differ in mkdir and file mode only.
- `shq`: six copies with the same result (hub/runtime/claude.ts, hub/runtime/senpi-bin.ts,
  hub/runtime/claude-cli-shim.ts, hub/kakao/onboard.ts, features/webmail-no-api/bin/setup.ts,
  features/comments/bin/onboard.ts); a shared one crosses the features -> hub boundary.
- `json` 5 and `git` 6 that stay: each answers or returns differently.
- web/js/30-notices.js `ntTime` and web/js/30-monitoring.js `monTime` are the same line (web/js/11-resultcard.js
  `rcWhen` adds an empty-value guard). One copy needs a home every test that loads one of those files alone also
  loads.
- Tests: `class FakeAgent` in 26 files, `waitFor` in 48 web test files, 11 other wait helpers, 11 pairs of tests with
  the same title.

## Tests

- Scripts started from os.tmpdir(): `bun` reads the folders above a script, and in a temp folder with hundreds of
  thousands of entries a start took 1.5 to 3.1 s against 0.1 s in /tmp. The preload lists its `dotz-test-*`
  folders (`<tmp>/dotz-test-runs/<pid>-<start>`) and the next test process removes those of processes that ended,
  so the folders of the last run stay until another run starts; the stand-ins of hub/remote-desktop.test.ts are files of the repo; other tests still write a script to
  the temp folder and start it (hub/account-rules.test.ts, the setup and onboard tests).
- `bun test` never fires the process `exit` event, and a `--parallel` worker kills the children it still has when it
  ends, detached or not. A cleanup that must outlive the run is started by a shell that exits at once, and that exit
  is awaited (hub/runtime/test-setup.ts, hub/install-e2e.test.ts).
- A `--parallel` worker runs the preload once per FILE with a fresh `process.env` and `globalThis`; only the pid,
  `performance.timeOrigin` and the file system last. Anything the preload starts is started 805 times in a full run:
  a shell per file that polled for the worker's end (1,600 processes, 805 forks a second) took the machine down
  three times. No check counts the processes a test run leaves running.
- Tests leave their own temp folders behind (`dotz-done-*`, `limitwait-*` and others: 14 after a 20-file run).
- hub/load-qa.test.ts starts its gateway detached and stops it only in `afterAll` (hub/test/load-qa/harness.ts): a
  run killed before that hook leaves the gateway and its agent shim running under launchd.
- 45 `afterAll` hooks remove a folder synchronously; only hub/install-e2e.test.ts had one big enough to pass the hook
  limit.
- hub/kakao-chat-web.test.ts "a request with no draft waiting makes a new draft": failed once in a 20-file run (the
  보내는 중 bubble never appeared in 5 s, then four tests failed on `evaluate() is already pending`) and passed in
  165 ms three times after. A missed signal, not slowness; the cause is not found.
- hub/load-qa.test.ts test 5 (the restart) timed out at 60 s once in a full run at load 18 to 25 and was not
  reproduced; the tests after it no longer fail with it.
- hub/runtime/test-slot.test.ts takes 10 s alone and 65 s at load 45 to 75 (it starts nested test runs).
- onboard/selfserve.test.ts waits with `await f.h.sleep(0)` on a fake sleep; the last assertion depends on it.
- Fixed sleeps 3: deadlines in a `Promise.race` on an event (hub/remote-desktop.test.ts twice,
  hub/messenger-e2e-discord.test.ts).
- hub/relay-chat-web.test.ts clears `seen` (every /api request of one shared page) in `beforeEach` and compares the
  POST list exactly: safe in file order, order-dependent under `--randomize`. Its last test clears `seen` and never
  reads it, so the title's "read again each time" is not checked.
- hub/draft-fullscreen-web.test.ts takes the first open draft decision in the notice store: run in one process after
  hub/draft-labelled-web.test.ts it finds that file's draft and fails. The suite passes because `bun run test`
  isolates each file.
- Sentence assertions (hub/accounts-api.test.ts, hub/livestatus.test.ts, hub/notices.test.ts) and order dependence
  under `bun test --randomize` inside single files: not measured this round.

## Docs

- Config keys the code reads and no doc names: `gateway.stuck_turn_min`, `gateway.coalesce_ms`,
  `web.send_undo_sec`, `web.triage_min`, `web.snapshot_*`, `web.upload_max_mb`, `web.file_roots`,
  `discord.attach_max_mb`, `zele.*`, `api_budget`, `conversations.*`.
- docs/customization.md lists the `/api/custom*` routes but not `POST/PUT/DELETE /api/custom/cards`.
- docs/ui-spec.md (홈 상태 카드) describes the assistant card's summary cells as `.hsum`, and docs/web-app-design.md the
  reply queue as `div.rq-q`; no code makes either class, and their CSS is gone. Which side is right is a design call.
- 150 hub modules are not in docs/ARCHITECTURE.md.

## Speed (the speed pass owns these)

- hub/install-e2e.test.ts, hub/load-qa.test.ts and the self-update tests are most of the suite's wall time.
- hub/routes.ts reads and parses manifest.webmanifest on every request; hub/events.ts reads both logs whole at boot
  for the last 150 lines; hub/orchestrator.ts `saved()` re-reads the state file on every call.
