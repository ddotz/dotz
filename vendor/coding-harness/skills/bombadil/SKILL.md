---
name: bombadil
disable-model-invocation: true
description: "Property-based UI fuzzing with Bombadil (Antithesis, MIT): it clicks, types, and navigates a running web app (or a terminal app) on its own for minutes and reports any state that breaks a property, with a reproducible trace. Entered from a project verify skill or ulw after UI changes to apps with many screens or flows, before a release, or to hunt a bug that only shows after odd user sequences."
---

Example tests check the paths you thought of. Bombadil explores the ones you did not, and checks rules in every state it reaches.

## Setup (this machine)

- Binary: `~/.local/bin/bombadil` (v0.7.10, `bombadil --version`). Missing: `curl -L -o ~/.local/bin/bombadil https://github.com/antithesishq/bombadil/releases/download/v0.7.10/bombadil-aarch64-darwin && chmod +x ~/.local/bin/bombadil`.
- Browser: without `CHROME` it launches `/Applications/Google Chrome.app`, which crashes under Kaku. Always set it to Playwright's Chrome for Testing and run headless (the guard blocks `bombadil browser test|fuzz` without `CHROME=`):

      CHROME="$(ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64 | tail -1)/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

  No Playwright browsers: `bunx playwright install chromium`.
- Spec types (only when writing a custom spec): `bun add -d @antithesishq/bombadil` with the project's package manager.

## Run

1. Launch the app through the project's verify skill (its Launch section) so it runs isolated with seed data. Anything a Playwright drive injects with `addInitScript` (IPC fixtures, auth) must be served by the page itself here, e.g. a dev-server flag that inlines the fixture; Bombadil cannot inject scripts.
2. Default properties first (uncaught exceptions, unhandled rejections, console errors, HTTP 4xx/5xx):

       CHROME="..." bombadil browser test --headless --time-limit 60s --exit-on-violation \
         --output-path .omp/verify/runs/<run-id>/bombadil <url>

   Exit 0 = no violation in the time budget, not "no bugs". Electron or an already-running browser: `bombadil browser test-external --remote-debugger http://127.0.0.1:<port>`. Terminal apps: `bombadil terminal test --time-limit 60s <command>`.
3. Custom properties for the app's own rules, in `.omp/verify/bombadil/spec.ts`:

       import { always, eventually, now } from "@antithesishq/bombadil";
       import { extract } from "@antithesishq/bombadil/browser";
       export * from "@antithesishq/bombadil/browser/defaults";
       const spinner = extract(s => !!s.document.querySelector("[aria-busy=true]"));
       export const spinnerEnds = always(now(() => spinner.current).implies(eventually(() => !spinner.current)));

   Write rules a user would state ("a result count never shows a negative number", "a loading state always ends", "the selected tab is always one of the visible tabs"). Pass the file as the last argument.
4. Keep the URL boundary on the app (default: same origin). Never point it at production or a logged-in real account: it clicks everything, including delete and send buttons.
5. Cleanup through the verify skill. Evidence stays under the run dir.

## Read the result

- A violation prints the property and the trace path. Reproduce it exactly with `--reproduce <trace-dir>`, then confirm it by hand through the verify skill's drive before calling it a bug.
- `bombadil browser inspect <trace-dir>` opens a viewer in a browser; on this machine view the screenshots in `<trace-dir>/screenshots/` instead.
- WARN lines about quiescence timers are tool noise, not violations.
- Reply: time budget, states explored (lines in `trace.jsonl`), properties checked, each violation with its reproduce command, and what the run could not reach (screens behind auth or native shells).
