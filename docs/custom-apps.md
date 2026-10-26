# User apps (`~/.dotz/custom/apps`)

An app of the owner's own, beside the shipped ones (메일, 카카오톡, … in 모니터링) and beside custom cards. It is data only:
one manifest per app under the data folder, no dotz source change, no restart. The gateway lists it in the web's 앱 tab,
checks its health, and -- for an app with its own web UI -- serves that UI at `/apps/<id>/` with the same auth as the API.

Reference implementation: `hub/user-apps.ts` (manifest), `hub/app-proxy.ts` (proxy), `web/js/30-apps.js` (the tab).

## Decisions, and why

- **A folder + `app.json`, not another key in `custom/apps.json`.** The instance registry (`custom/apps.json`) is keyed by
  shipped app ids and describes instances of *those* apps; a user app has its own folder, its own files and its own life.
  A folder per app matches how feature folders and custom cards already work, and 제거 can move one folder without touching
  another app's state. `custom/apps.json` holds only the app's off switch (`{"<id>":{"off":true}}`), the same file the
  instances already keep their state in, so nothing new is stored in a new place.
- **The module ships no app.** `INTEGRATIONS` stays the list of contact-first apps the product knows; a manifest never edits
  it, and a manifest that reuses a shipped app's id is an error. An update replaces `hub/` and `web/` only, so it can never
  remove or break another install's `custom/apps/`.
- **`GET /api/apps` beside `GET /api/integrations`, not inside it.** The monitoring list (`30-monitoring.js`) keeps reading
  `/api/integrations` unchanged. The 앱 tab reads `/api/apps`, which returns both the on 모니터링 apps (`source: "registry"`)
  and the manifests (`source: "manifest"`), so one list shows every app. `window.appsMonItems()` is the one hook if
  모니터링 ever wants the tool apps in its 앱 group (see the bottom of `web/js/30-apps.js`).
- **One origin: the gateway proxies, apps stay on loopback.** A user app's server binds `127.0.0.1`. The web app is reached
  through `tailscale serve` over HTTPS, so a frame pointing straight at `http://127.0.0.1:<port>` would be mixed content and
  a phone could not reach it at all. `/apps/<id>/` keeps one origin, one identity check, and no new port to expose. A
  non-loopback `web.url` is refused at load and at proxy time.
- **Two URL modes, because rewriting is a guess.** `mode: "prefix"` (default) expects the app to serve relative URLs (or its
  own base path) -- nothing is rewritten. `mode: "rewrite"` is for an app written for `/` (hdocs): the gateway prefixes
  root-absolute `src/href/action/poster` and CSS `url(/...)`, rewrites `Set-Cookie` `Path` and `Location` back under
  `/apps/<id>/`, and injects a small first script that prefixes `fetch`, `XMLHttpRequest` and `WebSocket` paths at run time.
  It does **not** rewrite JavaScript string literals, absolute `ws://host/...` URLs or `location = "/..."` assignments: an app
  that needs those must serve under the prefix.
- **WebSocket upgrades are bridged.** `server.upgrade` plus a client `WebSocket` per connection (`hub/app-proxy.ts`), so an
  app that keeps a live channel (hdocs's editor) works through the same prefix. The upgrade goes through the same auth as
  every request; a browser cannot set the hub token header, so identity comes from `tailscale serve` headers, exactly like
  the rest of the web app.
- **`start` is a hint, never run.** The gateway does not spawn processes from a user's manifest: that would be remote code
  execution behind a data file. The 앱 설정 sheet shows the command so the owner (or the bot) can run it, and the doc
  recommends launchd for anything that must stay up.
- **Bad data never takes the list down.** A broken manifest is `{id, dir, reason}` in `errors`; the 앱 tab lists it as a
  row with 오류, the other apps keep working, and the gateway never throws.

## Manifest

`<data dir>/custom/apps/<id>/app.json` (`~/.dotz/custom/apps/<id>/app.json`). The folder name is the id:
`[a-z0-9][a-z0-9-]{0,39}`, and it must not be a shipped app's key (mail, kakao, instagram, youtube, site).

| Key | Type | Meaning |
|---|---|---|
| `label` | string, 1-30 | the name the owner reads, required |
| `kind` | `"tool"` \| `"monitor"` | `tool` = own web UI (`web` required); `monitor` = no UI, status only (default `tool`) |
| `web.url` | string | the app's own server, loopback only: `http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`. No path, query or login in it |
| `web.path` | string | where the app answers on that server (default `/`) |
| `web.mode` | `"prefix"` \| `"rewrite"` | see above (default `prefix`) |
| `health` | string | path on `web.url` that answers when the app is up (default `/`). Any status below 500 = running; 1.2s timeout, cached 5s |
| `start` | object | hint only: `{command, cwd?, env?}` — the 앱 설정 sheet shows it, the gateway never runs it |
| `watches` | string[] | watch names (or prefixes ending in `-`) this app owns, listed in its 설정 sheet |
| `settings` | object | free-form string/number/boolean rows, shown read-only in 설정; the bot edits the file |
| `icon` | string | an icon name the web already has (`web/js/01-core.js` ICONS, e.g. `file`, `mail`) |
| `iconPath` | string | a 24x24 stroke path when no icon fits (registered by the web on load) |
| `order` | number | list order (default 100) |
| `id` | string | optional; when present it must equal the folder name |

Never put a password, token or account in a manifest: it is plain text in the data folder, shown to the web. Secrets go to
`~/.dotz/secrets` and stay in the app's own config.

The 앱 tab's row shows the icon, the name, a status dot (running / 응답 없음 / 꺼 둠) and one line of state; opening it shows
the app's page in a frame under a dotz header (back, name, status, 새 탭, ⋯). ⋯ has 설정, 끄기 (or 켜기), 제거; 제거 moves the
folder to `custom/apps-removed/<stamp>-<id>/` so nothing is lost.

API, all with the usual hub auth:

```
GET    /api/apps                 -> {items: [...], errors: [{id, dir, reason}]}
PATCH  /api/apps/<id>  {"off":true}   (끄기, and {"off":false} to 켜기)
DELETE /api/apps/<id>                 (제거: folder to custom/apps-removed)
GET    /apps/<id>/...                 (the app's own pages, proxied)
```

## Bringing hdocs from the Mac mini

hdocs is a local web app (Hancom Docs in a Bun.WebView) at `github.com/ddotz/hdocs` (private). On the Mac mini it runs from
`~/Code/hdocs/hdocs-web-live` as launchd `dev.ddotz.hdocs-web`:

- `bun src/server.ts` with WorkingDirectory that folder
- port `PORT`, default **4417**
- log `~/.ddotz/hdocs-web.log`
- pages use root-absolute paths (`/hd/...`), so it is `mode: "rewrite"`; its editor keeps a WebSocket, which the gateway
  bridges

On the machine that will run it:

```sh
cd ~/Code && git clone git@github.com:ddotz/hdocs.git hdocs
cd hdocs/hdocs-web-live && bun install
# try it once in the foreground
PORT=4417 bun src/server.ts        # hdocs on http://127.0.0.1:4417
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4417/
```

Keep it up with launchd (owner's user agent, `~/Library/LaunchAgents/dev.ddotz.hdocs-web.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.ddotz.hdocs-web</string>
  <key>ProgramArguments</key><array><string>/Users/<you>/.bun/bin/bun</string><string>src/server.ts</string></array>
  <key>WorkingDirectory</key><string>/Users/<you>/Code/hdocs/hdocs-web-live</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/<you>/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/<you></string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/<you>/.ddotz/hdocs-web.log</string>
  <key>StandardErrorPath</key><string>/Users/<you>/.ddotz/hdocs-web.log</string>
</dict></plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ddotz.hdocs-web.plist
```

Then the manifest, `~/.dotz/custom/apps/hdocs/app.json`:

```json
{
  "label": "한컴 문서",
  "kind": "tool",
  "icon": "file",
  "web": { "url": "http://127.0.0.1:4417", "path": "/", "mode": "rewrite" },
  "health": "/",
  "start": { "command": "bun src/server.ts", "cwd": "~/Code/hdocs/hdocs-web-live", "env": { "PORT": "4417" } },
  "settings": { "포트": 4417 },
  "order": 10
}
```

Check it: `GET /api/apps` shows `hdocs` with `status: "running"` and no entry in `errors`; the 웹 앱 tab lists 한컴 문서 and
opening it frames `/apps/hdocs/`. If it says 응답 없음, the launchd job is not up (`tail ~/.ddotz/hdocs-web.log`) or the port
differs from the manifest.

The same manifest works on the Mac mini itself (its hdocs already listens on 4417 there): only `web.url` must stay loopback,
so run dotz on the machine that runs the app. A second computer's hdocs is not proxied through this hub; each dotz install
serves its own apps.

## What the bot does when the owner asks for an app

`MODE.md` / `MODE.ko.md` (the file each user's bot reads) says it in short: write the manifest, check `GET /api/apps` for
`errors: []` and `status: "running"`, never put secrets in it. `docs/app-templates/hdocs.md` is the request wording for this
one. Deployment rules stay in MODE, not here: this file is the reference for whoever builds or debugs an app.

Files under `docs/` are gitignored in this repo; add new ones with `git add -f`.
