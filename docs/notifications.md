# 알림이 가는 길

dotz가 오너에게 알리는 것은 모두 같은 길을 지나요. 이벤트가 생기고, 분류가 붙고, `hub/notify-route.ts`의 `route()` 한 곳에서
웹앱 알림센터, 휴대폰 푸시, 메신저(Discord, JANDI, Slack/Telegram)마다 보낼지를 정해요. 보내는 쪽이 스위치를 직접 읽지 않아요.

## 분류 (hub/notice-class.ts)

| 분류 | 이름 | 무엇 | 휴대폰 기본값 |
| --- | --- | --- | --- |
| ask | 답변 필요 | [ask] 질문, 발송 승인, 로그인·2차 인증 요청 | 켬 |
| alert | 경고 | 게이트웨이 오류, 끊긴 로그인, 반복 실패하는 감시 | 켬 |
| result | 결과 | 세션·백그라운드 작업의 [done]/[fail] | 켬 |
| news | 새 소식 | 메일, 카톡, 댓글, 감시, 예약 | 켬 (앱별 스위치도 따름) |
| conv | 대화 | 보고 있지 않은 대화의 새 답 | 켬 |
| log | 진행·기록 | [run] 진행, 작업내역 같은 일상 기록 | 끔 |

웹앱 알림 종에 저장된 알림은 바뀌지 않아요. 분류는 읽거나 보낼 때 붙여요(`classOfNotice`, `postClass`).

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

## 설정

- 앱 알림: 설정 → 앱 · 알림에 분류마다 스위치 하나씩(답변 필요, 경고, 결과, 새 소식, 대화, 진행). 웹앱과 휴대폰은 같은 앱이라
  스위치도 하나예요. 끄면 그 분류는 알림(푸시)이 없고 알림 목록(종)에만 남아요. API는 `GET/PUT /api/push/classes`.
- 메신저 알림: 메신저마다 자기 연결 화면 안 '알림' 묶음에서 분류별로 켜고 꺼요.
  JANDI·Slack·Telegram은 설정 → 메신저 → 그 연결(`PUT /api/messengers/<id>` `{notify: {<분류>: bool}}`, 바로 저장되고 재시작 없음),
  Discord는 설정 → Discord('알림' 묶음, `PUT /api/discord/post`). 어느 쪽이든 어디로 갈지는 `route()`가 정해요.
- 저장 위치(기존 키 그대로 읽어요):
  - 휴대폰: `config.json` `notify.push.<분류>` (없으면 위 기본값)
  - Discord: `discord-post.json` (분류 키가 없으면 예전처럼 ask·news·conv는 chat, result는 lanes를 따라요)
  - 다른 메신저: `notify-route.json` `messengers.<어댑터id>.<분류>` (없으면 켬: 예전처럼 다 받아요)
  - 감시 앱별: `custom/apps.json` `<app>.notify`, `<app>.push`, 감시별 `watches.json` `<watch>.push`
- 대화별 Discord 스위치(대화 답장, 세션 보고, 작업내역, 웹에서 시작한 세션)는 설정 → Discord에 남아 있어요.

## 메신저 방

메신저 안의 방은 웹앱 구조를 그대로 따라요: 메인 대화, 프로젝트마다 하나, 알림, 작업내역.
메신저를 켜거나 프로젝트가 생기고 없어지면 방 연결을 자동으로 맞춰요. "방 추가" 같은 수동 단계는 없어요.
메신저가 방을 스스로 만들 수 없는 경우(JANDI 수신 웹훅)에는 설정 → 메신저에 남은 한 단계를 한 줄로 보여 줘요.

## 메일 알림 확인

새 메일(zele, 웹메일 감시)은 Discord 스레드가 있든 없든 웹앱 알림센터에 안 읽음으로 들어오고 휴대폰 푸시도 가요.
`hub/mail-notice.test.ts`가 이 경로를 확인해요(이번 정리 전에도 통과했어요).
