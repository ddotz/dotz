# 유튜브·인스타 채널 관리: 할 일 순서

이 파일은 설정 요청이나 `sns-` 감시 알림이 왔을 때만 읽어요. 기능 소개는 feature.md, 설계는 DESIGN.md에 있어요.

스크립트는 모두 `bun <dotz 체크아웃>/features/youtube-instagram/bin/<이름>.ts`로 실행해요. 데이터는 `~/.dotz/custom/sns/`에 있어요.
감시는 설정(`setup.ts apply`)을 마쳐야 켜져요. 설정 전에 `sns-` 감시가 없는 건 정상이에요.

## 연결 (오너가 "유튜브·인스타 연결해줘" 하면)
묻지 말고 바로 시작해요. 기본값(18:00 게시, 하나씩 승인, 00:00-08:00 조용한 시간, 번역 꺼짐)으로 켜고, 바꾸고 싶으면 나중에 말하면 돼요.
1. 작업 채널을 만들어요(`dotz_channel create`, 제목은 `유튜브·인스타`처럼 평범하게).
2. `onboard.ts run --target ch:<id>`를 실행해요(한쪽만 원하면 `--youtube` 또는 `--instagram`). 진행 상황은 스크립트가 그 채널의 메시지 하나를 계속 고쳐서 보여 줘요. 따로 진행 보고를 쓰지 않아요.
   - 설치(ffmpeg, cloudflared), Google Cloud 프로젝트·OAuth 클라이언트 만들기, 동의 화면, 인스타 프로페셔널 전환, Meta 앱과 토큰 발급, 채널·계정 찾기, 기본값 적용, 시험 읽기, 감시와 카드까지 스크립트가 Aside 백그라운드 탭으로 해요.
   - 인증 코드는 아이메시지(메시지 앱)에서 스크립트가 직접 읽어 넣어요. 오너가 2026-10-22에 그렇게 하라고 했어요. 코드는 출력되지 않아요.
3. 끝나는 코드에 따라:
   - 0: 다 됐어요. `GET /api/custom`에 errors가 없는지 보고 한두 줄로 알려요.
   - 3: 오너 손이 필요한 단계가 있어요. 스크립트가 찍은 요청 블록을 그대로 한 번만 보내요(값이 필요하면 `dotz_auth`, 폰 승인은 `dotz_auth` kind approve). 오너가 답하면 같은 명령을 다시 실행해요. 끝난 단계는 건너뛰어요.
   - 그 밖: 실패한 단계와 이유가 찍혀요. `onboard.ts status`로 어디서 멈췄는지 보고, 고칠 수 있으면 고쳐서 다시 실행해요. 한 단계를 처음부터 다시 하려면 `onboard.ts reset <단계>`예요.
- 중간에 끊겨도(재시작, 타임아웃) `run`을 다시 실행하면 멈춘 단계부터 이어서 해요.
- 구글은 검수 전 API 프로젝트로 올린 영상을 비공개로 잠가요. 그래서 기본값은 유튜브 업로드를 Aside(YouTube Studio)로 하고, 읽기·댓글·통계만 API로 해요.
- 손으로 할 때 쓰는 개별 명령도 남아 있어요: `setup.ts youtube-auth --client <파일>`, `setup.ts instagram-token --from <파일>`, `setup.ts apply ...`, `setup.ts status`.

## 번역 (처음엔 꺼져 있어요)
설정 때 묻지 않아요. 오너가 원할 때만 `setup.ts apply --languages en,ja`로 켜요(하루 한 번 도는 `sns-yt-metadata` 감시가 생겨요). 끄려면 `--languages off`예요. 켜기 전에는 제목과 설명을 기본 언어로만 써요.

## 감시가 깨울 때
출력 한 줄이 항목 하나예요. 말투는 `~/.dotz/custom/sns/tone.md`를 따르고, 비어 있으면 `sns.ts tone-sample`을 한 번 실행해요.
- `[ask] ...`로 시작하는 줄(댓글 답글 초안): `reply-drafts`에서 그 앱(유튜브 또는 인스타)을 켜 둔 상태예요. 감시 스크립트가 이미 초안을 만들고 `sns.ts` 답글 job까지 등록했으니, 이 줄은 고치지 말고 **그대로** 이 채널에 올려요. 직접 초안을 쓰지 않아요.
- `yt-comment <id> video=.. by=..: 글`, `ig-comment <id> media=.. by=..: 글`: 그 앱을 켜지 않았거나 초안을 못 만든 댓글이에요. 오너 말투로 답글 초안을 쓰고 `sns.ts job new`로 등록해요. 광고나 욕설은 건너뛰고 이유만 알려요. 사용자가 "인스타 댓글 답글 켜 줘"처럼 부탁하면 `bun <dotz 체크아웃>/features/reply-drafts/bin/onboard.ts on --app instagram`(유튜브는 `--app youtube`)을 실행해요. 연결이 안 되어 있으면 종료 코드 3과 함께 연결 명령이 찍히니 그 순서대로 해요. 끄려면 `onboard.ts off --app <앱>`이에요.
- `new-video <경로> <초>s <WxH> <vertical|landscape> <ok|too-long|not-vertical>`: `ok`면 기본 언어(번역을 켰다면 설정된 언어도)로 제목, 설명, 태그와 인스타 캡션 초안을 쓰고 올리기 job을 만들어요. `too-long`, `not-vertical`은 오너에게 먼저 알려요.
- `needs-translation <videoId> missing=<언어>: 제목`: 빠진 언어의 제목과 설명을 번역해 메타데이터 job을 만들어요. 원래 설명은 건드리지 않고 언어별 구간만 덧붙여요.
- `posted <jobId> ...`, `failed <jobId> <이유>`, `aside-needed ...`: 프로젝트 채널에 알려요. `aside-needed`는 `aside exec`로 직접 올려요.
- `yt-quota-exhausted until=<시각>`: 유튜브 하루 쿼터를 다 썼어요. "유튜브 하루 쿼터를 다 써서 <시각>에 다시 이어서 해요" 한 줄로만 알려요. 선택 블록은 필요 없어요.
- `yt-comment-overflow ...`: 새 댓글이 너무 많아 오래된 건 목록에서 빠졌다고 알려요.
- `DOTZ_FAIL youtube-auth`, `DOTZ_FAIL instagram-auth`: 로그인이 풀렸어요. `onboard.ts reset youtube-auth`(또는 `instagram-token`) 뒤 `onboard.ts run`으로 다시 연결해요. `DOTZ_FAIL network`는 스크립트가 이미 두 번 참았다는 뜻이니 알려요.

## 승인 규칙 (예외 없음)
- 오너가 OK하기 전에는 아무것도 공개하지 않아요. 자동 게시 모드는 없어요.
- 초안은 MODE.md의 발송 승인 블록(`hub/draft-approval.ts`, `<id>`=jobId, 대상 줄은 `> 대상:`)으로 물어요: `1) 보내기` ← 추천, `2) 고치기`, `3) 보내지 않기`. 웹에서는 알림 종 → 아래 시트에 초안이 보여요. 묶어서(batch) 설정이면 블록 하나에 초안을 모두 담고 1번이 전부 승인이에요.
- `결정 답: ... → 1) 보내기`가 오면 `sns.ts approve <jobId>`를 실행해요. 다음 올리는 시각에 예약되고, 오너가 지금 올리라고 했을 때만 `--at now`를 붙여요. 답글 job은 사용자가 그 job에 `1) 보내기`를 고른 기록이 없으면 `approve`가 거부해요. 거부 이유를 그대로 알리고 다시 시도하지 않아요.
- `2) 고치기 - ...`: 답글이면 `sns.ts revise <jobId> --change "<내용>"`을 실행해요. 고친 내용은 그 앱의 말투 프로필에 기록되고, 옛 job은 취소되고, 새 `[ask]`가 찍히니 그대로 올려요. 그 밖의 job은 고친 뒤 다시 물어요.
- `3) 보내지 않기`는 `sns.ts reject <jobId>`예요.
- 기존 영상의 제목과 설명은 처음 바꾸기 전에 백업돼요. 되돌리기(`sns.ts restore <videoId>`)는 오너가 되돌려 달라고 했을 때만 해요.
- 업로드가 중간에 끊겨도 다시 올리기 전에 이미 올라간 영상을 찾아서, 같은 영상이 두 번 올라가지 않아요.
