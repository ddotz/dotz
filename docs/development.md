# Developing dotz while using it

dotz keeps three things apart. Mixing them is what makes an update fail on someone else's computer.

| What | Where | Who changes it |
|---|---|---|
| Shipped code | the repo (`hub/`, `web/`, `features/`, `MODE.md`, ...) | commits that every install receives |
| Your install | the code folder the gateway runs from (`~/.local/share/dotz` by default) | only the updater |
| Your own setup | the data folder (`~/.dotz`): `config.json`, `custom/`, `features/`, `RULES.md`, `discord-post.json`, secrets | you and your bot |

## Rule

- The gateway you use every day runs from an install, never from the folder you develop in. The install is a tarball or an
  `install.sh --git` clone; both count as "not a developer checkout" (`hub/selfupdate-local.ts` `keepsLocal`), so the code guard
  (`hub/codeguard.ts`) stops the orchestrator, sessions and their workers from editing or committing the dotz code there. What the
  bot changes for you lands in the data folder, which no update touches.
- You develop in a separate checkout (for example `~/Code/dotz`). Changes reach your own gateway the same way they reach everyone:
  push to the repo, then the gateway's update (settings → 업데이트, or `self_update.auto_apply`). Your daily use therefore runs the
  same update path as every other user, and a broken update shows up on your computer first.
- Personal values never go into shipped code. If a behavior must differ per owner, read it from `config.json` or the data folder
  with a default that is right for a new user (example: `guard.no_api_key_accounts`, empty by default).

## Where a setting belongs

| Looks like | Is | Lives in |
|---|---|---|
| A behavior rule every owner wants (list blocks, choice blocks, report shape) | shipped | `MODE.md` / `MODE.ko.md` |
| A rule only this owner wants (how he is addressed, his commit style, his projects) | personal | `<data>/RULES.md` |
| An integration (mail, KakaoTalk, comments) | shipped code, off by default | `features/<id>/` |
| That integration switched on or off here | personal | `<data>/features/<id>/feature.md` with `enabled:` (a switch: the shipped text still applies; `custom: true` keeps your own text) |
| Which account must never bill an API key | personal | `config.json` `guard.no_api_key_accounts` |
| Which conversations also go to Discord | personal | `<data>/discord-post.json` (settings -> 디스코드에도 보내기) |
| Wording of gateway texts | shipped defaults | `<data>/custom/texts.json` overrides |
| Home cards, pins, routines, app templates | personal | `<data>/custom/` |

A value in shipped code is a default that suits a new user; a value that only suits you goes in the data folder.

## Moving an existing developer-checkout gateway to an install

When the launchd service (`~/Library/LaunchAgents/dev.dotz.gateway.plist`) points at your development folder:

```sh
# 1. a git install next to the data folder (no wizard, no new service, the installed harness left alone; the data folder stays as it is)
DOTZ_DIR=~/.dotz DOTZ_HARNESS=none sh ~/Code/dotz/install.sh --git --no-setup --no-service --yes
# 2. point the service at it and restart the gateway
sed -i '' "s#$HOME/Code/dotz/hub/main.ts#$HOME/.local/share/dotz/hub/main.ts#" ~/Library/LaunchAgents/dev.dotz.gateway.plist
launchctl bootout gui/$(id -u)/dev.dotz.gateway; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.dotz.gateway.plist
```

Check: `ps aux | grep hub/main.ts` shows `~/.local/share/dotz/hub/main.ts`, and settings → 업데이트 shows the install's commit.

## Tests and the update gate

- `bun run test` runs the whole suite in parallel (`bun test --parallel`), about 25 s on an M-series Mac.
- Before every push, run the full gate on both the MacBook and the Mac mini: `bun test ./hub/update-gate-run.ts` (the whole suite in
  parallel, failed files retried alone). Both must exit 0. The machines differ in macOS and system SQLite (macOS 26 / SQLite 3.51 vs
  macOS 27 / 3.54), and a change that passes on only one of them breaks updates on the other. A new test must pass in a folder without
  `.git` (a tarball install) and under parallel load.
- Owner machines do not run the suite on update. The update gate (`hub/update-gate.json`, read from the version being installed) is
  `bun test ./hub/update-smoke-run.ts` (5-minute limit, under a second in practice). It starts that version's gateway on a throwaway data dir,
  HOME and port, with no Discord, no agent and no tailscale, and checks `/api/health`, the web page with its scripts and styles, and
  `/api/state` and `/api/notices`.
- When the running gateway applies an update, it writes `<data>/update-pending.json` and starts a detached watchdog from a copy in the data
  folder (`hub/update-watchdog.ts`). If the restarted gateway has not marked the update healthy within 3 minutes (it does so after
  45 s up while `/api/health` answers), the watchdog rolls back once: `git reset --keep <from>`, or swapping `<dir>` and `<dir>.prev`. It then
  stops the gateway process so launchd/systemd starts the old code, which posts "업데이트 <to> 가 시작되지 않아 <from>으로 되돌렸어요" to alert
  and does not auto-apply that version again. The watchdog log lines are in `<data>/logs/update-*.log`. An update applied from a terminal
  (`bun hub/selfupdate.ts --apply`) leaves the marker but starts no watchdog.
