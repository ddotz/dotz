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
  A request that carries `x-dotz-peer` can reach only the read-only GET list and two POSTs: `/api/peer/act` and
  `/api/peer/lease`.
- No token file: reads still work through the owner's tailnet identity (the same way the computer switcher works).
  Forwarded actions and send leases need the token, so the item is read-only on the other computer.
- An older peer answers 404 to `/api/peer/monitoring`. The hub then builds that peer's snapshot from its `/api/monitors`,
  `/api/notices`, `/api/integrations` and `/api/conversations`, and marks it `legacy`.

## Reads (owning gateway answers, any gateway asks)

- `GET /api/peer/monitoring` returns one snapshot: `{ name, rev, monitors, notices, integrations, conversations }`. The
  lists use the same shapes as `/api/monitors`, `/api/notices`, `/api/integrations` and the `mail:` / `kakao:`
  rows of `/api/conversations`. It sends an `ETag` (`rev`) and answers `304` to `If-None-Match`.
- Detail reads go through the existing read-only GETs (`/api/history`, `/api/mail/<k>/body`, `/api/kakao/...`).

## Local hub side (the browser keeps one origin and one auth)

- `GET /api/monitoring/peers` returns `[{ name, url, online, stale, items: <snapshot> | null }]`. The answer comes from
  a cache and does not fan out on each render. The hub refreshes a peer when that peer's event stream (`hub/peer-stream.ts`)
  reports a change, and also every 20 s with `If-None-Match`. The timeout is 2.5 s. A peer that does not answer is
  `online:false`, and the page shows '연결 안 됨' for it.
- `GET|POST /api/peer/proxy?pc=<peer origin>&p=<path>` proxies to a peer. `pc` must be an origin in `knownComputers()`
  (no free URLs). GET is allowed only for the peer read list. POST is allowed only for `/api/peer/act`.

## Actions (forwarded, executed by the owner)

- `POST /api/peer/act {action, args, from}` on the owning gateway. The actions are `message` (a reply or a confirmed draft
  in a conversation), `answer` (a decision), `read` (mark read), `watch` (pause, resume or run a watch) and `kakao`
  (`op` send, read, draft-send or draft-drop on the owner's `/api/kakao/...` routes). The owner runs
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
