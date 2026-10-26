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
- The update gate (`hub/update-gate.json`, read from the version being installed) runs `bun test --parallel=4 --timeout=20000`
  within 20 minutes. A new test must pass in a folder without `.git` (a tarball install) and under parallel load.
