# Slack / Telegram 연결 (agent-messenger)

dotz는 [agent-messenger](https://github.com/agent-messenger/agent-messenger) 패키지를 통해 Slack과 Telegram을 메신저로 연결합니다. 패키지는 선택 사항이며, 설치되어 있지 않으면 설정 화면에 이 항목이 나타나지 않습니다.

## 1. agent-messenger 설치

dotz를 실행하는 머신에서 한 번만 설치합니다.

```sh
bun add -g agent-messenger
```

설치하면 SDK(`agent-messenger/slackbot`, `agent-messenger/slack`, `agent-messenger/telegrambot`)와 CLI(`agent-slackbot`, `agent-slack`, `agent-telegrambot`, `agent-telegram`)가 함께 들어옵니다. dotz는 SDK를 먼저 쓰고, SDK를 찾지 못하면 PATH에 있는 CLI를 호출합니다.

- SDK 경로: 설정 파일의 `token`을 그대로 사용합니다. 메시지 수신, 전송, 수정, 읽음 표시(눈 이모지)가 모두 동작합니다.
- CLI 경로: CLI가 따로 저장한 인증 정보(`agent-slackbot auth set ...`)를 사용합니다. Telegram 봇 CLI는 메시지를 읽는 명령이 없어 수신이 되지 않습니다. Telegram 수신이 필요하면 SDK를 설치합니다.

## 2. 설정 파일

`<DATA_DIR>/messengers/agent.json` (권한 0600)에 저장하며, 설정 화면에서도 같은 내용을 편집할 수 있습니다. 토큰이 들어 있으므로 파일 권한을 바꾸지 않습니다.

```json
{
  "enabled": true,
  "connections": [
    {
      "id": "work-slack",
      "platform": "slack",
      "auth": "bot",
      "token": "xoxb-...",
      "allow": ["U01ABCDEF"],
      "chats": [
        { "id": "C01MAIN", "name": "dotz", "kind": "main" },
        { "id": "C02PROJ", "name": "dotz-api", "kind": "project", "project": "ch:123456789" },
        { "id": "C03ALRT", "name": "dotz-alert", "kind": "alert" },
        { "id": "C04WORK", "name": "dotz-log", "kind": "worklog" }
      ]
    }
  ]
}
```

- `allow`: 명령을 내릴 수 있는 소유자의 사용자 ID 목록입니다. 여기에 없는 사람이 보낸 메시지는 읽지도, 반응하지도 않습니다. Slack은 `U`로 시작하는 멤버 ID, Telegram은 숫자 사용자 ID입니다.
- `chats[].kind`: `main`(기본 대화), `project`(프로젝트별 대화, `project`에 `ch:<디스코드 채널 ID>` 지정), `alert`(알림), `worklog`(작업 기록)입니다.
- `auth`: `bot` 또는 `user`입니다. 사용자 토큰(`user`)을 쓰는 Slack은 `cookie`(`xoxd-...`) 항목이 하나 더 필요합니다.
- 연결 추가나 `enabled` 변경은 dotz를 다시 시작해야 반영되고, `allow`와 `chats` 변경은 바로 반영됩니다.

동작 방식은 다음과 같습니다.

- 새 작업은 새 스레드로 시작하고, 후속 메시지는 같은 스레드에 이어서 올라갑니다(스레드 기록은 `agent-threads.json`에 최대 200개까지 보관합니다).
- 진행 상황은 같은 메시지를 수정해서 갱신합니다. 수정할 수 없는 환경에서는 진행 메시지를 건너뛰고 마지막 결과만 올립니다.
- 선택지가 있는 질문은 `1) ... 2) ...` 형태로 붙으며, 번호만 답하면 됩니다.
- 인용하거나 전달한 메시지는 명령이 아니라 참고 내용으로만 전달됩니다.
- 메시지를 받으면 눈 이모지로 읽음 표시를 합니다.

## 3. Slack

### 봇 토큰과 사용자 토큰 중 고르기

| | 봇 토큰 (`xoxb-`) | 사용자 토큰 (`xoxc-` + `xoxd-`) |
| --- | --- | --- |
| 보내는 사람 | 봇 계정 | 관리자 본인 계정 |
| 유료 멤버 자리 | 사용하지 않음 | 사용함 |
| 볼 수 있는 대화 | 초대된 채널만 | 그 멤버가 볼 수 있는 모든 대화 |

사용자 토큰은 본인 계정으로 메시지가 나가고 본인이 볼 수 있는 모든 대화가 보이므로, 특별한 이유가 없으면 봇 토큰을 권장합니다.

### 봇 만들기

1. https://api.slack.com/apps 에서 새 앱을 만듭니다.
2. **OAuth & Permissions**의 Bot Token Scopes에 다음을 추가합니다.
   - `chat:write` (메시지 전송과 수정)
   - `channels:history`, `groups:history` (공개/비공개 채널 읽기)
   - `reactions:write` (읽음 표시)
   - `channels:read`, `groups:read` (채널 목록, 선택)
3. 워크스페이스에 앱을 설치하고 `xoxb-`로 시작하는 Bot User OAuth Token을 복사해 `token`에 넣습니다.
4. 사용할 채널마다 봇을 초대합니다. 채널에서 `/invite @봇이름`을 입력합니다. 초대하지 않은 채널은 읽고 쓸 수 없습니다(`not_in_channel`).
5. 채널 ID는 채널 이름을 눌러 열리는 상세 창 맨 아래(`C...`)에서 확인합니다. 소유자 ID는 본인 프로필의 더보기에서 멤버 ID(`U...`)를 복사합니다.

## 4. Telegram

1. Telegram에서 [@BotFather](https://t.me/BotFather)에게 `/newbot`을 보내 봇을 만들고, 받은 토큰을 `token`에 넣습니다(`platform`은 `telegram`, `auth`는 `bot`).
2. 봇과 대화를 시작합니다. 봇은 먼저 말을 걸 수 없으므로 소유자가 봇에게 `/start`를 한 번 보내야 합니다.
3. 그룹에서 쓰려면 봇을 그룹에 추가하고, BotFather의 `/setprivacy`에서 Privacy mode를 끕니다. 끄지 않으면 봇이 그룹의 일반 메시지를 받지 못합니다.
4. 채팅 ID를 확인합니다. 봇에게 메시지를 보낸 뒤 `https://api.telegram.org/bot<토큰>/getUpdates`를 브라우저에서 열어 `chat.id`를 찾습니다. 개인 대화는 양수, 그룹은 음수, 슈퍼그룹과 채널은 `-100...` 형태입니다. 이 값을 `chats[].id`에 넣습니다.
5. 소유자 ID는 같은 응답의 `from.id`(숫자)이며 `allow`에 문자열로 넣습니다.

같은 봇에서 `getUpdates`를 동시에 읽는 프로그램이 하나만 있어야 합니다. 다른 프로그램이나 웹훅이 이미 읽고 있으면 `Conflict` 오류가 납니다.

## 5. 확인

설정 화면(또는 `connStatus()`)에서 채팅별 마지막 수신 시각, 마지막 전송 시각, 마지막 오류를 볼 수 있습니다. 오류 메시지에는 토큰이 들어가지 않습니다. 수신은 연결당 5초 간격으로 확인하고, 오류가 나면 최대 60초까지 간격을 늘리며, 5분 넘게 조용하면 15초 간격으로 줄입니다.
