# dotz 클릭 시제품

dotz 웹 앱의 화면과 움직임을 눌러 보며 결정하려고 만든 **디자인 시제품**이에요. **실제 제품과 연결되지 않았어요.** 데이터는 전부 `data.js`의 가짜 값이고, 보내기, 삭제, 설치 같은 동작은 화면 안에서만 흉내 내요. 새로고침하면 처음 상태로 돌아가요.

## 여는 법

- 파일로 바로: `site/prototype/index.html`을 브라우저로 열어요(서버 필요 없음).
- 서버로: 저장소 루트에서 `bunx serve site`를 돌리고 `/prototype/`을 열어요.

## 툴바

화면 맨 위 툴바에 두 가지와 목록 링크가 있어요.

- **테마**: 라이트 / 다크. `localStorage`의 `dz-proto-theme`에 저장돼요.
- **모션**: 켜기 / 끄기. `localStorage`의 `dz-proto-motion`에 저장돼요. 시스템의 "동작 줄이기"가 켜져 있으면 저장된 값과 상관없이 꺼져요.
- **화면 목록**: `#index`로 가요. 88개 화면이 묶음별로 나와 있어요.

## 화면 목록

모든 화면은 주소의 해시로 열려요(예: `index.html#chat/formats`). 전체 목록은 `#index`예요. 처음 보기 좋은 화면:

- `#home` 홈 상태 카드
- `#chat/formats` 봇이 쓰는 모든 출력 형식
- `#chat/approve` 보내기 승인
- `#mail` 메일 (삭제 → 실행 취소)
- `#notices` 알림: 종에서 여는 독립 화면 (필터 · 다 읽은 목록 · 빈 화면 · 긴 제목 · 반복은 `#notices/…`)
- `#settings` 설정
- `#queue` 대기함 시안 (앱을 가리지 않는 한 목록, 실패가 맨 위, 같은 이유의 실패는 한 줄. 상태별로 `#queue/ask` · `#queue/failed` · `#queue/sent` · `#queue/one` · `#queue/fails` · `#queue/empty`, 채팅의 한 줄은 `#queue/chat`, 1건 카드는 `#queue/chat/one`)
- `#onboard` 웹 온보딩 전체 화면 (단계는 `#onboard/harness` · `tools` · `bot` · `discord` · `web` · `review` · `done`, 값은 새로고침해도 남고 툴바의 "온보딩 처음부터"로 지워요. 닫힌 주소는 `#onboard/expired` · `#onboard/closed`)
- `#intro` 화면 안내 A안(시트), `#intro/spot` B안(진짜 메뉴를 가리키기)
- `#form` 카드 추가 새 폼 시안 (실시간 미리보기 · 썸네일 보기 · 더 보기, 찬 상태는 `#form/filled`, 연 상태는 `#form/more`, 설정에 입힌 모습은 `#form/settings`)
- `#answers` 채팅 답 모양 시안 (같은 글을 지금 모양과 제안 모양으로 나란히, 카드를 쓰지 않는 곳까지)

## 문서

- `INVENTORY.md`: 실제 제품에 있는 기능과 출력 형식, 시제품 어디에 있는지(없는 것은 "없음")
- `MOTION.md`: 구현된 모션의 시간 · 곡선 · 움직이는 값, 비교하는 법

## 파일

| 파일 | 내용 |
|---|---|
| `index.html` | 틀(툴바, 사이드바, 화면 영역)과 스크립트 불러오기 |
| `proto.css` | 디자인 토큰, 모션 토큰, 모든 스타일 |
| `proto.js` | 틀 그리기, 라우터, 검색 팔레트, 시트 · 토스트 · 팝오버, 모션 헬퍼, 답장 초안 카드 |
| `data.js` | 가짜 데이터(대화, 메일, 프로젝트, 알림 등) |
| `s-chat.js` | 채팅, 답 형식 모음, 보내기 승인, 브리핑, 작업 화면 |
| `s-notices.js` | 알림 화면: 묶음 3개, 필터, 읽음, 반복 접기, 결정 시트 |
| `s-work.js` | 홈, 프로젝트, 모니터링, 메일, 답장 확인, 앱, 컴퓨터 |
| `s-settings.js` | 설정 화면들 |
| `s-form.js` | 새 폼 시안: 카드 추가, 같은 입력칸을 입힌 설정 폼 |
| `s-onboard.js`, `onboard.css` | 웹 온보딩과 화면 안내 (설계는 `docs/web-onboarding.md`) |
| `s-queue.js` | 대기함 시안: 멈춘 답장 한 목록, 실패 묶음, 채팅의 한 줄 |
| `s-answers.js`, `answers.css` | 채팅 답 모양 시안: 마크다운 모양을 읽어 그려요 |
