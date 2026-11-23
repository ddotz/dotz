last-proven: 693c37ad

# App shell

The web app opens on 홈 for a logged-in owner, with the instance name, 답변 필요, the home cards and a bottom (phone) or side (desktop) navigation of 홈, 채팅, 앱, 설정. Each tab changes the screen title and the address hash.

## Sub-features

- `home`: a cold open renders the home screen with the instance name at 390 and 1280 px.
- `tabs`: 채팅 → `#chat/main` (title is the instance name), 앱 → `#monitoring` (title 앱; the address keeps the screen's id), 설정 → `#settings`, 홈 → `#home`.
- `login-gate`: without the owner cookie the page is the 로그인 screen and `/api/state` is 403 (checked by doctor).

## How to get to it (user POV)

- Open the web app address.
- Tap the tabs in navigation `메뉴`.

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor.

- **Cold home.** Fresh tabs at 390 x 844 and 1280 x 900 on `/`; text `verify` appears (`cold-home-<w>.aria.txt`, `cold-home-<w>.png`).
- **Tabs.** At 390, click each button of navigation `메뉴`; the hash and the `h1` match the list above (`nav.log`, `nav-home-390.png`).
- **Proof.** `bun .omp/skills/verify-dotz/scripts/drive.ts app-shell $RUN` writes `<run>/app-shell/manifest.json`.

## Gotchas

- The 채팅 screen's title is the instance name (`verify`), not 채팅.
- 설정 pages that start external flows (계정 연결, 웹 접속, 업데이트) are not part of this recipe; their binaries are stubs in the run, so they fail rather than act.
- The account card says 계정을 연결해야 답할 수 있어요 because the run has no model account; that is the expected seed state.
- Known failure found by bombadil on 2026-11-19 at 44a0f30d: `web/custom.js` declares `const CSS` (its style text) inside its closure, which shadows `window.CSS`, so `reveal()` after adding a home card throws `Uncaught TypeError: CSS.escape is not a function` (custom.js:512) and the new card is not scrolled to or focused. Not driven by this recipe; bombadil reports it as a `noUncaughtExceptions` violation until it is fixed.
