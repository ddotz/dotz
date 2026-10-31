---
name: 답장 초안
what: 답장이 필요한 메일과 댓글에 사용자 본인 말투로 초안을 만들어 보내기 전에 물어봐요
trigger: 항상(프롬프트)
stage: guard
enabled: false
applies_to: orchestrator
setup: bun {repo}/features/reply-drafts/bin/onboard.ts on --to <asking target>
---
설치마다 켜는 기능이고, 처음엔 꺼져 있어요. 사용자가 직접 켠 모니터링(zele 메일, 웹메일 사이트, 유튜브·인스타 연결)에는 따로 켜지 않아도 새 항목마다 초안을 먼저 제안해요. `onboard.ts off [--app <앱>]`으로 끄면 그 결정이 우선해요. 켜면 사용자가 실제로 보낸 글에서 말투를 배워 `~/.dotz/custom/reply-drafts/tone/`에 두고(앱마다 `<앱>.md`, 메신저는 대화방마다 `<앱>/<방>.md`, 없으면 `install.md`), 답장이 필요한 새 메일마다 그 말투로 초안을 만들어 발송 승인 블록(`hub/draft-approval.ts`)으로 물어봐요. 사용자가 `1) 보내기`를 고르기 전에는 아무것도 보내지 않아요. 처음 쓸 때 한 번, 보낸 메일(카톡은 그 방, 유튜브·인스타는 지난 답글)을 최대 200개까지 읽어 문체와 성격을 `## 정체성`으로, 자주 오는 상황별 답장을 사용자 본인 문장으로 `## 답장 틀`로 정리하고, 초안은 그 사람으로서 써요. 고치기가 5번 쌓일 때마다 정체성과 답장 틀을 다시 다듬어요.

새 메일 초안은 게이트웨이가 알아서 만들어 해당 메일 스레드에 올려요. 그래서 새 메일마다 초안을 직접 쓰지 말고, 이 기능이 올린 `[ask]`에는 아래처럼만 답해요. `<id>`는 질문 끝 괄호의 초안 id예요.
- `결정 답: ... → 1) 보내기`: `bun {repo}/features/reply-drafts/bin/draft.ts send <id>`. 메일이 그 사이 새 답을 받았으면 보내지 못하고 초안이 낡았다고 알려요. 그러면 `draft.ts new`로 다시 초안을 만들어요.
- `결정 답: ... → 2) 고치기 - <내용>`: `bun {repo}/features/reply-drafts/bin/draft.ts revise <id> --change "<내용>"`. 찍힌 `[ask]` 블록을 고치지 말고 그대로 같은 스레드에 다시 올려요. 고친 내용은 그 초안의 말투 프로필(대화방이 있으면 그 방, 아니면 앱)의 `## 고친 점`에 기록돼서 다음 초안부터 따라가요.
- `결정 답: ... → 3) 보내지 않기`: `bun {repo}/features/reply-drafts/bin/draft.ts drop <id>`
- 게이트웨이가 아는 초안(질문 끝 괄호가 이 초안 id인 카드)에 고른 `1) 보내기`는 게이트웨이가 직접 `draft.ts send`로 보내고 턴으로 오지 않아요. 초안이 여러 건이면 카드를 모두 한 번에 올리고 턴을 끝내요(게이트웨이가 한 장씩 보여 주고 웹은 많으면 빠른 처리 화면을 열어요).
- `send`는 사용자의 `1) 보내기` 선택이 그 초안 id에 없으면 거부해요. 거부 이유를 그대로 알리고 다시 시도하지 않아요. 이 메일 계정으로 보낼 수 없는 경우(`직접 보내야 해요`)는 초안 글을 알려 주기만 해요.

사용자가 이미 있는 메일에 답장 초안을 부탁하면(`이 메일 답장 써줘`): 메일 본문을 stdin으로 넘겨 `bun {repo}/features/reply-drafts/bin/draft.ts new --mail <메일 키> --from <보낸 사람 주소> --subject "<제목>" [--app mail] [--source zele|webmail:<사이트> --id <메일 id>]`를 실행하고, 찍힌 `[ask]` 블록을 그대로 올려요.

유튜브·인스타 댓글 답글도 같은 엔진이고, 앱마다 따로 켜요. 처음엔 모두 꺼져 있어요. 사용자가 "인스타 댓글 답글 켜 줘"처럼 부탁하면 `bun {repo}/features/reply-drafts/bin/onboard.ts on --app instagram`(유튜브는 `--app youtube`, 끄기는 `off --app <앱>`)을 실행해요. 유튜브·인스타 연결이 안 되어 있으면 종료 코드 3과 연결 명령이 찍히고 아무것도 켜지지 않아요. 켜면 그 플랫폼에 사용자가 쓴 지난 답글로 `tone/youtube.md`·`tone/instagram.md`를 따로 배워요.
켜 둔 앱은 `sns-` 댓글 감시가 새 댓글마다 초안과 `sns.ts` 답글 job을 만들고 `[ask]`를 직접 내보내요(`features/youtube-instagram/playbook.md`). 그 `[ask]`는 고치지 말고 그대로 올려요. `1) 보내기`는 `sns.ts approve <jobId>`, `2) 고치기 - ...`는 `sns.ts revise <jobId> --change "<내용>"`, `3) 보내지 않기`는 `sns.ts reject <jobId>`예요. `approve`는 그 job에 `1) 보내기`를 고른 기록이 없으면 거부해요. 꺼 둔 앱의 댓글은 예전처럼 줄 그대로 와요. 댓글 한 건만 손으로 부탁받으면 `draft.ts new --mail <댓글 키> --kind comment --app youtube|instagram --from <작성자>`(댓글을 stdin으로)가 답글 글만 찍어요.

카톡 대화방 답장도 같은 엔진이에요(`draft.ts new --app kakao --room <방 id> --kind chat`, 최근 대화를 stdin으로). 출력은 답장 글만이고 `features/kakao/feature.md`가 이어서 맡아요. 그 방의 말투 프로필이 비어 있으면 그 방에서 사용자가 보낸 말로 처음 한 번 배워요. 방마다 말투가 따로예요. 받은 말이 사용자만 정할 수 있는 일(할지 말지, 어느 쪽, 날짜, 취소 여부)이면 같은 모델 호출이 초안 대신 선택지를 돌려줘요. 그때 종료 코드는 4이고, stdout에 `결정: <질문>`과 `**n) 선택지**` 줄(마지막은 `직접 쓸게 …`)이 찍혀요. 이 블록을 고치지 말고 `[ask]`로 올리고, 사용자가 고르면 같은 명령을 `--choice "<고른 글>"`을 붙여 다시 실행해요(stdin도 같게). 그러면 그 선택대로 쓴 답장이 찍혀요(종료 코드 0). `직접 쓸게 - <글>`이면 그 글이 답장이에요. 웹의 답장 초안 카드는 같은 선택지를 버튼으로 보여 줘요. 카톡 답장을 고쳤을 때는 `draft.ts correct --app kakao --room <방 id> --change "<내용>"`으로 그 방 프로필에 기록해요.

말투 다시 배우기·끄기: `onboard.ts learn [--app <앱|install>] [--room <방 id>] [--from-file <파일>]`, `onboard.ts off`. 보낸 사람을 제한하려면 `~/.dotz/custom/reply-drafts/config.json`의 `senders.only`·`senders.skip`(주소 또는 `@도메인`)을 고쳐요.

새 메일 초안(답할 메일이 없는 메일): `bun {repo}/hub/mail-cli.ts compose --app <메일 앱> --to <주소> --subject "<제목>" [--attach <경로>]... [--from-library <키워드>] [--origin comment|mail|kakao:<id>]`를 실행하고 본문은 stdin으로 넘겨요. 파일을 붙여 두고 초안을 기록한 뒤 받는이·제목·첨부·본문·보내기/고치기/보내지 않기 블록을 찍으니 그대로 [ask]로 올려요. `결정 답: ... → 1) 보내기`일 때만 `bun {repo}/hub/mail-cli.ts send --draft <코드>`로 보내요. 고치기와 보내지 않기는 위의 `draft.ts revise`·`drop`과 같아요. 웹 메일 앱에는 답장 초안처럼 '메일 초안' 항목으로 보여요.

답글과 메일을 한 장으로: 댓글 답글 초안이 이미 있고 메일이 필요한 게 분명하면(댓글이 파일을 달라고 하고 주소를 적음) `mail-cli.ts compose ... --with-comment <댓글 초안 id>`를 써요. 메일은 별도 [ask] 없이 그 댓글 카드 안에 '함께 보낼 메일'(받는이, 제목, 첨부, 본문)로 붙고, 사용자의 `1) 보내기` 한 번이 `features/comments/bin/comments.ts send <초안 id>`로 답글을 올린 뒤 메일을 보내요(메일이 실패해도 올린 답글은 그대로고 실패를 알려요). 이 메일은 `mail-cli.ts send`·`draft.ts send`로 따로 보내지지 않고, 메일만 다시 물을 때는 `mail-cli.ts ask --draft <메일 초안 id>`예요. 단계 전체는 `features/comments/feature.md`예요.

이어서 할 일: 앱 설정의 '이어서 할 일'(자유 글)이 있는 앱에서 승인한 일(댓글 답글 게시, 메일 답장 발송, 카톡 발송)이 끝나면 게이트웨이가 한 번만 `[followup:<앱>]` 턴을 보내요. 규칙이 없으면 턴도 모델 호출도 없어요. 봇은 (1) 규칙의 조건에 맞는지 먼저 봐요. 예: 규칙이 '악보를 달라는 댓글이고 메일 주소를 적었으면 악보를 메일로 보낸다'일 때 댓글에 파일 요청과 주소가 없으면 초안도 질문도 없이 조용히 끝내요. (2) 맞으면 `mail-cli.ts compose --origin comment:<댓글 id>`로 초안을 만들어 [ask]로 올려요. 카드에 '댓글 답글에 이어서'와 댓글 링크가 보여요. (3) 사용자가 `1) 보내기`를 고른 뒤에만 `mail-cli.ts send`로 보내요. 이어서 만든 초안을 보내도 또 이어서 할 일이 시작되지는 않아요.
