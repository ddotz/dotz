# Remote desktop: design

Owner's words: "https://github.com/tembo/voxl 이거 붙여서 해당 게이트웨이가 설치된 컴퓨터 화면 띄우고 조작 가능하게 가능하냐? 전체모드로 하면 로컬화면처럼 전체로 사용가능하게 하고",
"크롬으로 되네. 크롬이 설치되어있으면 크롬에서 띄우는걸로 구현하자".

voxl (MIT source, GPL once linked with x264) streams the Mac's screen as H.264 over a WebSocket. dotz never ships the binary: the user's computer builds a pinned commit.
Off by default. macOS only: on Linux and Windows the enable command stops and says why.

## Facts checked on a real install (2026-11-04)

- Pinned: github.com/tembo/voxl commit eba3b7ced9f60e885bb7b3a96a12e3ccb347fdcd (0.3.2). Needs x264, opus, pkg-config, rust, esbuild. Links libx264 dynamically from /opt/homebrew, so a brew upgrade can break it.
- `tailscale serve` (1.104) sets `X-Forwarded-For` to the client's tailnet address (Set, not append: a client cannot forge it), `X-Forwarded-Proto: https` and the Tailscale-User-* headers.
- Aside's `userAgentData.brands` is `Chromium` + a grease entry, with `navigator.keyboard.lock` present but not working. Real Chrome adds the brand `Google Chrome`. Brand is the test, never `keyboard.lock`.
- A launchd job whose program is bun: `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted` through osascript give the same answer as voxl's own check at start. Permissions attach to the bun binary (signed, Team ID stable across bun upgrades), so they must be asked for from the gateway's own chain, never from a terminal.
- voxl logs `listening on` on stderr. A chosen password never appears in its log. `Cmd+W/T/Tab` pass only with keyboard lock: top-level tab in real Chrome, voxl's fullscreen button.
- voxl paces itself by client acks (`flow_blocked`), but its per-client writer is an unbounded channel: if the proxy stops reading, frames still wait inside voxl only up to the ack window. Nothing in the proxy may buffer past a small bound.
- The dotz service worker answers every `navigate` from the cached shell: `/desk` must be excluded in `web/sw.js`, like `/jandi-peer/`.

## Pieces

| Piece | File |
|---|---|
| Lifecycle, proxy, routes, opener | `hub/remote-desktop.ts` (+ `hub/remote-desktop.test.ts`) |
| WebSocket bridge with backpressure | `hub/remote-desktop-ws.ts` |
| Enable command | `features/remote-desktop/bin/onboard.ts`, `features/remote-desktop/feature.md` |
| Web (name prefix `dsk`; `dk` is taken by web/js/30-notices.js) | `web/js/37-remote-desktop.js`, `web/css/23-remote-desktop.css`, entries in palette, slash commands, settings (+ `hub/remote-desktop-web.test.ts`) |

Data lives in `<DATA_DIR>/remote-desktop/`: `bin/voxl` (cargo install --root), `settings.json` `{on, control, allow_public}`, `onboard.json` (steps done).
Defaults: on=true after enabling, **control=false** (view only until the owner turns it on, or the enable command got `--control`), allow_public=false.

`available` = darwin, the shipped feature enabled (hub/featuredirs.ts, a personal copy with `enabled: true`), and `bin/voxl` present. Everything visible hangs on it. Not available: no route answers anything but `{available:false}`, `/desk/` is 404, `/api/state` carries no `desk` key, no timer exists.

## Lifecycle

One `DeskHost`, injectable (spawn, clock, free port, binary path) so tests use a fake server script.

- `ensure()`, single flight: spawn on the first `/desk/` request or websocket. Args: `--addr=127.0.0.1 --port=<free> --file-transfers=none`, plus `--read-only` unless control is on. Never `--enable-resize`, never `--microphone-enabled`. `VOXL_PASSWORD` = 32 random bytes in hex, new per run, in env only, never logged or sent to a browser. Ready = `/healthz` 200, bounded wait 10 s.
- Stop: no viewers for 60 s (also armed right after start, so a page that never connects still ends) -> SIGTERM, SIGKILL after 3 s. `control` or `on` changing stops at once: turning control off must take effect now. Viewers' sockets close and voxl's client reconnects, which respawns in the new mode.
- No orphans: `stop()` joins the shutdown stages in hub/main.ts. For a gateway that dies without shutdown (SIGKILL, crash), a watchdog sibling runs with the gateway holding its stdin pipe: `sh -c 'cat >/dev/null; kill -TERM <pid>'`. Pipe EOF means the gateway is gone. On a normal stop the watchdog is killed first. `kill_bash`-style tree kill alone would not cover SIGKILL (compared with OmO, which records the child pid in its slot for orphan accounting after a crash; a pipe needs no sweep at boot).
- Broken binary: a start that exits with `dyld`/`Library not loaded` in stderr sets status `rebuilding` and runs `bun features/remote-desktop/bin/onboard.ts --rebuild` once, single flight, then retries. `/desk/` answers a small page that says so and refreshes itself.
- No polling, no interval timers. Off or idle costs nothing: CPU 0, no model calls.

## Proxy `/desk/`

Route sits after the owner check in `hub/routes.ts` (a peer token never gets here: `/desk` is not in PEER_GET). Gate order, each failure a plain short answer:

1. available and `on`.
2. Public access: `webAccess.mode() === "cloudflare"` or any `cf-ray` / `cf-connecting-ip` / `cf-access-jwt-assertion` header -> 403 unless `allow_public`.
3. `sameOrigin` (pty.ts rule) on websocket upgrades and every non-GET, and `Sec-Fetch-Site` when present must be `same-origin` or `none` (a cross-site link cannot start capture: it gets the one-button page, see Opening in Chrome).
4. Allow-list of exactly: `/desk` (301 to `/desk/`), `/desk/`, `/desk/index.html`, `client.js`, `worker.js`, `audio.js`, `mic.js`, `favicon.ico`, `inter.woff2`, `ws`. `/screenshot`, `/record`, `/files`, `/wait`, `/stats` stay unreachable: they would read the screen without counting as a viewer.
5. Viewer is this computer -> 409 page with the reason (a picture of itself; also the client's check, step "open").

Upstream request: `Host: 127.0.0.1:<port>`, no `Origin`, no `Cookie`, no `Tailscale-*`, no `x-dotz-*`, no `cf-*`, `Authorization: Bearer <password>`. Answers: drop `Set-Cookie`, `WWW-Authenticate`; add `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

### WebSocket and backpressure

`new WebSocket()` cannot stop reading, so frames would pile up in the gateway when the viewer is slow. Instead: `srv.upgrade` on the browser side, and the upstream side is a raw `Bun.connect` TCP socket with a small client WebSocket handshake and frame parser (server frames unmasked; client frames masked; ping/pong/close handled; fragmentation passed by reassembly with a 64 MiB message limit, as voxl's).

- Browser slow: `ws.send` returns -1 or `ws.getBufferedAmount()` exceeds 1 MiB -> `socket.pause()`. The `drain` handler resumes. TCP then fills, voxl's writer blocks, acks stop, voxl stops encoding (`flow_blocked`). Gateway memory stays bounded by one socket read plus 1 MiB.
- Browser to voxl: small messages. `socket.write` returning short -> keep the rest (cap 1 MiB, close 1011 beyond it), flush on `drain`.
- `hub/main.ts` keeps one `websocket` handler set: dispatch on `ws.data.kind === "desk"`, else `appProxySocket`. No change to the apps path.
- Each socket counts as one viewer `{who, device, since}`: `who` = Tailscale-User-Login or "기기", `device` = the viewer computer's name when known. Counters `{bytes, paused_ms, pauses}` live on the host and are read by status.

## Which computer is viewing

`viewerOf(req)`: `X-Forwarded-For` only when `Tailscale-User-Login` is present too, matched against `tailscale status --json` (`Self.TailscaleIPs`, `Peer[].TailscaleIPs`, cached 60 s) -> `{self: true}` or `{dns}`; then `knownComputers()` gives its gateway URL. Unknown or no header (Cloudflare, plain local) -> `{unknown: true}`, treated as a different computer without a gateway.

## Opening in Chrome

Keyboard lock needs a top-level tab in real Chrome, so an iframe or the dialog sheet is out.

A web page cannot start another app, and an HTTPS page cannot call a viewer-side HTTP port without mixed content and CORS trouble. So **the page never calls the viewer's gateway**: the page asks the gateway it is on, that gateway recognises the viewer by tailnet address and calls the viewer's gateway over the existing peer channel (`peerFetch`, `x-dotz-peer`, tailnet identity).

`POST /api/desk/open {chrome: boolean, phone: boolean}` (client facts) ->

| Situation | Answer | Page does |
|---|---|---|
| not available / off | `{action:"blocked", reason}` | toast |
| public access, not allowed | `{action:"blocked", reason}` | toast |
| viewer is this computer | `{action:"blocked", reason}` | toast |
| `chrome` true | `{action:"here"}` | `window.open("/desk/", "_blank")` |
| `phone` true | `{action:"here", note}` | open, toast note |
| viewer gateway opened Chrome | `{action:"opened", name}` | toast "<name>의 크롬에서 열었어요" |
| no gateway, no Chrome, old gateway, peer failed | `{action:"here", note}` | open, toast note |

Extra body fields: `on: true` (the button of an off computer) switches this computer on after every gate passed, so a refused open changes nothing.

`peer: <url>` is the button of another computer. Checked here: the url is a non-self entry of `knownComputers()`, public gate. Then that computer answers for itself on the tap (`GET /api/peer/desk`, in PEER_GET, 3 s, `{available, on, public_blocked}` or `{available:false, unsupported:true}`; nothing is read while nobody taps, no polling, no added list cost):

| That computer | Answer |
|---|---|
| unreachable | blocked: cannot connect |
| old gateway (route refused) | blocked: update it, `to:"#settings"` |
| not macOS | blocked: macOS only |
| never enabled | blocked: say 화면 공유 켜줘 in its chat, `to:""` |
| off | blocked: switch it on in its settings, `to:"#settings"` (a peer token never switches a screen on) |
| public door | blocked |
| it is the viewer itself | blocked: a picture of itself |

`to` makes the toast action that opens that computer's app. Otherwise: viewer is this gateway's own computer -> this gateway opens Chrome (`launch`, same check and 5 s gap as `/api/peer/desk-open`); viewer is another known computer -> `peerOpen` there; else `{action:"here"}` and the page opens `<peer>/desk/`.

That last case is a link from another origin, refused by proxy gate 3. Direct capture stays refused: a cross-site top-level `GET /desk/` (`Sec-Fetch-Dest: document`) answers a one-button page instead of 403. voxl does not start until the tap, the page's link is same-origin, and it cannot be framed. Every other cross-site request stays 403. A phone therefore taps twice (list, then this page); Chrome opened by a gateway has `Sec-Fetch-Site: none` and goes straight in.

`note` is the one line: 단축키(Cmd+W 같은)는 이 컴퓨터로 가요. `window.open` happens after the await: real Chrome keeps the user gesture for seconds; for other browsers it is opened blank in the click and pointed afterwards. Client facts are only a hint for routing: the gates live on the server.

`POST /api/peer/desk-open {url}` (added to PEER_POST) on the viewer's gateway. Peer token + tailnet identity from `checkPeer`, then:

- `url` parsed: https, path exactly `/desk/`, no query or hash, origin equal to a non-self entry of `knownComputers()`. Anything else 400.
- At most one open per 5 s.
- darwin and `open -Ra "Google Chrome"` exit 0 (finds the app, launches nothing), then `open -a "Google Chrome" <url>`, through an injected runner: tests never start Chrome. `{ok:true}` or `{ok:false, reason:"no-chrome"|"unsupported"}`.
- This side needs no voxl and no enabling: only the computer being watched does. It can only ever open that one path of the owner's own computers.

## Permissions and enable command

`features/remote-desktop/bin/onboard.ts [--control] [--rebuild] [--status]`, resumes from `onboard.json`. Exit 0 done, 3 owner must act (one printed step), 1 failed (printed reason).

1. preflight: darwin, brew present. Else the reason and stop.
2. deps: `brew install` only what is missing (x264 opus pkg-config rust); esbuild via `bun add -g esbuild` when missing.
3. build: `cargo install --git https://github.com/tembo/voxl --rev <pin> --locked --root <DATA_DIR>/remote-desktop --force`. Skip when the installed `.crates.toml` has the rev and the binary runs.
4. link: `voxl --help` runs (dyld failure -> rebuild).
5. enable: personal feature copy with `enabled: true`, `settings.json`.
6. gateway: `GET /api/desk/status` through the hub token. Gateway from before this feature or off -> stop and say a restart is needed, exit 1; running the same command again resumes here.
7. permissions: `POST /api/desk/probe` runs in the gateway's own chain, returns `{screen, accessibility}`. Screen missing (always) or accessibility missing (when control is on): the same call with `{grant:true}` opens the pane with `open -g` (`onboard/selfserve.ts` PANES) from the gateway, tries its toggle, re-checks; else the command prints the one step, exit 3.
8. trial: the same route with `{trial:true}` starts voxl with `--read-only` regardless of settings, reads `/screenshot` over the Bearer, checks PNG magic and size, stops. Input is never tested.

## Web

Same reach as the terminal: command palette item, `/screen` slash command, one `화면 보기` button per computer on its row of the switcher (`33-peers.js`, `dskRowBtn`: any online computer with a gateway, this one only with `S.desk`; a computer that lacks the feature is told by the tap, which needs no state in the list), and the settings section beside 이 컴퓨터 이름: `이 컴퓨터 화면` button (`켜고 보기` when off), 화면 공유 on/off, 조작 허용, 지금 보는 사람. Public-access switch appears only when web access is cloudflare. This computer's entries are absent when `S.desk` is absent; another computer's button is not (the viewing side needs no voxl).

`/api/state` carries `desk: {on, control, running, viewers: [{who, device, since}]}` when available. A pill in the app bar shows who is watching while `viewers` is non-empty (blue: running, per web/DESIGN.md) and is gone otherwise.

`PUT /api/desk/settings {on?, control?, allow_public?}`: `sameOrigin`, JSON only, answers the new status.
`GET /api/desk/status`: `{available, on, control, allow_public, running, rebuilding, viewers, relay, public_blocked}`.
