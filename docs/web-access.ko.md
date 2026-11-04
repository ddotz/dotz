# 웹 접속 (온보딩)

설정 → 웹 접속에서 접속 방식을 고르면 dotz가 그 방식에 필요한 설정을 스스로 마칩니다. 기본값은 **Tailscale**이고, 지금 쓰는 tailnet 주소는 바뀌지 않습니다.

## 방식

- **Tailscale** (기본): tailnet에 연결한 기기에서 `https://<기기>.<tailnet>.ts.net`으로 엽니다. dotz가 `tailscale serve`를 확인하고, 없으면 설정합니다.
- **Cloudflare**: 고정 주소(예: `dotz.example.com`)를 열고 Cloudflare Access와 기기 연결(패스키)을 씁니다.
- **이 컴퓨터만**: `127.0.0.1`에서만 엽니다. 다른 기기에서는 열리지 않습니다.

## Cloudflare를 고르면 하는 일

1. `cloudflared`가 있는지 확인하고, 없으면 Homebrew로 설치합니다(`brew install cloudflared`).
2. Cloudflare 로그인이 안 되어 있으면 `cloudflared tunnel login`이 출력한 주소를 오너의 Aside 브라우저(백그라운드)로 엽니다. 오너가 **Authorize**를 누르면 `~/.cloudflared/cert.pem`이 생깁니다.
3. `dotz` 터널을 재사용합니다. 없으면 만듭니다.
4. 주소가 없으면 Cloudflare 계정의 첫 도메인을 읽어 `dotz.<도메인>`을 제안합니다.
5. `cloudflared tunnel route dns`로 DNS를 연결하고, 터널 토큰을 `~/.dotz/secrets/cloudflared-tunnel-token`에 0600으로 저장합니다.
6. 게이트웨이를 다시 시작하지 않고 터널을 켭니다. 화면에 최종 주소가 표시됩니다.

이 컴퓨터만을 고르면 터널을 끄고 로컬 주소만 남깁니다. Tailscale로 되돌리면 tailnet 주소를 다시 확인합니다.

## 이 컴퓨터만: 로그인 링크

이 모드에서도 로그인은 있습니다. 터미널에서 `bun hub/web-login-cli.ts`를 실행하면 5분 안에 한 번만 쓸 수 있는 링크(`http://127.0.0.1:<포트>/local-login?code=…`)가 나오고, 같은 컴퓨터의 브라우저로 열면 30일짜리 쿠키(`dotz_local`)가 생깁니다. 쿠키는 해시만 `web-local-sessions.json`(0600)에 저장되어 게이트웨이를 다시 시작해도 유지되지만, 링크는 다시 시작하면 사라집니다. 다른 모드로 바꾸면 쿠키와 링크가 모두 무효가 되어 다시 이 모드로 돌아와도 새 링크가 필요합니다. 한계: 쿠키는 포트별로 분리되지 않아서, 같은 브라우저로 `127.0.0.1`의 다른 서비스를 열면 그 서비스도 이 쿠키를 받습니다.

## 오너가 하는 일

- Cloudflare 로그인과 **Authorize** 클릭
- Cloudflare가 요구하는 2단계 인증·캡차
- (선택) Cloudflare Access 정책에 본인 이메일만 허용

화면에 한 단계로 표시됩니다. 끝나면 dotz가 이어서 진행합니다.

## 처음 한 번만 하는 일

Cloudflare를 처음 쓰면 기기를 하나 연결해야 합니다. 새 주소를 열면 `/pair` 화면이 나오고, **기기 연결**을 눌러 패스키를 만듭니다. 연결된 기기가 없으면 설정 화면에 다시 들어올 수 없으므로, 연결 전에 Tailscale 주소를 지우지 마세요.

## 저장되는 것

| 무엇 | 어디 | 권한 |
| --- | --- | --- |
| 접속 방식, 주소, Access 팀·AUD, 토큰 파일 이름 | `~/.dotz/web-access.json` | 0600 |
| Cloudflare 터널 토큰 | `~/.dotz/secrets/cloudflared-tunnel-token` | 0600 |
| cloudflared 로그인 인증서 | `~/.cloudflared/cert.pem` | 0600 |
| 온보딩 진행 상태(비밀 없음) | `~/.dotz/onboarding/web-access.json` | 0600 |

## 복구와 되돌리기

- 화면의 **직접 입력**을 열면 주소, 팀 이름, AUD, 터널 토큰을 직접 넣을 수 있습니다. Cloudflare 화면이 바뀌어 자동화가 실패했을 때의 복구 경로입니다.
- 자동 온보딩이 실패하면 이유 한 줄과 다음 할 일 한 단계가 표시됩니다. **다시 시도**를 누르면 저장된 것부터 이어서 합니다.
- Tailscale로 되돌리려면 접속 방식을 **Tailscale**로 고르고 저장합니다. 터널이 닫히고 tailnet 주소가 다시 쓰입니다.
- 화면에 들어가지 못하게 되었을 때는 이 컴퓨터에서 `x-dotz-token` 헤더로 `PUT /api/web-access` `{"mode":"tailscale"}`을 보내거나 `~/.dotz/web-access.json`을 지우고 게이트웨이를 다시 시작합니다.

## 한계

- Cloudflare를 쓰려면 Cloudflare 계정과 도메인이 있어야 합니다. 도메인이 없으면 `docs/web-access-cloudflare.ko.md`의 workers.dev 방식을 씁니다.
- 터널 토큰과 인증서는 이 컴퓨터에만 저장합니다. 다른 컴퓨터에 복사하면 그 컴퓨터가 같은 터널에 붙습니다.
- 자동 설치는 Homebrew가 있는 macOS를 전제로 합니다. Homebrew가 없으면 설치 안내가 표시되고, 직접 설치한 뒤 다시 시도합니다.
- Cloudflare Access를 쓰면 `config.json`의 `web.allow_logins`에 허용 이메일을 적어야 합니다.
- 자동 온보딩은 오너의 Aside 브라우저 세션을 씁니다. 브라우저 창을 앞으로 올리지 않고, 연 탭은 닫습니다.
