# 메신저 연결 (관리자 안내)

dotz는 웹앱의 대화와 같은 대화를 메신저로도 주고받습니다. 메신저는 하나만 켜도 되고 여러 개를 함께 켜도 됩니다. 메신저에서 받은 메시지는 웹에서 쓴 것과 똑같이 처리되고, 답은 켜져 있는 모든 메신저와 웹앱에 함께 갑니다. 메신저 하나가 끊겨도 나머지는 그대로 동작합니다.

## 어디서 설정하는가

웹앱의 **설정 -> 메신저** 화면에서 메신저마다 연결 상태, 말을 걸 수 있는 사람(허용 목록), 방(채팅), 연결 테스트를 다룹니다.

- 토큰과 웹훅 URL 같은 비밀값은 화면에 다시 나타나지 않고 "설정됨" 여부만 보입니다. 비워 두고 저장하면 기존 값이 유지됩니다.
- 잘못된 값이 하나라도 있으면 저장 전체가 거부되고 아무것도 바뀌지 않습니다.
- 설정 파일은 `<DATA_DIR>/messengers/` 아래에 권한 0600으로 저장됩니다.

## 메신저별 안내

| 메신저 | 받는 방식 | 안내 |
|---|---|---|
| Discord | 봇이 Discord에 접속 | 아래 "Discord" 절 |
| JANDI (사내 설치형) | 사내망 웹훅 | [jandi.ko.md](jandi.ko.md) |
| Slack, Telegram | agent-messenger 패키지 | [agent-messenger.ko.md](agent-messenger.ko.md) |

### Discord

1. Discord Developer Portal에서 dotz 전용 봇을 만들고 **MESSAGE CONTENT intent**를 켭니다.
2. 봇 토큰을 설치 과정(`setup`)에 넣고, 출력된 초대 링크로 서버에 봇을 초대합니다.
3. 게이트웨이가 봇 이름으로 카테고리 두 개(메인 채널용, 프로젝트 채널용)를 만듭니다. 설정한 소유자 ID만 명령할 수 있습니다.

Discord의 토큰과 서버 설정은 **설정 -> Discord** 화면에서 바꿉니다. 메신저 화면에서는 상태만 보여 줍니다. Discord를 쓰지 않으면 프로젝트에는 `ch:<번호>` 형태의 로컬 번호가 붙고, 다른 메신저와 웹앱은 그대로 동작합니다.

## Tailscale 없이 쓰기

메신저는 Tailscale이 없어도 동작합니다. Discord와 Slack, Telegram은 dotz가 바깥으로 접속하고, JANDI는 사내망 웹훅으로 들어옵니다.

웹앱을 Tailscale 없이 밖에서 열려면 `web.access`를 `"cloudflare"`로 바꾸고 Cloudflare 터널을 씁니다. 이 모드에서는 패스키로 연결한 기기만 웹앱에 들어올 수 있고, 연결 코드는 메신저 알림으로 옵니다. 메신저 메시지에는 웹앱의 해당 대화로 가는 "웹에서 보기" 링크가 붙습니다(현재는 JANDI). 자세한 순서는 [../web-access-cloudflare.ko.md](../web-access-cloudflare.ko.md)에 있습니다.

| `web.access` | 웹앱 접속 | 기본값 |
|---|---|---|
| `tailscale` | 테일넷 안에서만 | 예 |
| `cloudflare` | Cloudflare 고정 주소, 패스키 기기만 | |
| `local` | 이 컴퓨터에서만 | |
