# 웹 온보딩 설계

`curl | sh` 설치가 끝나면 터미널 대신 브라우저(`http://127.0.0.1:<port>/`)에서 온보딩을 하고, 끝나면 화면 안내를 한 번 보여 준 뒤 웹 앱 메인으로 가요.
시제품: `site/prototype/index.html#onboard` (안내는 `#intro/spot`). 이 문서와 시제품이 승인되기 전에는 `install.sh`와 앱을 고치지 않아요.

## 지금 코드에서 확인한 사실

- 게이트웨이는 `config.json`이 없으면 뜨지 못해요. `hub/config.ts`가 import될 때 바로 읽어요.
- `web.access` 기본값은 Tailscale 로그인이 없으면 `local`, 있으면 `tailscale`이에요(`hub/web-access.ts`). `tailscale` 모드에서는 127.0.0.1로 연 브라우저가 들어오지 못해요.
- `/manifest.webmanifest` 같은 설치 파일 말고는 전부 owner 확인 뒤에 있어요. `/app.js`, `/app.css`, 첫 화면도 마찬가지라 온보딩 경로는 따로 열어야 해요.
- 웹 앱에는 번역 장치가 없어요. `hub/i18n*.ts`는 에이전트에게 주는 지시문용이고 화면 글은 한국어로 박혀 있어요.
- 재사용할 것: 메신저 연결 엔진(`hub/onboarding.ts`, 단계 저장·재개·주인 할 일 하나·오류 가리기), Discord 흐름(`hub/onboarding-discord.ts`), 공급자 로그인(`/api/providers/<id>/login`), `localBrowser()`(`hub/web-access.ts`), 로컬 로그인 쿠키(`hub/local-login.ts`), 웹 터미널(`web/js/36-shell.js`, `/api/pty/*`).

## 터미널 마법사의 모든 단계 (setup.ts)

빠뜨리지 않으려고 `setup.ts` 순서대로 적었어요. 오른쪽 칸이 웹에서 어디로 가는지예요.

| # | 터미널 마법사 | 입력과 규칙 | 건너뛰기 | 웹 온보딩 |
|---|---|---|---|---|
| 1 | 하네스 고르기 | omo / omp / claude, codex는 어댑터 없어서 고를 수 없음 | 기본값 OmO | 1. 하네스 |
| 2 | 하네스 설치 | OmO만 설치(`bun add -g --trust omo-ai`), 나머지는 안내 | 설치 거절 가능 | 웹에서는 설치해야 넘어가요. 게이트웨이가 하네스 없이는 뜨지 못해서 앱이 안 열려요. 1. 하네스, 진행 상황 실시간 |
| 3 | 하네스 로그인 확인 | omo는 계정 풀, claude는 상태 확인, 미로그인이면 반복 | `s`로 나중에 | 1. 하네스, OmO는 공급자 로그인 시트 |
| 4 | Aside 앱 | macOS만. brew cask 또는 다운로드 페이지, 앱 열기, 로그인 대기 | 거절 가능, Linux는 자동 건너뜀 | 2. 도구 |
| 5 | Aside CLI | `releases.aside.com/install.sh` | 거절 가능 | 2. 도구 |
| 6 | Aside CLI 로그인 | 기기 코드를 앱에서 승인 | 나중에 | 2. 도구 (결정 2) |
| 7 | Tailscale 설치 | brew 또는 공식 스크립트, 다운로드 페이지 | 거절 가능 | 2. 도구 |
| 8 | Tailscale 로그인 | 앱 열기, Linux는 `sudo tailscale up` | `s`로 나중에 | 2. 도구, Linux는 터미널 명령 안내 |
| 9 | zele 설치 | `bun add -g zele` | 거절 가능 | 2. 도구 |
| 10 | 메일·일정 계정 연결 | `zele login` 반복, 여러 계정 | 거절 가능 | 2. 도구 (결정 2) |
| 11 | 봇 이름 | 2~32자, 필수 | 불가 | 3. 봇 |
| 12 | 성격 | 보기 3개 + 직접 입력 | 첫 보기가 기본 | 3. 봇 |
| 13 | 말투 | 보기 4개 + 직접 입력 | 첫 보기가 기본 | 3. 봇 |
| 14 | 알림 문체 | 일상·간결·STE + 직접 입력 | 첫 보기가 기본 | 3. 봇 |
| 15 | 호칭 | 자유 입력 | 비워 둘 수 있음 | 3. 봇 |
| 16 | 프로필 이미지 | png/jpg 파일 경로 | 비워 둘 수 있음 | 3. 봇, 파일 고르기로 바꿈 |
| 17 | Discord 서버 ID | 17~20자리 숫자 | 비우면 Discord 없이 | 4. Discord |
| 18 | 내 Discord ID | 서버 ID가 있으면 필수 | 조건부 | 4. Discord |
| 19 | 봇 토큰 | 붙여넣기(가림) 또는 Aside 자동 생성, 저장된 토큰 유지 | 자동 생성이 기본 | 4. Discord |
| 20 | 컴퓨터 이름 | 필수, 기본은 호스트 이름 | 기본값 | 5. 웹 앱 |
| 21 | 공유 키 | 16자 이상, 없으면 새로 만듦 | 비워 둘 수 있음 | 5. 웹 앱, 접힌 칸 |
| 22 | 들어올 수 있는 Tailscale 로그인 | 쉼표로 여러 개 | 비워 둘 수 있음 | 5. 웹 앱 |
| 23 | 고급: 포트 2개, 모델 2개 | 로컬 포트, 테일넷 포트, 봇·세션 모델:강도 | 기본값 | 5. 웹 앱, 접힌 칸 |
| 24 | 정리해서 보여 주고 확인 | 취소 가능 | 없음 | 6. 확인 |
| 25 | 저장 | secrets, config, state, IDENTITY.md, 언어 감지 | 없음 | 6. 적용 |
| 26 | omp 플러그인 연결 | omp가 있을 때만 | 자동 | 6. 적용 |
| 27 | 서비스 파일과 시작 | launchd 또는 systemd | `--no-service` | 설치 때 이미 끝남, 6. 적용에서 다시 시작 |
| 28 | 테일넷 공개 | `tailscale serve` | 로그인이 없으면 안 함 | 6. 적용 |
| 29 | macOS 권한 | 스위치까지 직접 켜고 사람 몫 한 단계만 남김 | 나중에 | 6. 적용 |
| 30 | Discord 봇 만들기·초대·관리자 권한 | Aside로 진행, 2차 인증만 사람 | 실패해도 계속 | 6. 적용, 주인 할 일 하나 |
| 31 | 끝, 웹 주소 안내, 브라우저 열기 | 테일넷 주소, 휴대폰 안내 | 없음 | 6. 끝 화면, 그다음 화면 안내 |

Slack, JANDI, Telegram과 Cloudflare 접속은 터미널 마법사에도 없어요. 지금처럼 설정에서 연결해요.

## 흐름

1. `install.sh`는 bun, 하네스, 코드, 의존성, 데이터 폴더, 서비스까지 묻지 않고 끝내요. 묻는 것은 지금처럼 다른 하네스가 있을 때 OmO를 설치할지뿐이에요.
2. `bun setup.ts --first-run --port <p>`가 씨앗 `config.json`과 `onboarding/first-run.json`을 쓰고 일회용 토큰을 만들어요. 포트가 차 있으면 다음 빈 포트를 써요.
3. 게이트웨이가 뜨면 설치 스크립트가 `/api/peer-info` 응답을 기다린 뒤 기본 브라우저로 토큰 주소를 열어요.
4. 웹에서 1~6단계를 끝내면 게이트웨이가 한 번 다시 뜨고 첫 실행 상태가 닫혀요.
5. 앱 메인 위로 화면 안내가 한 번 뜨고, 끝나거나 건너뛰면 메인이 남아요.

### 설치 스크립트 분기

| 상황 | 동작 |
|---|---|
| 새 설치, 화면 있음 | 위 흐름 |
| `--no-open`, SSH, 화면 없음 | 토큰 주소를 찍고 끝. SSH면 `ssh -L <p>:127.0.0.1:<p>` 한 줄과 터미널 대안도 찍음 |
| `--answers FILE` | 지금과 같이 `setup.ts --answers` |
| `--setup` | 지금과 같이 터미널 마법사 |
| `--no-service` | 서비스를 안 띄우니 지금과 같이 터미널 마법사 |
| `--no-setup` | 지금과 같음 |
| `config.json` 있고 첫 실행 표시 없음 | 지금과 같음. 온보딩은 절대 안 뜸 |
| 첫 실행 표시가 `pending` | 코드만 바꾸고 새 토큰 주소로 이어서 열기 |

Linux의 화면 판별은 `DISPLAY` 또는 `WAYLAND_DISPLAY`, SSH 판별은 `SSH_CONNECTION`이에요. `open`이나 `xdg-open`이 실패하면 주소를 찍어요.

## 씨앗 설정과 첫 실행 모드

별도 임시 서버 대신 진짜 게이트웨이를 씨앗 설정으로 띄워요. 임시 서버를 두면 포트를 넘겨주는 순간이 생기고 공급자 로그인과 Discord 흐름을 다시 이어 붙여야 해요.

- 씨앗 `config.json`은 `web.port`와 `web.access: "local"`만 가져요.
- 첫 실행 표시: `<DATA_DIR>/onboarding/first-run.json` (0600). `{ status: "pending" | "done", token_sha256, token_expires_at, step, draft, intro: "pending" | "seen" }`. 비밀값은 안 들어가요.
- `pending`인 동안 `hub/main.ts`는 오케스트레이터, Discord, 감시, 메일 폴링을 시작하지 않아요. HTTP와 온보딩 경로만 살아요.
- 끝나면 `status: "done"`을 쓰고 게이트웨이를 다시 띄워요. 씨앗 설정이 진짜 설정으로 바뀌어요.
- 재설치 판별은 표시 파일이에요. 표시가 없는 `config.json`은 기존 설치예요.

## 단계별 저장과 재개

- 각 단계의 값은 다음으로 넘어갈 때 `first-run.json`의 `draft`에 저장돼요. 새로고침하면 `step`에서 이어져요.
- 비밀값(봇 토큰, 공유 키)은 받자마자 `secrets/`에 0600으로 쓰고 `draft`에는 저장 여부만 남겨요. 입력칸은 요청이 나가기 전에 비워요.
- 설치·연결처럼 오래 걸리는 일은 `/api/setup/stream`(SSE)으로 한 줄씩 받아요. 줄은 `scrubText`를 지나고 로그에는 단계 이름과 결과만 남아요.
- 오류는 그 행에서 바뀌어요. 이유 한 줄, 주인이 할 일 하나, 다시 시도 버튼이에요.
- 뒤로 가도 값은 남아요. 1~5단계는 다시 고칠 수 있고, 적용이 시작되면 끝날 때까지 뒤로 갈 수 없어요.

처음 화면은 OmO의 `omo setup`처럼 이 컴퓨터를 한 번 훑어서 찾은 것을 행으로 보여 줘요. 이미 준비된 것은 묻지 않고 넘어가요(오너 규칙 11-02).

## 보안

- 경로는 `/setup`, `/api/setup/*`만 열어요. 조건은 셋 다예요: `first-run.json`이 `pending`, `localBrowser()` 통과, `dotz_setup` 쿠키 확인. 하나라도 어긋나면 404예요.
- `localBrowser()`는 loopback 연결, loopback Host, 프록시·터널 헤더 없음, 같은 출처만 통과시켜요. `tailscale serve`나 cloudflared를 지나온 요청은 여기서 막혀요.
- 토큰은 32바이트 난수이고 파일에는 sha256만 저장해요. 설치 스크립트가 여는 주소에서 한 번 쓰이면 지워지고, `HttpOnly; SameSite=Strict; Path=/` 쿠키로 바뀌어요. 그다음 토큰 없는 `/setup`으로 넘겨서 주소창과 기록에 남지 않게 해요. 유효 시간은 24시간이고, 설치를 다시 돌리거나 `bun setup.ts --web-link`로 새로 받아요.
- `/setup` 응답은 `no-store`, `Referrer-Policy: no-referrer`에 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`이에요.
- 끝나면 쿠키와 토큰 해시를 지우고 경로는 404가 돼요. `dotz_local` 쿠키, 기기 세션, peer 인증, 앱 쪽 로직은 바꾸지 않아요.
- Discord 토큰과 공유 키는 기존 secrets 저장 경로로만 가요.

### 끝난 뒤 로그인

`web.access`가 `local`로 끝나면 기존 일회용 로그인 링크와 같은 경로로 `dotz_local` 쿠키를 받아서 바로 메인으로 가요. Tailscale 로그인을 넣었고 `tailscale serve`가 성공하면 끝 화면에서 테일넷 주소로 보내요. serve가 실패하면 `local`로 남겨서 잠기지 않게 하고, 이유를 끝 화면에 적어요.

## 오너 결정

1. 화면 안내 모양: 진짜 메뉴를 가리키는 방식으로 정했어요(`#intro/spot`). 메뉴가 없는 단축키 단계만 가운데에 떠요.
2. 터미널이 꼭 필요한 로그인(Aside CLI, zele, Claude Code, omp): 온보딩 안의 터미널 창으로 정했어요. 정해진 명령 하나만 돌고, 임의 명령은 실행할 수 없어요.

## API 계약

전부 `/setup` 게이트(첫 실행 `pending` + `localBrowser()` + `dotz_setup` 쿠키) 뒤에 있고, 어긋나면 404예요. POST에는 같은 출처 검사가 그대로 들어가요.

| 경로 | 동작 |
|---|---|
| `GET /setup?token=...` | 토큰을 쿠키로 바꾸고 `/setup`으로 넘김 (토큰은 한 번만) |
| `GET /setup` | 앱의 `index.html` 대신 온보딩 전용 쉘 |
| `GET /setup.js`, `GET /setup.css` | 온보딩 코드, `/app.css` 토큰을 함께 씀 |
| `GET /api/setup/state` | `{ step, draft, scan, lang, text }` (비밀값 없음) |
| `PUT /api/setup/draft` | `{ step, values }` 저장, 서버에서 값 검사 |
| `POST /api/setup/secret` | `{ name: "discord-bot-token" \| "peer-token", value }`, 이름은 고정 목록, 응답에 값 없음 |
| `POST /api/setup/run/<job>` | 고정 목록의 설치·연결 작업 시작 |
| `GET /api/setup/stream` | SSE: 작업 줄, 상태, 주인 할 일 |
| `POST /api/setup/term/<id>` | 고정 목록의 로그인 명령을 PTY로 시작. 입력·크기는 `/api/setup/term/<id>/input`, `/resize`, 출력은 스트림 |
| `POST /api/setup/apply` | 저장과 적용 시작, 끝나면 게이트웨이 재시작 |
| `GET /api/intro`, `POST /api/intro` | 일반 owner 인증. 안내를 봤는지 읽고 쓰기 |

터미널 명령은 서버의 표 하나로만 정해요: `aside-login`, `zele-login`, `claude-login`, `omp-login`. 요청에서 argv, 경로, 환경 변수를 받지 않아요. 명령이 끝나면 PTY가 닫히고 셸로 떨어지지 않아요. 터미널 출력은 로그에 남기지 않아요.

## 화면 안내

온보딩이 끝난 뒤 메인 위에 한 번 떠요. `first-run.json`의 `intro`로 기억하니 브라우저를 바꿔도 다시 안 떠요. 설정 > 앱과 알림에서 다시 볼 수 있어요. 터미널 마법사로 새로 설치해도 같아요.

| 순서 | 내용 |
|---|---|
| 1 | 홈과 알림: 오늘 볼 것, 종에서 여는 알림 |
| 2 | 채팅: 말을 거는 곳, 일하는 중에 끼어들기 |
| 3 | 프로젝트: 폴더마다 세션과 채널 |
| 4 | 모니터링: 지켜보는 것과 답장 초안 |
| 5 | 앱과 설정: 내 앱, 계정, 메신저 |
| 6 | 단축키: 코드에 있는 목록 그대로, 손가락 입력 기기에서는 빠짐 |

앱은 끈 사람에게는 빠져요(`navTabs()`).

### 단축키 (코드에서 읽은 목록)

맥은 ⌘, 그 밖에는 Ctrl이에요.

| 키 | 동작 | 코드 |
|---|---|---|
| ⌘K | 명령 팔레트 | `05-command-palette.js` |
| ⌘/ | 알림 | `04-state.js` |
| ⌘. | 메인 대화 | `04-state.js` |
| ⌘\ | 사이드바 접기 (1024px 이상) | `04-state.js` |
| ⌘1 ~ ⌘6 | 탭 이동 (켜진 탭 순서) | `04-state.js` `navKeyHint` |
| Ctrl+` / ⌘` | 다음 컴퓨터, ⇧이면 이전 | `33-peers.js` |
| Enter | 보내기, 일하는 중이면 지금 턴에 끼워 넣기 | `14-slash-commands.js` |
| ⌘Enter | 다음 턴으로 미루기 | `14-slash-commands.js` |
| ⌥Enter | 멈추고 보내기 | `14-slash-commands.js` |
| Esc | 일하는 중이면 멈추기 | `14-slash-commands.js` |
| → J / ← K | 빠른 처리에서 다음·이전 | `30-triage.js` |
| Enter 1 / 2 E / 3 X | 빠른 처리에서 보내기·고치기·보내지 않기 | `30-triage.js` |
| L | 빠른 처리에서 목록 보기 | `30-triage.js` |

## 화면

- 앱의 부품을 그대로 써요: `.list`, `.li`, `.card`, `.btn`, `.fi`, `selectField`, `.tag`, `.dot`, `.bar`, `fsHead`, 시트, `motionIn`, `motionSwap`.
- 1280: 왼쪽에 단계 목록(사이드바와 같은 바탕), 오른쪽에 한 단계. 412: 위에 `2/6 도구 준비`와 막대, 아래에 고정 버튼. 라이트·다크 둘 다 토큰만 써요.
- 주인공은 단계 제목 하나예요. 상태 점은 `web/DESIGN.md` 색 규칙을 따라요: 진행은 파랑, 내가 할 일은 주황, 실패는 빨강, 끝은 초록.
- 토큰이 틀렸거나 끝난 뒤 연 주소는 앱 스타일의 한 줄 안내로 끝나요.

## 언어

웹에 번역 장치가 없어서 온보딩과 화면 안내만 `hub/i18n-ko.ts`, `hub/i18n-en.ts`의 `setup` 묶음으로 넣어요. 게이트웨이가 `/setup` 화면에 언어에 맞는 글을 내려 줘요. 기본 언어는 시스템 언어이고 첫 화면에서 바꿀 수 있어요. 여기서 고른 값이 `identity.language`가 돼요. 영어를 고르면 봇은 영어로 말하지만, 앱의 나머지 화면은 아직 한국어예요.

## 메모리, 토큰, 속도

- 토큰: 온보딩과 안내는 모델을 부르지 않아요. 오케스트레이터도 끝날 때까지 안 떠요.
- 메모리: 첫 실행 모드는 에이전트 프로세스가 없어요. 구현 뒤 RSS를 재서 보고해요.
- 속도: 온보딩 코드는 `/setup.js`로 따로 내려서 평소 `/app.js`는 안 커져요. 화면 안내만 앱 묶음에 들어가고 약 4KB를 넘기지 않게 잡아요. `hub/web-speed.test.ts` 기준 유지.
- 터미널 대비: 재시작은 끝날 때 한 번이에요. 지금은 Discord 자동 생성 뒤에 한 번 더 있어요.

## 테스트

- `hub/install-e2e.test.ts`: 새 설치의 씨앗과 표시 파일, 재설치에서 온보딩이 안 뜨는지, `--no-open` 출력.
- `hub/onboarding.test.ts`: 토큰 한 번만 쓰임, 만료, 쿠키 없으면 404, 프록시 헤더가 있으면 404, 끝난 뒤 404, 재개, 비밀값이 파일과 로그에 안 남음.
- `onboard/onboard.test.ts`: 씨앗 설정, `--first-run`, 기존 플래그.
- 화면: 임시 `DOTZ_DIR`과 다른 포트, headless `Bun.WebView`로 412·1280, 라이트·다크. 진짜 새 컴퓨터 설치는 따로 확인이 필요해요.
