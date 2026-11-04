# 기능 목록: 실제 제품에 있는 것과 시제품 위치

이 문서는 dotz 제품이 지금 하는 일과 출력 형식을 한곳에 모았어요. 시제품(`site/prototype/`)이 각 항목을 어디서 보여 주는지 같이 적었어요.

- **출처 파일**은 실제 제품 소스예요(`web/js`, `web/css`, `hub`, `docs`, `features`, `MODE.ko.md`의 절 이름).
- **프로토타입 위치**는 화면 주소(해시)예요. 주소창에 `site/prototype/index.html#chat/formats`처럼 붙이면 열려요. 시제품에 그려져 있지 않으면 **없음**이라고 적었어요.
- 시제품의 모든 route는 `#index`(화면 목록)에 있어요.

## 채팅 출력 형식

봇이 채팅, 알림, 작업 기록에 쓰는 글의 모양이에요. 한 화면에서 전부 보려면 `#chat/formats`를 보세요.

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 채팅 답 | 2-4문장, 답 먼저, 글머리표 없는 대화체 | MODE.ko.md (Message layout), web/js/02-basic-markdown.js | `#chat/main`, `#chat/formats` |
| `[done]` 완료 보고 | 결과 한 줄 + 글머리표 3-4개 + 근거 | MODE.ko.md (Reporting), web/js/11-resultcard.js | `#chat/formats` |
| `[run]` 진행 보고 | 도는 일과 끝난 일을 알리는 보고 | MODE.ko.md (Reporting) | `#chat/formats` |
| `[ask]` 확인 요청 | 오너의 답이 필요한 보고, 결정 블록과 함께 옴 | MODE.ko.md (Reporting), web/js/10-decision-card.js | `#chat/formats`, `#chat/ch2` |
| `[fail]` 실패 보고 | 원인 / 다음 줄이 붙는 실패 알림 | MODE.ko.md (Reporting) | `#chat/formats` |
| 세션 보고 4줄 | 결과 · 결정 · 글머리표 · `For <봇>:` 줄 | MODE.ko.md (Reporting) | `#chat/formats`, `#chat/lane` |
| 결정(선택지) 블록 | `결정: <질문>` 아래 선택지 2-4개, 내 선택에 `← 추천` | web/js/10-decision-card.js, MODE.ko.md (Message layout) | `#chat/ch2`, `#chat/formats` |
| 이유 선택지 (` …`) | 이름 끝에 ` …`가 붙은 선택지는 누르면 이유를 적는 칸이 열려요 | web/js/10-decision-card.js (DETAIL_MARK), hub/draft-approval.ts | `#chat/ch2`, `#chat/formats` |
| 발송 승인 | 보내기 전 `> 받는이/제목/본문` 인용 + `1) 보내기 2) 고치기 3) 보내지 않기` | hub/draft-approval.ts, web/js/10-reply-card.js | `#chat/approve`, `#chat/formats` |
| 목록 블록 | ```` ```목록 ```` 안에 `제목 \| 부제 \| 시각 \| 배지` 줄, 첫 줄 `# 제목`은 선택 | hub/listblock.ts | `#chat/formats` |
| `[file]` 첨부 칩 | `[file] /절대/경로` 한 줄이 파일 칩이 돼요 | MODE.ko.md (Reporting), web/css/04-files.css | `#chat/formats`, `#briefing`, `#tasks` |
| 진행 메시지 | 긴 작업 중 같은 메시지가 제자리에서 바뀌고, 답이 오면 사라져요 | MODE.ko.md (Reporting), web/js/41-runstate.js | `#chat/formats` |
| 가격 변경 표시 | 이전 값은 회색 취소선, `→` 새 값 | web/js/11-watchtext.js, hub/watchtext.ts | `#chat/formats`, `#chat/alert`, `#watch/price` |
| 결과 카드 | 메일, 감시, 예약 결과를 머리글 · 제목 · 요약으로 그린 카드 | web/js/11-resultcard.js | `#briefing`, `#chat/formats` |
| 코드·명령 블록 | 펜스 블록을 고정폭으로 그려요 | web/js/35-code-blocks.js | `#chat/formats` |
| 코드 블록 복사 / 터미널에서 실행 | 블록마다 복사 버튼, 셸 명령에는 "터미널에서 실행" | web/js/35-code-blocks.js | 없음 |
| 인용 답장 | 메시지를 인용해서 다음 메시지에 붙여요 | web/js/39-reply.js | `#chat/main` |
| 슬래시 명령 | 입력창에 `/`를 치면 뜨는 디스코드식 명령 메뉴 | web/js/14-slash-commands.js | `#chat/main` (명령 4개만: /status /usage /model /new, 인자 입력은 없어요) |
| 입력 중 표시 | 답을 쓰는 동안 "쓰고 있어요" 줄 | web/js/41-runstate.js | `#chat/main` |

## 홈

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 홈 상태 카드 | 답변 필요 · 알림 · 진행 중 · 최근 끝난 작업 · 아침 점검 · 모니터링 · 작업내역 · 사용량 카드 | web/js/08-home.js | `#home` |
| 답변 필요 | 내가 아직 안 본 끝난 일과 답을 기다리는 일을 모아 줘요 | web/js/09-needs-you.js, web/js/30-notices.js | `#home` |
| 경고 줄 | 세션 밖에서 오너가 필요한 실패(로그인 풀림 등) | hub/alert-gate.ts, MODE.ko.md (Reporting) | `#home`, `#chat/alert` |
| 아침 브리핑 | 일정 · 메일 · 감시를 묶은 아침 점검 카드와 원문 | web/js/11-resultcard.js, web/js/08-home.js | `#briefing`, `#home` |
| 백그라운드 작업 카드 | 맡긴 작업의 진행 중 / 끝남, 끝나면 파일 칩이 붙어요 | web/js/06-subagents.js, web/js/08-home.js | `#tasks`, `#home` |
| 사용량 카드 | 5시간 · 7일 한도를 막대로 | web/js/37-api-budget.js, hub/usage-account.ts | `#home` |
| 홈 보드 배치 | 카드를 12칸 격자에서 끌어서 옮기고 크기를 바꿔요 | web/js/07-board.js | 없음 |
| 카드 추가 폼 (시안: 새 폼) | 미리보기를 주인공으로, 제목 · 보기 · 내용만 먼저 보이고 나머지는 더 보기에 | web/custom.js (cardForm), web/css/03-base.css (.fi, .tf) | `#form`, `#form/filled`, `#form/more`, `#form/settings` |
| 검색 (명령 팔레트) | 화면 이름이나 `/명령`으로 바로 가요 | web/js/05-command-palette.js | `#palette` |

## 채팅

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 대화 목록 | 카카오톡식 목록, 안 읽음 수, 읽은 위치 | web/js/31-conversations.js | `#chat` |
| 대화 전환 칩 | 헤더에서 대화방(봇 · 채널 · 세션)을 바꿔요 | web/js/16-target-switcher-conversation.js | `#chat/main`, `#chat/ch1` |
| 대화 / 터미널 전환 | 같은 세션을 대화 또는 터미널로 봐요 | web/js/16-target-switcher-conversation.js | `#chat/lane`, `#chat/terminal` |
| 터미널 보기 | 세션 기록을 명령 · 출력 줄로 보여 줘요 | web/js/12-terminal-view.js | `#chat/terminal` |
| 웹 셸 | 이 컴퓨터의 진짜 터미널(xterm) | web/js/36-shell.js | 없음 |
| 할 일 줄 | 입력창 위 한 줄에 지금 단계와 `n/m`, 눌러서 펼쳐요 | web/js/11-todo-strip.js, hub/todo.ts | `#chat/ch1` |
| 실행 상태 줄 | 입력창 위 한 줄로 에이전트가 하는 일을 알려요 | web/js/41-runstate.js | `#chat/ch1` |
| 봇 멈춤 상태 줄 | 한도나 로그인 때문에 봇이 멈췄을 때 입력창 위 한 줄 | web/js/40-orch-error.js | 없음 |
| 결정 카드 | 오너 답을 기다리는 질문이 입력창 위에 붙어요 | web/js/10-decision-card.js | `#chat/ch2` |
| 알림 대화 | 밖에서 오너가 필요한 일이 쌓이는 방 | MODE.ko.md (Reporting), web/js/30-notices.js | `#chat/alert` |
| 작업 기록 | 오너가 안 보는 동안 일어난 일, 세션마다 항목 하나 | MODE.ko.md (Reporting) | `#chat/worklog` |
| 파일 첨부 | + 버튼, 끌어놓기, 붙여넣기로 파일을 같이 보내요 | web/js/15-attachments.js | `#chat/main` (+ 버튼과 첨부 칩만) |
| 캔버스 | 봇이 만든 HTML 페이지를 파일 칩에서 열어요 | web/js/30-canvas.js | `#canvas` |
| 연결 상태 줄 | 연결이 끊기면 헤더에 "다시 연결하는 중" | web/js/17-state-refresh.js | 없음 |
| 뒤로가기 레이어 | 시트, 대화창, 화면을 브라우저 뒤로가기로 닫아요 | web/js/32-history-nav.js | 없음 |

## 프로젝트·세션

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 프로젝트 목록 | 프로젝트 고정 · 상태 한눈에 | web/js/19-project-main.js, web/css/20-projects.css | `#projects` |
| 프로젝트 상세 | 목적, 단계 진행 막대, 단계 체크 | web/js/19-project-main.js, web/js/28-harness-project.js | `#project/hdocs`, `#project/landing`, `#project/release`, `#project/pricing` |
| 세션과 채널 | 세션 목록, 프로젝트의 작업 채널, 홈 채널(알림, 작업 기록) | web/js/18-lanes.js, MODE.ko.md (Chat is the hub; work channels; threads) | `#sessions` |
| 세션 보고 대화 | 세션의 마지막 보고와 대화 링크 | web/js/18-lanes.js | `#chat/lane` |
| 서브에이전트 진행 | 출처별로 서브에이전트가 도는 모습을 실시간으로 | web/js/06-subagents.js | 없음 |

## 모니터링

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 모니터링 목록 | 앱 · 감시 · 예약 · 답장 확인 · 다른 컴퓨터를 한 목록에 | web/js/30-monitoring.js, web/js/30-integrations.js, web/css/20-monitoring.css | `#monitoring` |
| 감시 상세 (가격) | 가격 변경(취소선 → 새 값), 확인 주기, 확인 기록, 지금 확인 | web/js/30-monitoring.js, web/js/11-watchtext.js, hub/watch.ts | `#watch/price` |
| 감시 상세 (변화 없음) | 바뀐 곳 없음 상태 | hub/watchsummary.ts, web/js/11-watchtext.js | `#watch/page` |
| 예약 작업 | 정해진 시각에 도는 작업의 상세 | web/js/30-monitoring.js, MODE.ko.md (Monitoring (dotz_watch)) | `#schedule/briefing` |
| 답장 확인 | 보내기를 기다리는 모든 초안을 한 목록에 | web/js/30-replies.js | `#replies` |
| 빠른 처리 | 승인 대기가 쌓이면(기본 3개 넘게) 하나씩 빠르게 답해요 | web/js/30-triage.js, hub/approval-wire.ts, docs/layers.md | `#triage` |
| 유튜브 댓글 | 게시물마다 댓글과 답글 초안 | web/js/30-monitoring-comments.js, docs/comments-api.md, features/comments | `#comments` |
| 인스타그램 댓글 | 게시물마다 댓글과 답글 초안 | web/js/30-monitoring-comments.js, docs/youtube-instagram.md | `#comments/instagram` |
| 웹사이트 댓글 | 사이트 댓글과 답글 초안 | web/js/30-monitoring-comments.js, features/comments | `#comments/website` |
| 인스타그램 DM | DM 목록과 메시지, 읽기만 | web/js/30-monitoring-comments-dm.js, docs/ig-dm-api.md | `#comments/dm` |
| 카카오톡 방 | 지켜볼 방 고르기, 미답장 · 안 읽음 | web/js/30-kakao.js, docs/kakao-rooms-api.md, features/kakao | `#kakao` |
| 카카오톡 방 대화 | 말풍선 + 답장 초안 카드 | web/js/30-kakao.js, web/css/17-kakao.css | `#kakao/r1` |
| 앱 | 기본 모니터링 앱과 내 앱 | web/js/30-apps.js, hub/user-apps.ts | `#apps` |
| 앱 추가 시트 | 아래에서 올라오는 시트에서 앱을 골라 더해요 | web/js/30-apps.js, docs/custom-apps.md | `#apps/add` |
| 요소 고르기 | 앱 화면의 요소를 눌러 메시지에 같이 보내요 | web/js/15-picker.js | `#app/memo` |
| 앱 설정 대화 | 바꿀 값을 확인받고 적용하는 설정 대화 | web/js/32-app-settings.js, web/css/18-app-settings.css | `#apps/settings` |
| 컴퓨터 (peers) | 내 컴퓨터들과 상태, 안 본 것 수 | web/js/33-peers.js, hub/peers.ts | `#peers` |
| 다른 컴퓨터의 모니터링 | 다른 게이트웨이의 감시와 초안을 이 화면에 | web/js/34-peer-monitoring.js, docs/peer-monitoring.md | `#peers` |

## 메일

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 받은 편지함 | 읽음 · 안 읽음 · 별표 목록 | web/js/30-mail-box.js, web/css/20-mail-box.css | `#mail` |
| 보낸 편지함 | 보낸 메일 목록 | web/js/30-mail-sent.js | `#mail/sent` |
| 메일 선택 → 보관 · 삭제 | 여러 통을 골라 한 번에 | web/js/30-mail-box.js | `#mail` |
| 삭제 후 실행 취소 | 휴지통으로 옮긴 뒤 토스트의 "실행 취소"로 되돌려요 | web/js/30-mail-box.js | `#mail`, `#mail/1` |
| 메일 상세 | 보낸 사람, 한 줄 요약, 본문, 첨부, 별표 · 보관 · 삭제 | web/js/11-mailtext.js, web/js/30-mail-thread.js | `#mail/1`, `#mail/2`, `#mail/3`, `#mail/4`, `#mail/5`, `#mail/6` |
| 메일 원문 HTML | 샌드박스 프레임에 안전하게 줄인 HTML 본문 | web/js/11-mailbody.js, hub/mailhtml.ts | 없음 |
| 같은 사람의 메일 | 같은 보낸 사람의 메일 줄 | web/js/30-mail-thread.js, web/css/20-mail-thread.css | `#mail/1` |
| 보낸 답장 접기 | 보낸 뒤의 답장 초안을 그 메일 안에 접어 둬요 | web/js/30-mail-sent.js | `#mail/1` |
| 메일 쓰기 | 새 메일을 쓰고 보내면 "보냈어요" | web/js/30-mail-box.js | `#mail/compose` |
| 참조(CC) 표시 | 받는 사람 · 참조를 따로 보여 줘요 | web/js/30-mail-thread.js | 없음 |
| 메일 목록의 확인 대기 | 목록 안에 답장 초안 카드를 같이 | web/js/30-monitoring.js (draftCardNode) | 없음 |

## 답장 초안

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 답장 초안 카드 (공통) | 받는이, 초안, 보내기 · 고치기 · 보내지 않기, 처리 뒤 되돌리기 | web/js/10-reply-card.js, web/css/15-reply-card.css, features/reply-drafts, hub/reply-draft.ts | `#replies`, `#chat/approve` |
| 메일 답장 초안 | 제목 + 본문 초안 | web/js/10-reply-card.js, features/webmail-no-api | `#mail/1`, `#mail/3` |
| 카카오톡 답장 초안 | 대화방 + 초안 | web/js/10-reply-card.js, features/kakao | `#kakao/r1` |
| 댓글 답글 초안 (유튜브) | 댓글마다 초안 | web/js/10-reply-card.js, features/comments | `#comments` |
| 댓글 답글 초안 (인스타그램) | 댓글마다 초안 | web/js/10-reply-card.js, features/youtube-instagram | `#comments/instagram` |
| 댓글 답글 초안 (웹사이트) | 댓글마다 초안 | web/js/10-reply-card.js, features/comments | `#comments/website` |
| DM 답장 초안 | DM은 읽기만 하고 답장은 채팅에서 승인 | docs/ig-dm-api.md | `#comments/dm` (읽기만 있어요) |
| 고친 뒤 다시 확인 | 고치기 → 텍스트 수정 → 다시 확인하면 다시 물어봐요 | hub/draft-approval.ts, web/js/10-reply-card.js | `#chat/approve` |
| 원문 보기 패널 | 답하려는 메일이나 댓글 원문을 초안 옆에 | web/js/10-draft-original.js, web/css/15-draft-original.css | `#chat/approve` (카드 안에 줄여서 보여요) |
| 초안에 파일 더하기 | 초안에 첨부할 파일을 고르는 메뉴 | web/js/10-reply-card.js | 없음 |
| 답장 모델 고르기 | 초안을 쓸 모델 선택 | hub/reply-model-choices.ts | 없음 |

## 알림

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 알림 종 | 새 알림 수 배지가 있는 종 | web/js/30-notices.js, hub/notices.ts | `#notices` |
| 알림 목록 (시안: 독립 화면) | 처리할 것 · 새 소식 · 지난 알림 세 묶음, 필터는 거르기만, 읽음은 누르기 · ✕ · 모두 읽음으로만. 실제 앱은 아직 알림 대화 | 시안 s-notices.js, 실제 web/js/31-conversations.js, web/js/30-notices.js | `#notices`, `#notices/read`, `#notices/empty`, `#notices/long`, `#notices/repeat` |
| 가격 변경 알림 | 취소선 → 새 값이 알림 행에 | web/js/11-watchtext.js, hub/watchtext.ts | `#notices` |
| 알림 종류 · 푸시 | 이 기기에서 켜는 알림과 앱처럼 설치 | web/js/23-installable-app-web.js, docs/notifications.md | `#settings/notifications` |
| 알림 문체 | 일상 / 간결 / STE 중 알림 글 말투 | MODE.ko.md (Reporting), hub/notice-class.ts | `#settings/display` |

## 설정

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 설정 목록 | 설정 화면들의 입구 | web/js/22-settings.js, web/css/15-settings-phone.css | `#settings` |
| 공급자와 계정 | 구독 · API 키 공급자와 한도, 공급자 추가 시트 | web/js/21-providers.js, hub/providers.ts, docs/accounts.md | `#settings/providers` |
| 모델 순서 | 한도에 걸리면 다음 모델로 넘어가는 순서 | web/js/22-settings.js, web/js/20-models.js | `#settings/models` |
| 계정 | 계정 별칭, 지금 쓰는 계정, 바꾸는 규칙 | web/js/25-settings-accounts.js, hub/account-alias.ts | `#settings/accounts` |
| 메신저 | Discord · JANDI · Slack · Telegram 연결 | web/js/25-settings-messengers.js, docs/messengers | `#settings/messengers` |
| Discord 연결 | 봇 토큰 · 서버 · 대화별 전달 | web/js/25-settings-discord.js, docs/messengers/discord.md | `#settings/discord` |
| JANDI 연결 | JANDI 연결 설정 | web/js/25-settings-messengers.js, docs/messengers/jandi.md | `#settings/jandi` |
| Slack 연결 | Slack 연결 설정 | web/js/25-settings-messengers.js, docs/messengers/slack.md | `#settings/slack` |
| Telegram 연결 | Telegram 연결 설정 | web/js/25-settings-messengers.js, docs/messengers/telegram.md | `#settings/telegram` |
| 연결 자동 설정 패널 | 자동 단계를 돌리고 오너가 할 일 하나만 알려 줘요 | web/js/25-settings-onboarding.js | `#settings/discord`, `#settings/jandi`, `#settings/slack`, `#settings/telegram` (자동 설정 시작 버튼) |
| 두 값 토글 | 테마, 알림 문체, 시간 표기처럼 둘 중 하나 고르는 설정 | docs/ui-spec.md (설정 행), web/js/22-settings.js | `#settings/display` |
| 연결된 기기 | 패스키로 연결한 브라우저와 해제 | web/js/25-settings-devices.js, hub/devices.ts | `#settings/devices` |
| 웹 접속 | Tailscale / Cloudflare / 이 컴퓨터만 | web/js/25-settings-web-access.js, docs/web-access.ko.md | `#settings/webaccess` |
| 업데이트 | 새 버전 확인, 설치, 다시 시작 | web/js/24-settings-update.js | `#settings/update` |
| 사용량과 월 한도 | 5시간 · 7일 한도, API 월 한도 바꾸기 시트 | web/js/37-api-budget.js, hub/api-budget.ts | `#settings/usage` |
| 실행 하네스 | 지금 도는 하네스와 호환 확인 | web/js/26-settings-runtime.js | `#settings/runtime` |
| 구성 | 흐름 지도와 내가 추가한 기능 | web/js/27-harness.js, web/js/29-harness-features.js | `#settings/harness` |

## 공통 UI

| 이름 | 무엇 | 출처 파일 | 프로토타입 위치 |
|---|---|---|---|
| 게이트웨이 전환 | 헤더에서 내 컴퓨터(맥북, 맥미니)를 골라요 | web/js/33-peers.js | `#peers` (헤더 컴퓨터 이름 버튼은 모든 화면에 있어요) |
| 시트 / 대화창 | 아래에서 올라오는 시트(폰), 가운데 대화창(넓은 화면) | web/js/38-overlay.js, docs/ui-spec.md (시트·대화창), web/css/14-overlay.css | `#chat/approve`, `#apps/add`, `#settings/usage` |
| 토스트와 실행 취소 | 아래 짧은 알림, 버튼으로 되돌리기 | docs/ui-spec.md (토스트) | `#mail` |
| 팝오버 메뉴 | 눌린 버튼 아래 뜨는 짧은 메뉴 | web/js/03-menu.js | `#peers` |
| 배지 · 점 | 안 읽음 수, 상태 점(진행 중은 깜박임) | docs/ui-spec.md (배지·점), web/css/02-cards-lists-tags.css | `#home` |
| 스위치 · 두 칸 토글 · 진행 막대 | 설정 행의 컨트롤 | docs/ui-spec.md (설정 행, 진행 표시) | `#settings/display`, `#settings/usage` |
| 파일 칩 · 첨부 칩 | 파일 이름과 크기를 칩으로 | web/css/04-files.css | `#briefing`, `#mail/2` |
| 폰 키보드에 맞춘 입력창 | 키보드 높이만큼 입력창을 올려요 | web/js/34-composer-viewport.js | 없음 |
