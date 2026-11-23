last-proven: 693c37ad

# Comments mail app

In a comment app's 지켜볼 글 sheet (모니터링 → 유튜브 → 지켜볼 글 고르기), each source has a 메일 앱 choice beside 파일 요청 메일 초안. The choice lists the connected mail apps and saves the pick as the source's `mailApp` (`PUT /api/comments/sources/<key>`); the linked mail draft for a file request is written by that app. While no mail app is connected the choice is disabled and the sheet says 연결된 메일 앱이 없어요.

## Sub-features

- `disabled-hint`: no connected mail app: the choice is disabled and the hint is shown.
- `pick`: the choice lists 없음 and each connected mail app; a pick is saved at once and shown on the button.
- `persist`: the pick is in `custom/comments/config.json` and shows again when the sheet is opened cold.

## How to get to it (user POV)

- Bottom tab 모니터링 → 앱 → 유튜브 → 지켜볼 글 고르기 → sheet 지켜볼 글 → 메일 앱.

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor (`--tree worktree`, or `--tree head` once committed).

- **Arrange.** The driver writes the owner's own config files: `custom/sns/config.json` (turns the YouTube app on) and `custom/comments/config.json` (one source with `watch: []`, `autoMail: true`, no `mailApp`), so nothing polls out. `/api/integrations` then lists no mail app. Later it writes `custom/apps.json` with the mail instance `mail-work` (label 회사 메일).
- **None.** Click 유튜브, 지켜볼 글 고르기. Button `메일 앱: 없음` is disabled and the text 연결된 메일 앱이 없어요 shows (`sheet-none.aria.txt`, `sheet-none-390.png`).
- **Pick.** With the mail instance present: click `메일 앱: 없음`, then option 회사 메일; the button reads `메일 앱: 회사 메일` (`menu-open.aria.diff`, `sheet-after.aria.diff`, `sheet-after-390.png`). Read back: the source in `custom/comments/config.json` has `mailApp: "mail-work"` and `autoMail: true`; no `zele` send in `outbound/calls.log` (checked in `checks.log`).
- **Cold.** Fresh tabs at 390 and 1280 open the sheet and show `메일 앱: 회사 메일` (`cold-sheet-<w>.png`).

## Gotchas

- The sheet opens only for a source of the app; without `custom/sns/config.json#youtube` the YouTube app is not listed.
- A deleted-or-disconnected mail app is not offered; a saved `mailApp` that is no longer connected is still shown by its id and can be cleared with 없음 only while another mail app is connected.
