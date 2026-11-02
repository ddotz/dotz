# 웹앱을 Cloudflare로 고정해서 사용하기

Tailscale을 쓸 수 없는 환경(회사 PC, 휴대폰 등)에서는 웹앱을 Cloudflare Tunnel로 고정된 주소에 열고, Cloudflare Access로 로그인을 받습니다. 메신저(Discord, JANDI 등)는 웹앱과 상관없이 그대로 동작하며, 웹앱이 열려 있으면 메신저 메시지에 "웹에서 보기" 링크가 함께 붙습니다.

## 동작 방식

- `web.access`가 `"cloudflare"`이면 게이트웨이가 `cloudflared tunnel run`을 자식 프로세스로 띄워 감시합니다. 종료되면 2초에서 60초까지 간격을 늘리며 다시 시작하고, 게이트웨이를 끌 때 함께 종료합니다.
- 접속 요청은 Cloudflare Access가 로그인을 거친 뒤 `Cf-Access-Jwt-Assertion` 토큰을 붙여 전달합니다. 게이트웨이는 이 토큰의 RS256 서명(팀 공개키), `aud`, 발급자, 만료 시각, 이메일(`web.allow_logins`에 있는 주소)을 모두 확인합니다. 이메일 헤더만 있는 요청은 받지 않습니다.
- 이 모드에서는 `Tailscale-User-Login` 헤더를 신뢰하지 않습니다. `x-dotz-token`은 그대로 동작합니다.
- 파일 링크, `dotz_auth` 입력 링크, 푸시 알림 주소는 모두 `https://<hostname>`을 사용합니다. Tailscale 조회는 하지 않습니다.

## 관리자 설정 순서

1. cloudflared를 설치합니다: `brew install cloudflared`
2. Cloudflare Zero Trust 대시보드에서 Networks → Tunnels → Create a tunnel로 터널을 만듭니다. 커넥터는 Cloudflared를 고릅니다.
3. 터널의 Public Hostname을 추가합니다. 호스트 이름은 사용할 주소(예: `dotz.example.com`)로, 서비스는 `HTTP`, `http://127.0.0.1:<web.port>`(기본 7420)로 지정합니다.
4. 터널 토큰(설치 명령에 나오는 `eyJ...` 문자열)을 `~/.dotz/secrets/cloudflared-tunnel-token` 파일에 한 줄로 저장하고 권한을 제한합니다.
   ```
   chmod 600 ~/.dotz/secrets/cloudflared-tunnel-token
   ```
   다른 파일명을 쓰면 `web.cloudflare.tunnel_token_file`에 지정합니다. 상대 경로는 `secrets` 폴더 기준입니다.
5. Zero Trust → Access → Applications에서 Self-hosted 애플리케이션을 만들어 같은 호스트 이름을 지정하고, 본인 이메일만 허용하는 Allow 정책을 추가합니다.
6. 만든 애플리케이션의 Application Audience (AUD) Tag와 Zero Trust 팀 이름(`<team>.cloudflareaccess.com`의 `<team>`)을 확인합니다.
7. `~/.dotz/config.json`의 `web`에 아래 내용을 넣습니다. `allow_logins`에는 5단계에서 허용한 이메일을 소문자로 적습니다.
   ```json
   "web": {
     "access": "cloudflare",
     "allow_logins": ["owner@example.com"],
     "cloudflare": {
       "hostname": "dotz.example.com",
       "team": "myteam",
       "aud": "<AUD tag>"
     }
   }
   ```
8. 게이트웨이를 다시 시작합니다. 로그에 `cloudflared`가 시작되었다는 기록이 남고, 브라우저에서 `https://dotz.example.com`을 열면 Cloudflare 로그인 후 웹앱이 열립니다.

## 문제 해결

- cloudflared가 설치되어 있지 않으면 설정 화면에 설치 안내가 표시되고, 게이트웨이와 메신저는 그대로 실행됩니다. 설치 위치가 PATH에 없으면 `DOTZ_CLOUDFLARED_BIN`에 실행 파일 경로를 지정합니다.
- 토큰 파일이 없거나 비어 있으면 터널이 시작되지 않고 오류 상태가 표시됩니다.
- 로그인 후에도 403이 나오면 `aud`, `team`, `allow_logins`의 이메일(소문자)이 Access 설정과 같은지 확인합니다.
- `web.access`를 `"tailscale"`(기본값)로 두면 기존 동작이 그대로이고, `"local"`이면 Tailscale 조회와 `tailscale serve` 설정을 하지 않습니다.

## 기기 연결 (패스키)

`web.access`가 `"cloudflare"`이면 연결된 기기만 웹앱을 쓸 수 있습니다. 주소를 알거나 Cloudflare 로그인을 통과해도, 한 번 연결한 기기가 아니면 `https://<호스트이름>/pair`의 "기기 연결" 화면만 보입니다. 이 방식에서는 `web.cloudflare.team`과 `web.cloudflare.aud`(Cloudflare Access)가 없어도 터널이 열립니다. 두 값을 채우면 기기 연결에 더해 Access 로그인도 함께 요구하는 추가 보안 계층이 됩니다.

### 기기를 연결하는 방법

1. 연결할 기기의 브라우저에서 `https://<호스트이름>`을 엽니다. "기기 연결" 화면으로 이동합니다.
2. "코드 받기"를 누릅니다. 6자리 코드는 **메신저 알림(Discord, JANDI, Slack 등 연결된 모든 메신저)으로** 옵니다. 코드는 10분 동안만 쓸 수 있고 한 번 쓰면 사라집니다.
3. 코드를 입력하고 기기 이름을 정한 뒤 "이 기기 연결"을 누릅니다. 기기의 패스키(Face ID, 지문, Windows Hello 등)로 본인 확인을 하면 연결이 끝나고 웹앱이 열립니다.

코드는 한 번에 5번까지만 틀릴 수 있고, 한 시간에 3번까지만 받을 수 있습니다. 넘으면 새 코드를 받거나 한 시간 뒤에 다시 시도해야 합니다. 본인이 요청하지 않았는데 코드 알림이 오면 누군가 주소에 접속한 것이므로 코드를 입력하지 마십시오.

### 기기마다 한 번

기기(브라우저)마다 한 번만 연결합니다. 연결한 뒤에는 "패스키로 들어가기"로 들어가며, 로그인은 30일 동안 쓰지 않으면 풀립니다(쓸 때마다 30일씩 늘어납니다). 연결 정보는 `~/.dotz/web-devices.json`(권한 600)에 저장되고, 로그인 쿠키는 해시만 보관합니다.

### 기기 해제

연결된 기기 목록은 `GET /api/devices`로, 해제는 `DELETE /api/devices/<id>`로 합니다(이미 연결된 기기에서만 가능). 해제하면 그 기기의 로그인은 즉시 끊기고, 다시 쓰려면 코드로 새로 연결해야 합니다. 연결된 기기를 모두 잃었다면 `~/.dotz/web-devices.json`을 지우고 게이트웨이를 다시 시작한 뒤 처음부터 연결합니다. 로컬에서는 `x-dotz-token` 헤더로 계속 접근할 수 있습니다.
