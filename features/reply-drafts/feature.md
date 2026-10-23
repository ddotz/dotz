---
name: 답장 초안
what: 답장이 필요한 메일과 댓글에 오너 본인 말투로 초안을 만들어 보내기 전에 물어봐요
trigger: 항상(프롬프트)
stage: guard
enabled: false
applies_to: orchestrator
setup: bun {repo}/features/reply-drafts/bin/onboard.ts on --to <asking target>
---
설치마다 켜는 기능이고, 처음엔 꺼져 있어요. 켜면 오너가 실제로 보낸 글에서 말투를 배워 `~/.dotz/custom/reply-drafts/style.md`에 두고, 답장이 필요한 새 메일마다 그 말투로 초안을 만들어 발송 승인 블록(`hub/draft-approval.ts`)으로 물어봐요. 오너가 `1) 보내기`를 고르기 전에는 아무것도 보내지 않아요.

새 메일 초안은 게이트웨이가 알아서 만들어 해당 메일 스레드에 올려요. 그래서 새 메일마다 초안을 직접 쓰지 말고, 이 기능이 올린 `[ask]`에는 아래처럼만 답해요. `<id>`는 질문 끝 괄호의 초안 id예요.
- `결정 답: ... → 1) 보내기`: `bun {repo}/features/reply-drafts/bin/draft.ts send <id>`
- `결정 답: ... → 2) 고치기 - <내용>`: `bun {repo}/features/reply-drafts/bin/draft.ts revise <id> --change "<내용>"`. 찍힌 `[ask]` 블록을 고치지 말고 그대로 같은 스레드에 다시 올려요. 고친 내용은 말투 파일의 `## 고친 점`에 기록돼서 다음 초안부터 따라가요.
- `결정 답: ... → 3) 보내지 않기`: `bun {repo}/features/reply-drafts/bin/draft.ts drop <id>`
- `send`는 오너의 `1) 보내기` 선택이 그 초안 id에 없으면 거부해요. 거부 이유를 그대로 알리고 다시 시도하지 않아요. 이 메일 계정으로 보낼 수 없는 경우(`직접 보내야 해요`)는 초안 글을 알려 주기만 해요.

오너가 이미 있는 메일에 답장 초안을 부탁하면(`이 메일 답장 써줘`): 메일 본문을 stdin으로 넘겨 `bun {repo}/features/reply-drafts/bin/draft.ts new --mail <메일 키> --from <보낸 사람 주소> --subject "<제목>" [--source zele|webmail:<사이트> --id <메일 id>]`를 실행하고, 찍힌 `[ask]` 블록을 그대로 올려요.

댓글 답글 초안은 같은 엔진이에요(`draft.ts new --mail <댓글 키> --kind comment --from <작성자>`, 댓글을 stdin으로). 출력은 답글 글만이고, 승인은 `sns.ts job`이 그대로 맡아요.

말투 다시 배우기·끄기: `onboard.ts learn [--from-file <파일>]`, `onboard.ts off`. 보낸 사람을 제한하려면 `~/.dotz/custom/reply-drafts/config.json`의 `senders.only`·`senders.skip`(주소 또는 `@도메인`)을 고쳐요.
