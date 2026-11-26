---
name: 답장 초안
what: 답장이 필요한 메일과 댓글에 사용자 본인 말투로 초안을 만들어 보내기 전에 물어봐요
trigger: 항상(프롬프트)
stage: guard
enabled: false
applies_to: orchestrator
setup: bun {repo}/features/reply-drafts/bin/onboard.ts on --to <asking target>
---
세션은 메일, 댓글, 카톡 모두 같은 동사 다섯 개로 답장 초안을 다뤄요. 명령은 `bun {repo}/features/reply-drafts/bin/draft.ts <동사> ...`예요. 사용자가 켜 둔 앱의 새 메일·댓글·카톡 초안은 게이트웨이가 알아서 만들어 카드로 올려요. 사용자가 직접 부탁하거나 카드에서 고른 일만 아래 동사로 해요.

**보내기는 동사가 아니에요.** 사용자가 카드에서 `1) 보내기`를 고르면 게이트웨이가 보내요. `draft.ts send`, `mail-cli.ts send`, `comments.ts send`, `zele mail send|reply|forward`는 막혀 있어요. 보내기가 거부되거나 실패하면 게이트웨이가 카드와 `[fail]` 한 줄로 알려요. 다시 보내려 하지 마세요.

**draft**: 초안 하나를 만들어요. 찍힌 `[ask]` 블록은 고치지 말고 그대로 올려요.
- 메일: 메일 본문을 stdin으로 넘겨 `draft --mail <메일 키> --from <보낸 사람 주소> --subject "<제목>"`
- 댓글: `bun {repo}/features/comments/bin/comments.ts draft <댓글 id>`. 댓글 글만 필요하면 `draft --mail <댓글 키> --kind comment --app youtube|instagram --from <작성자>`
- 카톡: 최근 대화를 stdin으로 넘겨 `draft --app kakao --room <방 id> --kind chat`이 답장 글을 찍고, `hub/kakao/cli.ts draft --chat <방 id>`가 그 글로 카드를 만들어요. 종료 코드 3은 답할 게 없다는 뜻이라 조용히 있어요. 4는 사용자가 먼저 정할 일이라 선택지 블록이 찍혀요.

**revise**: 초안 하나를 고쳐요. 카드의 `2) 고치기 - <내용>`은 게이트웨이가 실행하니 명령을 돌리지 말고, 턴에서는 답에 `[revise <id>] <고칠 내용>` 한 줄만 써요.
- 메일: `revise <초안 id> --change "더 짧게"`
- 댓글: `[revise <초안 id>] 존댓말로` (메일은 빼라는 말이면 `comments.ts revise <id> --change "<내용>" --no-mail`)
- 카톡: `[revise <초안 코드>] 반말로`

**drop**: 보내지 않아요. 카드의 `3) 보내지 않기`예요.
- 메일: `drop <초안 id>`
- 댓글: `comments.ts drop <초안 id>`
- 카톡: 할 일이 없어요. 카드가 닫혀요.

**learn**: 사용자가 앞으로도 지킬 말투를 말하면(앞으로, 항상, 절대, 쓰지 마) 말투 파일을 손으로 고치지 말고 이 동사로 남겨요. 정리와 되돌리기도 이 동사예요.
- 메일: `learn --app mail --to <받는 사람 주소> --rule "존댓말로 짧게"`
- 댓글: `learn --app youtube --forbid "무조건"`, 초안을 두고 한 말이면 `learn --draft <초안 id> --change "<고친 내용>"`
- 카톡: `learn --app kakao --room <방 id> --change "반말로"`

**show**: 읽기만 해요. 아무것도 바꾸지 않아요.
- 기다리는 초안: `show`, 한 건은 `show <초안 id>`
- 메일: `show --app mail --effective [--box <메일함 id>]`가 걸린 규칙을 `번호. [범위] 종류 문장 (파일:줄)`로 보여 줘요
- 댓글·카톡: `show --app youtube`, `show --app kakao --room <방 id>`가 그 말투 프로필을 보여 주고, `show --journal`은 제품이 바꾼 줄의 기록이에요

`new`, `correct`, `status`, `tone`은 예전 이름이라 같은 동작으로 이어져요. `replay <초안 id>`는 저장된 초안을 보내지 않고 다시 돌려 보고, `attach`·`detach <초안 id> ...`는 메일 초안의 파일을 바꿔요.

세부는 `features/reply-drafts/playbook.md`에 있어요: 카드에 대한 답, 앱 켜기, 말투 규칙의 범위와 표현 규칙, `--tidy`, 첨부 확인, 이어서 할 일, 새 메일 초안(`mail-cli.ts compose`). 카톡은 `features/kakao/feature.md`, 댓글은 `features/comments/feature.md`, 설계는 `features/reply-drafts/DESIGN.md`를 봐요.
