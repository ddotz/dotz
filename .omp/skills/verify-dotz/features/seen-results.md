last-proven: 693c37ad

# Seen results

A session result or 작업내역 notice is read only when its own message was on screen in the open conversation (owner decision 2026-11-23, item N13). Opening the session's conversation, or opening 작업내역 with the row scrolled away, leaves it unread; scrolling the row into view reads it (`POST /api/notices/seen`), and the bell and `GET /api/notices` agree.

## Sub-features

- `lane-open`: opening `#chat/lane:<name>` of the result leaves the notice unread.
- `away`: 작업내역 opens at the bottom with the result row off screen; the notice stays unread.
- `seen`: wheel-scrolling the row into view reads the notice; `GET /api/notices` says `read: true`.

## How to get to it (user POV)

- A session reports a result; the bell shows it unread.
- Open 채팅 → 작업내역 (or the session), scroll up until the result's row is on screen.

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor.

- **Arrange.** `POST /api/send` (hub token) to `worklog` with `update_key: lane:verify-n13` and a `[done]` text, as the assistant posts a session's line; then 40 more 작업내역 lines so the row is far above the bottom. `GET /api/notices` lists the result notice unread (`checks.log`).
- **Lane open.** At 390, `#chat/lane:verify-n13`; the notice is still unread (`lane-open.aria.txt`, `lane-open-390.png`). The run has no session `verify-n13`, so the app falls back to the main chat there: this step only shows that navigating there reads nothing.
- **Away.** `#chat/worklog` opens at the bottom; the row is off screen and the notice unread (`worklog-away.aria.txt`, `worklog-away-390.png`).
- **Seen.** Mouse wheel up until the row is on screen; the notice turns read (`worklog-seen.aria.diff`, `worklog-seen-390.png`, `browser-seen.log`).
- **Cold.** `#chat/worklog` in fresh tabs at 390 and 1280 (`cold-worklog-<w>.*`).
- **Proof.** `bun .omp/skills/verify-dotz/scripts/drive.ts seen-results $RUN` writes `<run>/seen-results/manifest.json`.

## Gotchas

- A `lane_report` comes only from a running session (`hub/lanewire.ts`), which an isolated run does not start, so the drive uses the 작업내역 line of a session (`msg: "worklog"`). The lane-conversation case is covered by `hub/seen-results-web.test.ts`.
- Each notice is sent once per page; a failed call reloads the notice list instead of retrying.
