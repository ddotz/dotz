# 알림이 가는 길

dotz가 오너에게 알리는 것은 모두 같은 길을 지나요. 이벤트가 생기고, 분류가 붙고, `hub/notify-route.ts`의 `route()` 한 곳에서
웹앱 알림센터, 휴대폰 푸시, 메신저(Discord, JANDI, Slack/Telegram)마다 보낼지를 정해요. 보내는 쪽이 스위치를 직접 읽지 않아요.

## 분류 (hub/notice-class.ts)

| 분류 | 이름 | 무엇 | 휴대폰 기본값 |
| --- | --- | --- | --- |
| ask | 답변 필요 | [ask] 질문, 발송 승인, 로그인·2차 인증 요청 | 켬 |
| alert | 경고 | 게이트웨이 오류, 끊긴 로그인(어떤 종류로 왔든), 반복 실패하는 감시 | 켬 |
| result | 결과 | 세션·백그라운드 작업의 [done]/[fail] | 켬 |
| news | 새 소식 | 메일, 카톡, 댓글, 감시, 예약 | 켬 (앱별 스위치도 따름) |
| conv | 대화 | 보고 있지 않은 대화의 새 답 | 켬 |
| log | 진행·기록 | [run] 진행, 작업내역 같은 일상 기록, 바뀐 게 없는 감시 보고 | 끔 |

저장된 알림의 분류는 읽거나 보낼 때 붙여요(`classOfNotice`, `postClass`). 그래서 분류 규칙이 바뀌면 이미 저장된 알림도 새 규칙으로 읽혀요.

- 끊긴 로그인: `hub/watchtext.ts`가 쓰는 문구로만 알아봐요. 멈춘 감시의 이유 줄(저장된 비밀번호 없음, 2차 인증 필요), 실패한 점검의 출력이
  로그인 종류(`DOTZ_FAIL login/session/auth/expired`)를 말한 줄(이유 줄 바로 다음 줄이 "로그인이 풀렸어요"), 모델 제공자의 로그인 멈춤 알림(`hub/limit-alert.ts`).
  경고(alert)와 감시 보고(watch)만 해당하고, 메일 제목이나 세션 보고가 같은 말을 인용해도 아니에요(`loginLost`, `isLoginLost`).
- 바뀐 게 없는 감시: 값만 달라진 보고("내용은 그대로이고 시각 같은 값만 바뀌었어요")와 "바뀐 곳은 없어요"로 끝나는 보고(`watchUnchanged`)는 log예요. 모니터링 화면의 기록에는 남아요.

## 경로

1. 만들어지는 곳
   - 대화 답, 세션 보고, 경고: `hub/outbound.ts`(`handOver`, `alert`, `progress`)가 outbox 이벤트를 내요.
   - 세션 보고 중계: `hub/lanerelay.ts`가 세션 보고를 묶어 오케스트레이터에 넘기고, 그 답이 다시 outbound로 가요.
   - 메일: `hub/mail.ts`의 `postMail`이 zele·웹메일 감시의 새 메일을 inbox 이벤트로 내요.
   - 감시·앱: watch 이벤트(inbox)가 내요.
2. 웹앱 알림센터: `hub/notices.ts`가 outbox·inbox 이벤트를 모두 받아 저장해요(`feed`, `fromOutbox`, `fromInbox`).
   제목은 `hub/notice-title.ts`가 만들어요. 감시 앱별 "새 소식 알림"을 끄면(`custom/apps.json` `<app>.notify`, `hub/app-off.ts`)
   알림센터에도 안 들어가요. 그 밖에는 항상 들어가요.
3. 휴대폰: `hub/push.ts`가 이벤트(`classify`)와 새로 안 읽음이 된 알림(`noticePush`)에서 푸시를 만들고, `shouldNotify`가
   `route({cls, app}).push`로 걸러요. 같은 tag는 한 번만 가요. 실제 전송은 `hub/webpush.ts`(VAPID, 암호화)예요.
4. Discord: `hub/outbound.ts`가 보낼 때 `route({target, text, extra, replyTo}).messengers.discord`를 물어요.
   스위치는 `~/.dotz/discord-post.json`(대화 종류 chat/lanes/alert/worklog/web_lanes, 분류 ask/result/news/conv)에 그대로 있어요.
   Discord에서 직접 물은 것의 답은 스위치와 상관없이 Discord로 가고, 웹에서 시작한 세션은 Discord로 가지 않아요.
5. 그 밖의 메신저: `hub/messenger.ts`의 `installFanout`이 outbox 이벤트를 켜진 어댑터(`messenger-jandi.ts`, `messenger-agent.ts`)에 나눠요.
   어댑터마다 `route(...).messengers[id]`가 켜져 있을 때만 보내요. Discord는 native 어댑터(`messenger-discord.ts`)라 fan-out에서 빠져요.

## 알림을 누르면

알림은 만들어질 때 자기 자리를 저장해요: 대화(`src`)와 그 메시지의 이벤트 시각(`at`), 메시지가 다른 대화에 있으면 `msg`. 푸시도 같은 것을 실어요(`url`, `ts`, 알림 id `nid`).
어디서 누르든(푸시, 알림 목록, 토스트, 홈) `web/js/30-notices.js`의 `noticeOpen` 하나로 가요. 푸시 url은 `/#chat/alert`이고, 푸시에 알림 id(`nid`)가 있으면 `noticeOpen`으로 가고, 없으면 알림 화면을 열어요.

| 알림 | 여는 곳 |
| --- | --- |
| 세션 보고 | 그 세션의 그 보고 |
| 질문, 발송 승인 | 그 대화의 묻는 메시지, 그 위에 결정 시트 |
| 경고 | 알림 대화의 그 메시지, 실패면 그 위에 상세 시트. 알림 대화는 채팅 목록에는 없고 이 이동으로만 열려요 |
| 메일 | 모니터링 안의 그 메일 |
| 감시, 예약 | 모니터링에서 그 소식 행을 펼친 채로 |
| 카톡, 댓글 | 그 앱 화면(소식 행이 없고, 카톡은 알림이 방을 가리키면 그 방) |
| 대화 답, 작업내역 | 그 대화의 그 메시지 |

이전 기록은 필요한 만큼 더 불러오고, 대상 메시지는 잠깐 강조돼요. 메시지가 지워졌으면 가까운 곳을 열고 짧은 토스트로 알려요.

최근 끝난 작업(홈)과 프로젝트의 작업·결과·최근 세션 행도 같은 이동을 써요. 끝난 워커는 그 요청에 대한 답 메시지(`result_at`, `result_conv`, `hub/bgwork.ts`)로, 끝난 세션은 그 세션의 보고로 가요. 그런 메시지가 없으면 끝난 시각에 가장 가까운 곳을 열고 같은 토스트를 보여줘요.

앱이 꺼져 있어도 먼저 그려요. 푸시가 도착하면 서비스 워커가 그 대화의 최근 메시지 60개를 읽어 이 기기의 IndexedDB(`dotz-snap`)에 넣고, 앱은 네트워크 답을 기다리지 않고 거기서 그 메시지를 그린 뒤 뒤에서 제자리 갱신해요(`web/js/13-snapshot.js`). 대화는 최근 8개까지 두고, 메일과 다른 컴퓨터의 대화는 넣지 않아요. 이 기기의 연결이 해제되면(403 `X-Dotz-Pair`, 또는 설정에서 이 기기 해제) 지워요.

## 웹앱 알림센터 (알림 화면)

알림센터는 대화가 아니라 독립 화면이에요. 목록에 오르는 것은 `id`가 있고 분류가 log·conv가 아닌 알림이에요.
hub가 각 알림 선에 `cls`와, 처리할 것이면 `waits`("fail" 실패, "login" 끊긴 로그인)를 실어 보내요(`withClass`: 목록 `GET /api/notices`와 `kind:"notice"` 방송 프레임 둘 다).
`waits`는 저장하지 않고 읽을 때 계산해요.

묶음은 이렇게 나뉘어요.

| 묶음 | 무엇 | 오른쪽 칸 |
| --- | --- | --- |
| 처리할 것 | 답변이 필요한 것(`needsAnswer`), `waits`가 있는 것 | 실패 ✕(처리함), 그 밖 ›(처리해야 사라져요) |
| 새 소식 | 그 밖의 안 읽은 것 | 읽음 |
| 지난 알림 | 나머지 | 지우기 ✕ (토스트의 "실행 취소"로 되돌려요) |

반복이 접힌 행(`repeats`)은 ▾로 펼쳐요. 종 숫자와 필터 숫자는 목록 대상의 안 읽은 개수예요. hub의 `unread`(`notices_unread`)는 그대로예요.

### 읽음·처리·반복

- 읽음은 누르기, ✕, 모두 읽음(`POST /api/notices/read`의 ids)으로만 해요. 대화를 보거나(`POST /api/read`, `POST /api/viewing`) 웹에서 대화에 글을 써도
  알림은 읽히지 않아요. 예외 셋: 그 대화에 와 있던 새 답(분류 conv의 `msg:<대화>` 행)은 대화를 읽으면 읽혀요, 메일 대화를 열면 그 메일의 새 메일 알림이 읽혀요(메일을 연 것이 그 행을 누른 것이에요),
  메신저(웹이 아닌 채널)에서 그 방에 쓴 글은 그 방의 앞 알림을 읽어요. 읽기 위치가 이미 지나간 뒤에 만들어진 알림이 읽힌 채 태어나는 것도 새 답(conv)만 해요.
- 처리: 새 실패·끊긴 로그인은 `handled: null`(기다리는 중)로 만들어져요. 읽어도 자리에 남아요. 닫히는 길은 실패가 ✕(`POST /api/notices/<id>/handled`, 기다리는 실패가 아니면 409),
  같은 `key`가 [done]이 되는 재실행 성공, 그 감시가 다시 정상(`watchRecovered`: 감시 이벤트의 recovered, 메신저로 간 "<이름>: 다시 정상이에요"), 끊긴 로그인은 복구 신호뿐이에요
  (감시가 다시 정상, 모델 제공자의 "다시 연결됐어요" 알림). 닫히면 `handled`는 시각이에요. 반복이 닫힌 실패를 다시 열지 않고, 진짜 새 실패(새 항목, 또는 다른 tone에서 fail로 바뀜)는 다시 `null`이에요.
  `handled` 칸이 없는 예전 알림은 안 읽었으면 기다리는 중, 읽었으면 지난 알림으로 읽고(저장 파일은 고치지 않아요), 안 읽은 예전 실패를 읽으면 `null`로 바뀌어 새 알림처럼 남아요.
- 지우기와 되돌리기: `POST /api/notices/<id>/dismiss`, `POST /api/notices/<id>/undismiss`.
- 반복: 같은 경고가 6시간 안에 다시 오면(`hub/alert-gate.ts`) 그 행을 제자리에서 덮어쓰고 이전 값을 `repeats`에 넣어요. 같은 감시(`watch`, 없으면 제목)의 새 보고가
  24시간 안의 머리 행과 tone이 같고 카드(`item`)가 없으면 그 행에 접히고 안 읽음으로 돌아와요. 바뀐 게 없는 감시(log)는 접지 않아요. `repeats`는 최신이 앞이고 항목당 20개, 한 개 160자까지예요.
  접힌 감시 보고도 보고마다 푸시가 가요(`hub/push.ts`의 tag에 보고 시각이 붙어요). 반복된 경고는 푸시하지 않아요.

## 설정

- 앱 알림: 설정 → 앱 · 알림에 분류마다 스위치 하나씩(답변 필요, 경고, 결과, 새 소식, 대화, 진행). 웹앱과 휴대폰은 같은 앱이라
  스위치도 하나예요. 끄면 그 분류는 알림(푸시)이 없고 알림 목록(종)에만 남아요. API는 `GET/PUT /api/push/classes`.
- 메신저 알림: 메신저마다 자기 연결 화면 안 '알림' 묶음에서 분류별로 켜고 꺼요.
  JANDI·Slack·Telegram은 설정 → JANDI/Slack/Telegram 화면의 알림 묶음(`PUT /api/messengers/<id>` `{notify: {<분류>: bool}}`, 바로 저장되고 재시작 없음),
  Discord는 설정 → Discord('알림' 묶음, `PUT /api/discord/post`). 어느 쪽이든 어디로 갈지는 `route()`가 정해요.
- 저장 위치(기존 키 그대로 읽어요):
  - 휴대폰: `config.json` `notify.push.<분류>` (없으면 위 기본값)
  - Discord: `discord-post.json` (분류 키가 없으면 예전처럼 ask·news·conv는 chat, result는 lanes를 따라요)
  - 다른 메신저: `notify-route.json` `messengers.<어댑터id>.<분류>` (없으면 켬: 예전처럼 다 받아요)
  - 감시 앱별: `custom/apps.json` `<app>.notify`, `<app>.push`, 감시별 `watches.json` `<watch>.push`
- 대화별 Discord 스위치(대화 답장, 세션 보고, 작업내역, 웹에서 시작한 세션)는 설정 → Discord에 남아 있어요.

## 메신저 방

메신저 안의 방은 웹앱 구조를 그대로 따라요: 메인 대화, 프로젝트마다 하나, 알림, 작업내역. 단, 웹앱 알림은 독립 화면이어도 메신저의 알림 방은 그대로 둬요(오너 결정, RULES 11-02).
메신저를 켜거나 프로젝트가 생기고 없어지면 방 연결을 자동으로 맞춰요. "방 추가" 같은 수동 단계는 없어요.
메신저가 방을 스스로 만들 수 없는 경우(JANDI 수신 웹훅)에는 설정 → 메신저에 남은 한 단계를 한 줄로 보여 줘요.

## 메일 알림 확인

새 메일(zele, 웹메일 감시)은 Discord 스레드가 있든 없든 웹앱 알림센터에 안 읽음으로 들어오고 휴대폰 푸시도 가요.
`hub/mail-notice.test.ts`가 이 경로를 확인해요(이번 정리 전에도 통과했어요).
