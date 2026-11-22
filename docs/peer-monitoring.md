# Merged 모니터링 across gateways (peer contract)

Every dotz gateway of one owner on one tailnet shows the 모니터링 of all of them together. What a watch, app or mail
account does on one computer is visible from the others. An action taken from another computer is forwarded to the
gateway that owns the item. That gateway executes it and records it.

## Peers

- Peer list: `knownComputers()` in `hub/peers.ts`. It uses `tailscale status --json` discovery (`web.peer_discovery`, default on)
  plus the `web.peers` URLs in config.
- Peer auth: `hub/peer-auth.ts`. A peer request must pass two gates. The request comes through `tailscale serve`, so it
  carries `Tailscale-User-Login`. The request also carries the shared token as `x-dotz-peer`. The token is in
  `<data dir>/secrets/peer-token` and is the same value on every gateway. It is never written to config, prompts or logs.
- Auto pairing: `hub/peer-pair.ts`. No setup is needed between two nodes of one tailscale login. A gateway asks a discovered peer
  (`POST /api/peer/pair`); the peer issues a token only when the request carries `Tailscale-User-Login` equal to the login it runs as
  (a tagged node, a different user or a request outside the tailnet is refused with a Korean reason). Tokens are 0600 files in
  `secrets/peer-pairs/in` (accepted) and `out` (sent). The pairing starts on discovery or the first action and renews itself on a 403.
  The manual `peer-token` keeps working.
- Binding: pairing also binds both gateways to each other in `secrets/peer-pairs/bound.json` (0600; peer host name -> dotz URL, at most 32).
  Discovery asks the bound URL first and scans ports only when it no longer answers as dotz (the new port is bound then), so one port
  number can be another app on another computer. A bound peer that tailscale reports offline stays in the list as '연결 안 됨'; an unbound one does not.
  A request that carries `x-dotz-peer` can reach only the read-only GET list and the peer POSTs: `/api/peer/act`,
  `/api/peer/lease`, `/api/peer/limit-lift` and `/api/peer/mail-code`.
- Setup (`setup.ts`) makes the key on the first computer. On another computer, setup asks for that key (or takes
  `peer_token` in an answers file) and stores it 0600. A rerun keeps the key.
- No token file: reads still work through the owner's tailnet identity (the same way the computer switcher works).
  Forwarded actions and send leases need the token, so the item is read-only on the other computer.
- An older peer answers 404 to `/api/peer/monitoring`. The hub then builds that peer's snapshot from its `/api/monitors`,
  `/api/notices`, `/api/integrations` and `/api/conversations?all=1` (every row, not one page), and marks it `legacy`.

## Reads (owning gateway answers, any gateway asks)

- `GET /api/peer/monitoring` returns one snapshot: `{ name, rev, monitors, notices, integrations, conversations }`. The
  lists use the same shapes as `/api/monitors`, `/api/notices`, `/api/integrations` and the `mail:` / `kakao:`
  rows of `/api/conversations`. It sends an `ETag` (`rev`) and answers `304` to `If-None-Match`.
- Detail reads go through the existing read-only GETs (`/api/history`, `/api/mail/<k>/body`, `/api/mail/<k>/files/<n>`, `/api/kakao/...`).
- `GET /api/peer/projects` answers `{ name, projects }` for the 프로젝트 list's computer groups (`docs/customization.md`,
  Projects by computer): the computer's own projects by key, name and purpose only.

## One rendering path (web)

- A peer item has the same data shape as a local one, so it goes through the same renderers: the mail row (`monConvNode`), the notice card,
  the chat view with the mail original and files, and the Kakao pane (rooms, bubbles, composer). Only the machine label is peer-only.
  A peer's open decision (a mail reply-draft approval included) is the same card as a local one and is answered from here: `ntPost` sends it
  to the owner as `answer` (`pqNotice`), and the owner's notice replaces the snapshot copy. A peer's loose `[ask]` report still has no 답하러 가기.
- `pqMail` (`web/js/34-peer-monitoring.js`) puts a peer's mail into `MAILS`, `CONV` and the unread count. `api()` runs each request through
  `pqRoute`: a read of a peer's mail, history or Kakao room becomes `/api/peer/proxy?pc=..&p=<path>`; `pqLink(path)` does the same for `fetch`
  and download links. A POST that belongs to a peer (`/api/message` for its mail, `/api/read`, `/api/kakao/...` send, read and draft, `/api/reply/act`)
  becomes `/api/peer/act`. A new route that a peer item uses needs a line in `pqFor` (read) or `pqAct` (action) and in `PEER_GET` (`hub/peer-auth.ts`).
- A mail that this computer also holds stays a local row, unless this computer switched the mail app off (`available[].off` of `/api/integrations`): then the peer's copy shows.
- 이 기기에서 쓰기 (off) and 제거 are per machine (`custom/apps.json`, `hub/app-off.ts`). Turning mail off here never hides what a peer shows. An app's switch,
  settings, 제거 and 앱 추가 for a peer's app go to the owning machine with `/api/peer/act` action `app` (`op`: settings with `values`, remove with `deleteData`, add; create a new instance with `app` = the app key, `label`, `filter`; delete an off instance with `deleteData`). An app can have several instances (two mail accounts: ids `mail`, `mail-2`; `custom/apps.json`, `hub/integrations.ts` appEntries); a peer's rows show each instance's own name.

## Local hub side (the browser keeps one origin and one auth)

- `GET /api/monitoring/peers` returns `[{ name, url, online, stale, items: <snapshot> | null }]`. The answer comes from
  a cache and does not fan out on each render. The hub refreshes a peer when that peer's event stream (`hub/peer-stream.ts`)
  reports a change, and also every 20 s with `If-None-Match`. The timeout is 2.5 s. A peer that does not answer is
  `online:false`, and the page shows '연결 안 됨' for it.
- `GET|POST /api/peer/proxy?pc=<peer origin>&p=<path>` proxies to a peer. `pc` must be an origin in `knownComputers()`
  (no free URLs). GET is allowed only for the peer read list. POST is allowed only for `/api/peer/act`.

## Actions (forwarded, executed by the owner)

- `POST /api/peer/act {action, args, from}` on the owning gateway. The actions are `message` (a reply or a confirmed draft
  in a conversation), `answer` (a decision, with `note` for 고치기), `notice` (`op` read with `ids`, ignore or unignore with `id`), `read` (mark read), `watch` (pause, resume or run a watch) and `kakao`
  (`op` send, read, draft, ask-drop or room on the owner's `/api/kakao/...` routes), `comments` (`op` draft, no-reply, read or source) and `reply` (`args` = the
  body of the owner's own `POST /api/reply/act`: every draft action of every kind, KakaoTalk and comment drafts included). `handoff` (`owner_words`, `note`, `id?`: the owner's work handed over from the sender; it lands in the owner's main chat as the owner's own instruction, then the owner sends `handoff-ack` back, fire and forget) and `handoff-ack` (`id`: a note in the sender's chat that the other computer took it). The owner runs
  the same handler as its own web app. It records the event with `via: <from machine name>`. Its own web and history show
  the action the same as a local action, with a small 'from <machine>' note. The other gateway keeps no copy beyond its cache.

## App messages across computers (`hub/app-sync.ts`)

- KakaoTalk uses `messageId()` in `hub/kakao/contract.ts` (`k:<chatId>:<logId>`, else `h:<chatId>:<hash>`). It follows the
  same rule. Its `dispatchSend` lease hook is wired in `hub/kakao/gateway.ts` to `claimLease` (key `kakao:<chatId>`, 60 s):
  the computer that sent last keeps the room for 60 s, and the other computer's send is refused with the holder's name.
- Stable message id for other apps (`stableMsgId`): `<app>:<room key>:<app id>` when the app exposes its own id. KakaoTalk `logId` is server-assigned,
  so it is the same on every PC. Without an app id, the id is `<app>:<room key>:h<sha1(sender|sentAt ms|text)>`. The id
  never depends on the collecting computer.
- `collector`: the machine name that read the message. It is information only and is not part of the id.
- Merge: dedupe by id. State (read, draft status) converges by last writer: the higher `updatedAt` wins, and ties go
  to the gateway that holds the send lease.
- Send exactly once: before a gateway sends a reply or a confirmed draft, it claims the lease for `<app>:<room key>` from
  every online peer through `POST /api/peer/lease {op:"claim", key, holder, until}`. A peer refuses (`ok:false, holder`)
  when it holds a lease that has not expired, or when it already recorded the draft id as sent. The sender is the computer
  that is logged in to the app now. After the send, `op:"sent", key, id` records the draft id on every peer.
  A refused claim does not send and reports the holder.

## 모니터마다 대화

모든 감시(로컬과 피어)는 그 감시를 가진 컴퓨터의 오케스트레이터와 대화합니다. 대화 대상은 `settings:w:<감시 이름>`이고, 피어 감시의 메시지와 스위치는 `/api/peer/act`의 `message`와 `watch settings`로 그 컴퓨터에 갑니다. 답은 그 컴퓨터에 쓰이고, 열린 대화가 프록시로 기록을 다시 읽어 보여 줍니다. 실패한 감시에는 '다시 로그인해 줘'(로그인 유지만), '원인 찾아 줘', '일시정지' 칩이 입력칸을 채웁니다. 예약(schedule)에는 설정이 없어서 아직 대화가 없습니다.

## Reply cards across computers

The snapshot carries `reply: { items }`, the gateway's one reply queue (`GET /api/reply/queue`); an older gateway leaves it out. A card's action on another computer's item goes as `POST /api/peer/act` with `{ action: "reply", args }`, where `args` is the same body the page posts to its own `POST /api/reply/act`, and it runs there through that gateway's queue (undo window, lease, retries).

## Mail codes (a site's login code, for a computer with no mail)

A computer without mail (no zele) takes a site's mailed login code from another gateway that has mail, so the owner is not asked. The code is the only
thing of the mail that moves; it is never typed in chat, put in a prompt, a notice, an event, Discord, a log line or an answer's JSON. Code in `hub/mail-otp.ts`.

- `POST /api/peer/mail-code {from, account?, minutes?}` on the gateway with mail. `from` is a domain or an address (no spaces, quotes or filter operators),
  `account` a zele account, `minutes` 1..60 (default 10). Only a request that passed the peer gates is answered (`checkPeer` "ok"); the hub token or a web
  login without `x-dotz-peer` gets 403. It lists the sender's newest 5 threads (`zele mail list --filter "from:<from> newer_than:1d"`), reads the newest first,
  and takes the code (4 to 8 digits, or 4 to 8 capitals and digits with a digit) from the sender's messages dated inside the window, newest first.
  A keyword (인증/확인/보안 코드·번호, verification, one-time, passcode, OTP, code) on the number's line or up to two lines above it decides; years, times, phone parts,
  amounts and links never count; two different best candidates are `ambiguous`. It looks up to 3 times, 15 s apart (45 s in all). Answer:
  `{ok:true, code}` or `{ok:false, reason: "no-mail"|"not-found"|"ambiguous"|"already-given"|"error", detail}` (a short Korean reason). A code is given once per
  sender for an hour (remembered as a hash, in memory), and overlapping requests for one sender share one look.
- `POST /api/auth/mail-code {site, from, account?, minutes?}` on the gateway that asks (hub token only). With zele on here it looks in this mailbox; otherwise it asks
  the other gateways in turn (60 s each; a peer with no mail, no token or an older version is skipped; the first code wins). The code is written to
  `secrets/once/mail-<site>-<id>` (0600, sealed) and the answer is `{ok:true, id, take: "/api/auth/<id>/take"}`. A failure is `{ok:false, reason, detail}` with HTTP 200.
- `GET /api/auth/<id>/take` (hub token only) gives the code once and deletes the file; the second call is 410. An untaken code is deleted after 5 minutes.
  The request's view (`GET /api/auth/<id>`) shows no path.
- `dotz_auth` (kind `otp`) takes `from_mail`, `mail_account` and `mail_minutes`; when no code comes it falls back to asking the owner, with the reason added to the purpose.
- Log lines carry the sender's domain and the outcome only (`mail code: example.com not-found`).
