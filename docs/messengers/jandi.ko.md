# JANDI 연결 (관리자용)

dotz는 사내 JANDI 서버와 사내망(LAN)에서 바로 연결됩니다. Tailscale은 필요하지 않습니다.
dotz가 직접 포트를 하나 열고, JANDI의 Outgoing Webhook이 그 주소로 메시지를 보냅니다. dotz의 답은 Incoming Webhook으로 JANDI에 올라갑니다.

## 1. 토픽 만들기

JANDI에서 다음 토픽을 만듭니다.

- 메인 대화: dotz와 일상 대화를 나누는 토픽입니다.
- 프로젝트 토픽: 프로젝트마다 하나씩 만듭니다. 토픽 하나가 dotz 프로젝트 채널(`ch:<채널 ID>`) 하나와 연결됩니다.
- 알림: 경고와 선택 질문(`[ask]`)이 올라오는 토픽입니다.
- 작업 기록(선택): 작업 기록을 따로 모아 보고 싶을 때만 만듭니다.

## 2. 토픽마다 웹훅 두 개 만들기

각 토픽에서 `커넥트(Connect)`를 열고 아래 두 가지를 추가합니다.

1. **Incoming Webhook**: 만든 뒤 나오는 웹훅 URL을 복사합니다. dotz가 이 주소로 글을 올립니다.
2. **Team/Outgoing Webhook**: 설정은 다음과 같이 합니다.
   - 키워드: `/땅콩` 처럼 정합니다. 이 키워드로 시작하는 글만 dotz에 전달됩니다.
   - URL: `http://<dotz 컴퓨터의 LAN IP>:<포트>/jandi/<방 ID>`
   - 만든 뒤 나오는 토큰을 복사합니다.

방 ID는 설정 파일에서 정하는 영문, 숫자, `-`, `_` 이름입니다(예: `main`, `alert`, `proj-web`). 토픽마다 서로 달라야 합니다.
Outgoing Webhook 사용 방법은 JANDI 안내를 참고합니다: https://support.jandi.com/ko/articles/connect-team-outgoing-webhook-aea2650b

## 3. 설정 파일

`<DATA_DIR>/messengers/jandi.json` (권한 0600, 소유자만 읽기·쓰기)

```json
{
  "enabled": true,
  "listen": { "host": "0.0.0.0", "port": 8787 },
  "allow_emails": ["boss@company.com"],
  "allow_names": [],
  "rooms": [
    { "id": "main", "name": "메인 대화", "kind": "main", "outgoing_token": "<토큰>", "incoming_url": "<Incoming Webhook URL>" },
    { "id": "proj-web", "name": "웹 프로젝트", "kind": "project", "project": "ch:123456789", "outgoing_token": "<토큰>", "incoming_url": "<URL>" },
    { "id": "alert", "name": "알림", "kind": "alert", "outgoing_token": "<토큰>", "incoming_url": "<URL>" },
    { "id": "worklog", "name": "작업 기록", "kind": "worklog", "outgoing_token": "<토큰>", "incoming_url": "<URL>" }
  ]
}
```

- `kind`는 `main`, `project`, `alert`, `worklog` 중 하나입니다. `project`는 `project`에 연결할 채널(`ch:<ID>`)을 함께 적습니다.
- 토큰과 웹훅 URL은 비밀입니다. 로그나 화면 공유에 노출하지 않습니다.
- 파일을 고치면 방, 토큰, 허용 목록은 바로 적용됩니다. `listen`(주소·포트)과 `enabled`는 dotz를 다시 시작해야 바뀝니다.

## 4. 허용 목록

- `allow_emails`: dotz에 명령할 수 있는 사람의 이메일입니다. 여기에 없는 사람의 글은 거부됩니다(403).
- `allow_names`(선택): Outgoing Webhook이 이메일을 보내지 않는 경우에만 쓰는 이름 목록입니다. 이름은 이메일보다 약한 식별이므로 꼭 필요할 때만 켭니다.
- 토큰이 틀리면 허용 목록과 관계없이 거부됩니다(401).

## 5. 동작 방식과 한계

- 키워드를 뺀 본문만 dotz에 전달됩니다. 보낸 즉시 `받았어요`라는 짧은 확인이 오고, 실제 답은 Incoming Webhook으로 따로 올라옵니다.
- 알림 토픽에 올라온 선택 질문에는 `/땅콩 1` 처럼 번호로 답합니다.
- JANDI는 올린 글을 고칠 수 없어서 진행 상황 갱신은 올리지 않습니다. 완료·실패·질문 같은 최종 글만 올라옵니다.
- 4000자를 넘는 글은 여러 개로 나뉘어 올라옵니다.

## 6. 방화벽

- dotz 컴퓨터는 `listen.port`로 들어오는 연결을 사내망에서 허용해야 합니다. 예: macOS 방화벽에서 dotz(bun)의 수신 허용.
- 사내망 안에서만 쓰는 구성입니다. 포트를 인터넷에 공개하지 않습니다. 사내망만 쓰려면 `listen.host`를 LAN IP로 고정합니다.
- JANDI 서버에서 dotz 컴퓨터의 LAN IP로 접근할 수 있어야 하고, dotz 컴퓨터에서는 JANDI Incoming Webhook 주소로 나가는 연결이 되어야 합니다.
