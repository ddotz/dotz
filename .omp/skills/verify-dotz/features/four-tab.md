last-proven: pending

# Four tabs

The web app has four tabs: 홈, 채팅, 앱, 설정. Projects live in the 채팅 list (a project row, its sessions under it, `+ 새 프로젝트` in the section header) and a project's overview opens inside its chat as 현황. The 앱 tab is the `monitoring` screen: 승인 대기 first, then the apps (mail, KakaoTalk, comments and the owner's own web apps, pinned ones first), then 모니터링. Addresses of the old tabs keep working.

## Sub-features

- `addresses`: `#projects` opens the chat list; `#project/builtin:custom` opens `#custom` under 설정; `#monitoring/replies` opens 승인 대기; `#apps` opens the 앱 tab list; `#apps/<id>` opens that web app at `#monitoring/x:<id>`; `#apps/<missing>` shows the list with no pane.
- `apps`: 승인 대기 is the first row also with nothing waiting; a web app opens in the pane right of the list (1280) or full width (390); 상단 고정 in its ⋯ menu puts it first, a reload keeps it, 고정 해제 puts it back.
- `create`: `+ 새 프로젝트` refuses an empty name in the sheet, makes a web-only project (`ch:<n>`, Discord is off in a run) and opens its chat; the same name again is refused in the sheet.
- `panel`: 현황 in the chat head opens the overview beside the conversation without touching the composer's draft; `#project/<key>` opened cold is that chat with the panel; on a phone 뒤로 from 현황 returns to 대화.
- `delete`: ⋯ → 프로젝트 삭제 in the chat head removes the project and lands on the main chat.

## How to get to it (user POV)

- 채팅 tab: the 프로젝트 section of the list, its `새 프로젝트` button, a project row, then 현황 in the conversation head (a `대화 | 현황` switch on a phone) and ⋯ for 프로젝트 삭제.
- 앱 tab: the list; a web app row; its ⋯ menu (`앱 메뉴`).
- Old addresses: typed into the address bar or kept in a bookmark or notification.

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor.

- **Arrange.** The driver starts a stand-in web page on a loopback port and writes `<data>/custom/apps/verify-tool/app.json` (the owner's own manifest file) pointing at it; `GET /api/apps` must list it running.
- **Addresses.** Each old address is opened cold at 390 and 1280; the settled hash and the lit tab go to `addresses.log`, one PNG per address.
- **Apps.** At 1280 the web app row is clicked, the frame's text is read, 상단 고정 and 고정 해제 are picked from `앱 메뉴` with a reload between (`apps.log`, `apps-*.png`); at 390 the first row is 승인 대기 and the web app fills the screen.
- **Create.** At 390: 새 프로젝트, 만들기 with no name, then a name and a purpose. The driver reads `<data>/channels.json` and `<data>/projects.json` back (`create.log`, `project-*.png`).
- **Panel.** At 1280 a draft is typed, 현황 is toggled twice and the draft is read back; `#project/<key>` is opened cold at 390 and 1280 (`panel.log`, `panel-*.png`).
- **Delete.** ⋯ → 프로젝트 삭제 → 삭제; the driver checks both files no longer hold the key (`delete.log`).
- **Proof.** `bun .omp/skills/verify-dotz/scripts/drive.ts four-tab $RUN` writes `<run>/four-tab/manifest.json`.

## Gotchas

- A run has no model account and no orchestrator: no session can be started, so a project's nested session rows and the fold row are not driven here. `hub/chat-tree-web.test.ts` covers them against a fake hub.
- Discord is off in a run, so a new project is a web-only channel with a small number (`ch:1`); the Discord note in the sheet is not shown.
- The driver's stand-in web app is a child process of the driver, not of the run; it listens on 127.0.0.1 only and dies with the driver.
- `#apps/<missing>` keeps the address `#monitoring/x:<missing>` while the list shows: the same as any 앱 tab item that no longer exists.
- 승인 대기 with replies waiting, mail and KakaoTalk rows are the auto-reply recipe's ground, not this one's.
