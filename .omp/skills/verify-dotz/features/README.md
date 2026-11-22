# dotz verification map

The maintained recipes for proving dotz's user-facing behavior. Read this index before driving, then the feature file.

## Baseline preconditions

- A run launched by `scripts/launch.ts $RUN` and passing `scripts/doctor.ts $RUN`. Never drive an instance this run did not start, and never port 7420.
- The Aside app is running with a connected profile (`aside host profiles` shows `connected`). `aside repl` opens tabs there without bringing the app forward.
- No `dotz_local` HttpOnly cookie for `localhost` in that Aside profile (the driver fails with that reason if one exists).

## Driving conventions

- Arrange state only through production routes: a mail arrives with `POST /api/mail` (hub token, as a mail poller posts it), a bot message with `POST /api/send` (hub token, as the bot posts it). Owner actions only through the browser.
- Locate by ARIA role and name (`getByRole('button', { name: '보내기', exact: true })`), never by CSS position.
- Each changed screen is captured after the action, and again cold in a fresh tab at 390 x 844 and 1280 x 900.

## Proof and skip reporting

- UI proof: ARIA tree or snapshot diff plus a PNG, written by the driver under `.omp/verify/runs/<run-id>/<feature>/`, and `checks.log` with each side effect read back from disk (`drafts.json`, `outbound/calls.log`, `network-*.txt`).
- A step that cannot run reports the command tried and the missing precondition. A skipped entry point is never reported as verified through another path.

## Feature entry contract

Each feature file starts with `last-proven: <commit>`, then an H1, one paragraph of user-visible behavior, and exactly four sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with scripts/drive.ts`, `Gotchas`. Its id equals an entry of `.omp/verify/features.json`.

## Features

- [Auto-reply](./auto-reply.md): a received mail's reply draft card, 보내기 with its undo window, the send, and the sent state.
- [App shell](./app-shell.md): the home screen and the five bottom tabs.
