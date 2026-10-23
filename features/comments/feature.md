---
name: 댓글 답글
what: 유튜브·인스타·웹사이트 댓글 중 사용자가 고른 것만 읽어 두고, 부탁하면 사용자 말투로 답글 초안을 만들어 사용자가 보내기를 고른 뒤에만 올려요
trigger: 변화 감지
stage: watch
enabled: false
applies_to: orchestrator
setup: when the owner asks to turn on comment replies (유튜브 댓글 자동답장 켜줘, 인스타 댓글 답글 켜줘, 웹사이트 댓글 답글 켜줘), run `bun {repo}/features/comments/bin/onboard.ts on --app youtube` (or `--app instagram`) and relay its summary in one short line. It does everything itself (connection check, source config, tone from the owner's past replies, the `comments` watch, first read) and can be run again to resume. Exit code 3 means only the owner can do the next step (connect the account, or tell the site's read/post method): relay the listed items to him in ONE message and run the same command again after he answers. For a website run `onboard.ts on --app site --name <short name> --read-kind rss|json|script --read <url|command> --post-kind webhook|script --post <url|command> [--secret <file>] [--owner <his name on the site>]`; how a site plugs in is in `docs/comments-api.md`. If the connection is missing and the owner (or his bot) knows where the old YouTube/Instagram tokens are, rerun with `--import-from <file-or-dir>` (repeatable; or `--import-yt <file>` / `--import-ig <file>`): it asks the owner one yes/no, then copies them 0600 and never prints values. After an update the gateway itself makes the app instance (own row, comment view, settings) for every website source already configured (hub/migrations.ts, once per install), so never run `onboard.ts on --app site` again for that; the command stays for turning on a new site.
deny:
  - (>|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i).*\binbox\.jsonl | inbox.jsonl is the gateway's record of the owner's messages (it holds the send approvals); only the gateway writes it
---
처음엔 꺼져 있고, 사용자가 요청해야 켜져요. 켜도 사용자가 고른 채널·글·사이트만 읽고, 고르지 않은 곳은 아무것도 읽지 않아요. 읽기는 스크립트(`bin/watch.ts`)가 하고 모델을 부르지 않아서, 새 댓글이 없으면 토큰이 들지 않아요. 댓글은 웹 모니터링 > 앱의 유튜브·인스타그램·웹사이트 댓글 항목에 글마다 대화로 보여요. 말투는 `~/.dotz/custom/reply-drafts/tone/<출처>.md`에서 배우고, 출처 설정과 받은 댓글은 `~/.dotz/custom/comments/`에 있어요.

- 초안은 사용자가 웹에서 초안을 부탁하거나 채팅에서 `이 댓글 답글 써줘`라고 할 때만 만들어요. 출처마다 따로 켜는 자동 초안(기본 꺼짐)을 켜면 새 댓글마다 초안을 만들고 승인 `[ask]`를 올려요. 모델은 댓글 줄기, 글 제목, 지난 답글 몇 개만 봐서 한 건에 입력 약 4.8천, 출력 약 160 토큰으로 측정됐어요(구독 모델 한 번 호출, 초안마다 `drafts.json`에 기록하고 `bin/comments.ts status`가 평균을 보여 줘요).
- 사용자가 `1) 보내기`를 고르기 전에는 아무것도 올리지 않아요. 같은 댓글에는 한 번만 올라가고, 상태는 보내는 중, 보냄, 실패(이유)로 남아요. 규칙으로 자동 보내기는 사용자가 출처마다 켰을 때만 되고, 그때도 같은 관문을 지나요.
- 댓글 한 건 초안: `bun {repo}/features/comments/bin/comments.ts draft <댓글 id>`가 `[ask]` 블록을 찍으면 그대로 올려요. 댓글 id는 `bin/comments.ts status`나 웹이 알려 줘요.
- `[ask]`에 대한 `결정 답: ... → 1) 보내기`: `bun {repo}/features/comments/bin/comments.ts send <id>`. `→ 2) 고치기 - <내용>`: `comments.ts revise <id> --change "<내용>"`(찍힌 `[ask]`를 그대로 올려요). `→ 3) 보내지 않기`: `comments.ts drop <id>`. `<id>`는 질문 끝 괄호의 초안 id예요. `send`가 거부하면 이유를 그대로 알리고 다시 시도하지 않아요.
- 끄기: `bun {repo}/features/comments/bin/onboard.ts off --app <youtube|instagram|site-이름>`. 읽고 있는 상태 확인: `onboard.ts status`, `comments.ts status`.
- 이어서 할 일: 답글을 올린 뒤(`1) 보내기`로 게시된 때만) 그 앱에 '이어서 할 일' 규칙이 있으면 게이트웨이가 `[followup:<앱>]` 턴을 한 번 보내요. 규칙·댓글 id가 담겨 있어요. 먼저 그 댓글이 규칙의 조건에 맞는지 `comments.ts`로 읽어 보고, 맞지 않으면 아무것도 만들지도 묻지도 않아요. 맞으면 `bun {repo}/hub/mail-cli.ts compose ... --origin comment:<댓글 id>`로 메일 초안(첨부 포함)을 만들어 [ask]로 올리고, 사용자가 `1) 보내기`를 고르면 `mail-cli.ts send --draft <코드>`로 보내요. 자세한 단계는 `features/reply-drafts/feature.md`예요.
