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

- `bun run test` runs the whole suite on four workers (`bun test --parallel=4`), 2-3 minutes on a busy M-series Mac. One worker per core is slower and fails under load: the WebView tests starve each other.
- Before every push, run the full gate on both the MacBook and the Mac mini: `bun test ./hub/update-gate-run.ts` (the whole suite in
  parallel, failed files retried alone). Both must exit 0. The machines differ in macOS and system SQLite (macOS 26 / SQLite 3.51 vs
  macOS 27 / 3.54), and a change that passes on only one of them breaks updates on the other. A new test must pass in a folder without
  `.git` (a tarball install) and under parallel load.
- `bun hub/hangul-measure.ts <url|file> [widths] [--scope selector] [--text 150,200] [--json]` measures Korean line breaks on the rendered page (split words, overflow, orphans, and with `--text` clipped or covered buttons). It is a manual check, headless, and not part of the gate; `#tl` and code are exempt from split and orphan (`docs/ui-principles.md` rule 11).
- Commits and anything posted to GitHub follow `CONTRIBUTING.md`: a commit subject feeds the release note and its body has `왜:` and `어떻게:` lines
  (`docs/releases.md`), and `publicPostDeny` (`hub/public-scrub.ts`) refuses an agent's post to `ddotz/dotz` that still holds this install's values, a new issue or PR without its `분류:` line, and a direct PR merge. `hub/upstream-commits.ts` (same deny) checks what the post's commits publish: before a `gh pr create` to `ddotz/dotz`, the head branch's commits that public main lacks must carry a GitHub noreply address with the login as name and no install value in their messages or added lines; before a `git push` from a dotz clone to any GitHub remote, a fork included, the same identity check runs whether or not the hook is installed; a `git push` to the public repo itself (`origin HEAD:main`, `<branch>:main`, a plain push, `--all`) also gets the message and added-line check of a PR on the commits public main lacks, fails closed when git cannot be read, and the pre-push hook runs the same check for pushes made outside the agent. The main path is earlier: before an agent's `git commit`, `merge`, `rebase`, `cherry-pick`, `am`, `revert` or `pull` runs in a dotz clone (`hub/clone-identity.ts`, last step of the same deny), dotz sets the clone-local identity to the signed-in `gh` account's noreply identity itself (login and id cached in `github-login.json` in the data dir; never the global config, never a repo that is not a dotz clone, and no fallback to the machine's identity: with no login the command is refused and says `gh auth login`), and refuses a `git commit` whose message or staged added lines hold an install value, so a first commit is already clean. The publish-time checks above are the backstop for a person's commit in a terminal and for commits from before the update. Every refusal names `bun hub/push-identity.ts fix`, which sets the clone-local noreply identity from the signed-in `gh` account and rewrites the unpublished commits; run it in your clone before opening a PR from a fork. `dotz_merge` (`hub/mergegate.ts`) needs scope universal on a PR, and pre-push (`hub/push-identity.ts`) refuses a `(#N)` commit landed by hand without that review.
- `bun test hub/engineering-rules.test.ts` holds the repo-wide limits of `docs/engineering-standards.md` (file and function size, import cycles, layer edges, swallowed errors, plain writes, unbounded calls, timing tests, dead code, module map, copied helpers). `git push` runs it on the pushed commit through `.githooks/pre-push` and refuses a tip over a limit. The same hook refuses a push to public `ddotz/dotz` when a commit the remote does not hold yet has an author or committer outside GitHub's noreply addresses (`hub/push-identity.ts`), so set `user.email` to your noreply address in the clone: every worktree and lane reads the same config; `core.hooksPath` is set by `hub/git-hooks.ts` on the first `bun test` in a clone (all its worktrees share it) and at gateway boot, so nobody installs it by hand. Existing violations are frozen as ceilings, so only new ones fail; `bun hub/engineering-rules.ts` prints the current values.
- `bun test hub/design-rules-web.test.ts` measures the `web/DESIGN.md` rules on the real `web/` CSS and JS (stripes, status colors, literal colors and times, px sizes, emoji, one accent per screen). Its comment lists what is not checked; existing violations sit in named allowlists, so only new ones fail.
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
