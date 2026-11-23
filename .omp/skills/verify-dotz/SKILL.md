---
name: verify-dotz
description: "Use to prove any change to dotz's UI or behavior (web app under web/, the reply-draft approval flow, gateway HTTP routes) on a real, isolated gateway: launch on a disposable data dir and free port, doctor, drive the feature in the browser through aside, capture screenshots at 390 and 1280 px, write the run manifest, clean up. Never touches ~/.dotz or port 7420 and never sends anything out."
disable-model-invocation: true
---

Every recipe below runs from the repo root. A run is one isolated gateway under `.omp/verify/runs/<run-id>/` (git-ignored). Pick a fresh run id per run, e.g. `RUN=$(date +%Y%m%d-%H%M%S)`.

Hard limits: never read or write `~/.dotz`, never call port 7420 (the owner's live gateway), never send anything out. The scripts enforce the port and data dir; you enforce the rest by driving only through them.

## Launch

    bun .omp/skills/verify-dotz/scripts/launch.ts $RUN [--tree worktree|head]

- `--tree worktree` (default) runs `bun hub/main.ts` from this checkout, so uncommitted UI edits are what you see. `--tree head` runs a `git archive HEAD` copy in `<run>/tree` (use it when another session's half-done edits break the checkout, and always for bombadil).
- Data dir `<run>/data` (`DOTZ_DIR`), `HOME=<run>/home`, a free port that is never 7420, `DOTZ_WEB_LIVE=1`.
- Seed: `config.json` (identity `verify`, `web.access: "local"`, zele off, self-update off and `keep_local`), `secrets/hub-token`, one owner login session in `web-local-sessions.json` (its cookie value is in `run.json`), reply drafts enabled with automatic mail drafts off (no model call is ever made).
- Outbound is cut at existing boundaries: `DOTZ_DRY_RUN=1` keeps Discord off (`hub/live-guard.ts`), `DOTZ_NO_ORCHESTRATOR=1` starts no agent, `DOTZ_OMO`/`DOTZ_OMP`/`DOTZ_CLAUDE` point at missing or refusing binaries, and `<run>/bin` goes first on `PATH` with stubs: `zele` records every call to `<run>/outbound/calls.log` and answers `whoami`, `mail read`, `mail reply|send` with success and sends nothing; `aside`, `osascript`, `open`, `say`, `afplay`, `gh`, `kmsg`, `tailscale`, `cloudflared`, `omp`, `claude`, `terminal-notifier` record the call and exit 1.
- Ready means usable: `/` with the owner cookie returns the app shell and `/api/state` answers 200. The script prints `{runId, url, pid, port, data, dir}` and writes `<run>/run.json`.

## Doctor

    bun .omp/skills/verify-dotz/scripts/doctor.ts $RUN

Read-only. Exits 1 unless: port is not 7420, our pid is alive and is the only listener on the port, `<data>/hub.pid` is our pid, `/api/health` is 200, an anonymous `/api/state` is 403, the owner cookie gets 200, the instance names itself `verify`, Discord is in dry run, no orchestrator runs. Prints the commit, tree mode, dirty file count and `web_build`. Run it before the first drive and after any failed one; a failing instance gets cleanup + a new launch, not a retry.

## Drive

    bun .omp/skills/verify-dotz/scripts/drive.ts <feature> $RUN

Features: `auto-reply`, `app-shell`, `comments-mail-app`, `fallback-keys`, `seen-results` (index: `features/README.md`). The driver arranges state through the same HTTP routes production uses, drives the web app in the owner's Aside browser through `aside repl` (tab only, nothing comes to the foreground; on `http://localhost:<port>` because the owner's own `dotz_local` cookie for `127.0.0.1` is HttpOnly and would shadow ours), captures artifacts into `<run>/<feature>/`, checks side effects, and as its last step writes `<run>/<feature>/manifest.json` through `bun ~/.omp/agent/harness/gate/evidence.ts manifest`. Cookies do not tell ports apart, so drives from any checkout or session take turns on the browser through `~/.cache/verify-dotz/browser.lock` (one browser step at a time, wait up to 600 s; a lock whose pid is gone is taken over).

Worked example (auto-reply, about 50 s):

    RUN=$(date +%Y%m%d-%H%M%S)
    bun .omp/skills/verify-dotz/scripts/launch.ts $RUN --tree head
    bun .omp/skills/verify-dotz/scripts/doctor.ts $RUN
    bun .omp/skills/verify-dotz/scripts/drive.ts auto-reply $RUN
    bun .omp/skills/verify-dotz/scripts/cleanup.ts $RUN

A new feature: add its id to `FEATURES` in `scripts/drive.ts`, its browser steps to `scripts/browser.ts`, its entry to `features/` and `.omp/verify/features.json`.

## Evidence

- Artifacts live in `.omp/verify/runs/<run-id>/<feature>/`: ARIA trees and snapshot diffs (`*.aria.txt`, `*.aria.diff`), PNG screenshots, `checks.log` (each before/after observation), `network-*.txt` (`lsof` of every process in the run's process group; any non-loopback socket fails the drive), and for auto-reply `outbound-calls.log`.
- Each feature captures the action and the resulting state, and opens the changed screen cold (fresh tab) at 390 and 1280 px wide. The home screenshot shows the instance name `verify`, which is the app identity.
- Only `scripts/drive.ts` writes `manifest.json`. Never write or edit a manifest or an artifact by hand. Run the driver after the last edit and commit of the feature's files: a later edit makes its manifest stale (`bun ~/.omp/agent/harness/gate/evidence.ts tree --repo . --feature <id>` prints the current fingerprint). With `--tree head`, the driver refuses when the feature's files differ from HEAD.
- The stubs are proven by observation, not by name: `outbound/calls.log` shows what each send reached, `network-*.txt` shows no socket left the loopback, `doctor.json` shows Discord in dry run. The launcher seeds an empty `<data>/models-dev.json`, so the gateway reads that day-fresh cache instead of fetching the models.dev catalog (`hub/fallback.ts` `modelsDev`).
- Bombadil, after the feature drives pass, against the same isolated instance (it must be a `--tree head` run; it clicks every button, 업데이트 included):

      .omp/skills/verify-dotz/scripts/bombadil.sh $RUN 45s

  It runs headless (Playwright's chrome-headless-shell; the full Chrome for Testing 1234 times out on `Page.captureScreenshot` here) with the owner cookie, writes `<run>/bombadil.out` and the trace under `<run>/bombadil/`. Exit 0 means no default-property violation in the budget; a non-zero exit with `was violated` in `bombadil.out` is a finding, so chain Cleanup with `;`, not `&&`. Reproduce a violation with the `--reproduce` line printed in `bombadil.out`, then confirm it in the code or through a drive before calling it a bug. Known: `noUncaughtExceptions` from `CSS.escape` in `web/custom.js` (see `features/app-shell.md`).
- UI layout or styling change: also run `skill://visual-diff`.

## Cleanup

    bun .omp/skills/verify-dotz/scripts/cleanup.ts $RUN

Sends SIGTERM, then SIGKILL after 15 s, to the run's process group only (the gateway was started detached as its own group; never kill by name). Writes `<run>/cleanup.json` and exits 1 if any process of the group is left or anything still listens on the port. Evidence stays. Run it after every failed attempt too. The driver's browser steps remove their `dotz_local` cookie from `localhost` themselves.

## Surfaces

| Surface | Status |
|---|---|
| Web app (`web/`, served by `hub/main.ts`) | drivable: `aside repl` through `scripts/drive.ts` |
| HTTP routes | drivable: `curl` or `fetch` against `run.json` `url`; owner calls send the `dotz_local` cookie, agent calls the `x-dotz-token` hub token (the gateway treats a hub-token request as an agent, never as the owner) |
| Web onboarding (`web/setup/`, first-run mode) | drivable in principle (a data dir with a pending `onboarding/first-run.json`), not in the feature map yet |
| Terminal setup (`setup.ts`, `onboard/`) | drivable in tmux in principle, not in the feature map yet |
| Discord, KakaoTalk, mail, web push delivery | not drivable here: stubbed or off by design; never verified through a real send |
| iOS home-screen app, Safari Korean input | not drivable here |
