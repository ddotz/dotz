---
name: API 없는 회사 메일
what: zele도 API도 안 되는 메일 사이트를 브라우저 로그인으로 읽고 감시하고 초안을 써요
trigger: 항상(프롬프트)
stage: guard
enabled: false
applies_to: orchestrator
---
API도 공식 CLI도 zele도 없는 메일 사이트(사내 웹메일 등)를 브라우저 로그인만으로 쓰는 기능이에요. 기본은 꺼져 있고, 형이 "회사 메일 연결해줘"처럼 말하면 그때 설정 단계로 켜요. 메일·캘린더가 zele로 되는 계정이면 먼저 zele를 쓰고(메일·캘린더(zele) 섹션), 이 기능은 zele가 안 되는 사이트에만 써요. 메일을 다른 머신이 맡는 설치(features/no-mail-calendar-here 같은 규칙)에서는 그 규칙을 먼저 따라요.

켜는 순서(형이 요청할 때만):
1. 사이트 주소를 물어봐요(받은메일함 URL). 로그인은 Aside 브라우저 백그라운드로만 해요(창을 앞으로 올리지 않아요). 로그인이 안 돼 있으면 형이 직접 로그인하게 안내하고, 2차 인증은 그 대화에서 형이 OK할 때만 진행해요.
2. 로그인된 상태에서 받은메일함과 메일 한 통을 열어 그 사이트가 쓰는 XHR/JSON 호출을 백그라운드로 기록해요: `bun <dotz>/features/webmail-no-api/bin/capture.ts <site> --record <origin> --inbox <inbox-url>` (또는 HAR을 받아 `--from <file>`). 그러면 사이트별 어댑터 스펙(custom 레이어의 spec.json)이 만들어져요. 개인정보 없이 필드 이름과 URL 모양만 저장돼요.
3. `bin/mail.ts <site> list`와 `read <id>`로 목록·읽기가 되는지 확인해요.
4. 작업 채널을 하나 만들고(평범한 제목, 예: "회사 메일"), `bin/setup.ts <site> --channel ch:<id> [--poll 5] [--refresh 6]`로 설정·홈카드·사이드바를 쓰고, 출력된 감시 스펙을 `dotz_watch add`로 등록해요. 채널 `logins`에 그 Aside 로그인을 넣어 게이트웨이가 모델 없이 로그인을 유지하게 해요(refresh_hours마다 탭 로드로 쿠키 갱신).

쓰는 법:
- 읽기는 자유롭게: `bin/mail.ts <site> list|read <id>|search <말>`.
- 새 메일: 감시가 메일마다 한 줄씩 알려요. 메일마다 작업 채널에 스레드를 하나씩 열어요(kind는 보낸사람, name은 제목). 할 일 없으면 조용해요.
- 답장·전달·전송: 먼저 `bin/mail.ts <site> draft <받는이> <제목> <본문>`으로 초안을 만들어 스레드에 보여주고, 형이 그 스레드에서 OK(ㅇㅇ/보내)하면 그때 `bin/mail.ts <site> approve`로 승인 표시를 남기고 `send <draftId>`로 보내요. 승인 없이 보내는 건 거부돼요(승인은 15분·한 번, 전송 뒤 지워져요). 형 판단 없이 먼저 보내지 않아요.

로그인이 풀리면: 감시가 조용히 한 번만 백그라운드 탭 로드로 복구를 시도하고, 안 되면 형에게 한 번 알리고 멈춰요(2차 인증은 형 OK 전에는 안 보내요).

최적화 기본값: poll_minutes(기본 5), 매 확인은 조건부 요청(If-None-Match/If-Modified-Since)으로 안 바뀌면 304 무전송, 최소 필드만 요청(list.params), 쿠키 쪽은 keepalive 요청 하나로 세션 연장. 받은메일함이 그대로면 토큰도 네트워크도 거의 안 써요.
