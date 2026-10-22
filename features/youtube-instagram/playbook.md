# 유튜브·인스타 채널 관리: 할 일 순서

이 파일은 설정 요청이나 `sns-` 감시 알림이 왔을 때만 읽어요. 기능 소개는 feature.md, 설계는 DESIGN.md에 있어요.

스크립트는 모두 `bun <dotz 체크아웃>/features/youtube-instagram/bin/<이름>.ts`로 실행해요. 데이터는 `~/.dotz/custom/sns/`에 있어요.
감시는 설정(`setup.ts apply`)을 마쳐야 켜져요. 설정 전에 `sns-` 감시가 없는 건 정상이에요.

## 설정 (오너가 "유튜브·인스타 설정해줘" 하면)
1. 한 메시지로 묻고 자유 답변도 받아요. 항목마다 선택 블록(`결정: ...`, `**1) ...** ← 추천`)으로 보여 줘요.
   - 연결할 곳: 유튜브, 인스타, 둘 다
   - 올리는 시각: 18:00 ← 추천
   - 승인: 하나씩(each) ← 추천 / 묶어서(batch)
   - 조용한 시간: 00:00-08:00 ← 추천 / 끄기
2. 로그인은 공식 API 토큰이 먼저예요. 비밀값은 절대 대화나 명령줄에 쓰지 않아요.
   - 유튜브: Google Cloud에서 데스크톱 OAuth 클라이언트를 만들고, `dotz_auth`(kind secret)로 받아 `~/.dotz/secrets/youtube-client.json`에 둬요. `setup.ts youtube-auth --client <그 파일>`을 실행하면 `open <URL>` 한 줄이 나와요. 그 주소를 `aside exec`로 백그라운드 탭에서 열고 동의까지 진행해요(전경 크롬이나 키 입력은 쓰지 않아요). `youtube-connected <채널id> <제목>`이 나오면 끝이에요.
   - 인스타: 프로페셔널(비즈니스·크리에이터) 계정이어야 해요. Meta 앱(Instagram API with Instagram Login, 권한 instagram_business_basic, instagram_business_manage_comments, instagram_business_content_publish) 대시보드의 장기 토큰을 `dotz_auth`로 받아 `setup.ts instagram-token --from <파일>`을 실행해요. `instagram-connected ...`가 나오면 끝이에요.
   - API가 안 되면 Aside 브라우저 로그인으로 넘어가요(채널 `logins`에 studio.youtube.com, instagram.com).
3. 작업 채널을 만들어요(`dotz_channel create`, 제목은 `유튜브·인스타`처럼 평범하게).
4. `setup.ts apply --channel ch:<id>`에 오너 답을 플래그로 넘겨요: `--times 18:00 --approval each --quiet 00:00-08:00` 등. 언어는 묻지 않고 `--languages`도 붙이지 않아요. 한 줄씩 `config`, `card`, `project`, `watch ...`가 나오고 `ok`로 끝나요. `DOTZ_FAIL gateway <상태>`가 나오면 게이트웨이 문제이니 고친 뒤 같은 명령을 다시 실행해요(여러 번 실행해도 안전해요).
5. `GET /api/custom`에 errors가 없는지 확인하고 오너에게 결과를 알려요. `setup.ts status`로 현재 상태를 한눈에 볼 수 있어요.
- 구글은 검수 전 API 프로젝트로 올린 영상을 비공개로 잠가요. 공개로 올리려면 `--youtube-via aside`로 설정하고, 올리는 건 YouTube Studio에서 `aside exec`로 해요.

## 번역 (처음엔 꺼져 있어요)
설정 때 묻지 않아요. 오너가 원할 때만 `setup.ts apply --languages en,ja`로 켜요(하루 한 번 도는 `sns-yt-metadata` 감시가 생겨요). 끄려면 `--languages off`예요. 켜기 전에는 제목과 설명을 기본 언어로만 써요.

## 감시가 깨울 때
출력 한 줄이 항목 하나예요. 말투는 `~/.dotz/custom/sns/tone.md`를 따르고, 비어 있으면 `sns.ts tone-sample`을 한 번 실행해요.
- `yt-comment <id> video=.. by=..: 글`, `ig-comment <id> media=.. by=..: 글`: 오너 말투로 답글 초안을 쓰고 `sns.ts job new`로 등록해요. 광고나 욕설은 건너뛰고 이유만 알려요.
- `new-video <경로> <초>s <WxH> <vertical|landscape> <ok|too-long|not-vertical>`: `ok`면 기본 언어(번역을 켰다면 설정된 언어도)로 제목, 설명, 태그와 인스타 캡션 초안을 쓰고 올리기 job을 만들어요. `too-long`, `not-vertical`은 오너에게 먼저 알려요.
- `needs-translation <videoId> missing=<언어>: 제목`: 빠진 언어의 제목과 설명을 번역해 메타데이터 job을 만들어요. 원래 설명은 건드리지 않고 언어별 구간만 덧붙여요.
- `posted <jobId> ...`, `failed <jobId> <이유>`, `aside-needed ...`: 프로젝트 채널에 알려요. `aside-needed`는 `aside exec`로 직접 올려요.
- `DOTZ_FAIL youtube-auth`, `DOTZ_FAIL instagram-auth`: 로그인이 풀렸어요. 설정 2번을 다시 안내해요. `DOTZ_FAIL network`는 잠깐 기다려 보고, 계속되면 알려요.

## 승인 규칙 (예외 없음)
- 오너가 OK하기 전에는 아무것도 공개하지 않아요. 자동 게시 모드는 없어요.
- 초안은 선택 블록 하나로 보여 줘요: `결정: ...`, `**1) 올리기** ← 추천`, `**2) 고쳐서 올리기**`, `**3) 올리지 않기**`. 묶어서(batch) 설정이면 블록 하나에 초안을 모두 담고 1번이 전부 승인이에요.
- 1번을 고르면 `sns.ts approve <jobId>`를 실행해요. 다음 올리는 시각에 예약되고, 오너가 지금 올리라고 했을 때만 `--at now`를 붙여요. 2번은 고친 뒤 다시 물어요. 3번은 `sns.ts reject <jobId>`예요.
- 기존 영상의 제목과 설명은 처음 바꾸기 전에 백업돼요. 되돌릴 때는 `sns.ts restore <videoId>`예요.
- 하루 유튜브 쿼터 예산을 넘으면 다음 날 이어서 해요. 오류가 아니니 걱정시키지 않아요.
