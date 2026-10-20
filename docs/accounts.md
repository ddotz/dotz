# Claude accounts: aliases, switching rules, a script (`~/.dotz/accounts`)

dotz runs the orchestrator, the lanes and their task workers on one Claude subscription account from OmO's login pool
(`~/.omo/agent/auth.json`, `"anthropic-subscription"`). It stays on that account and moves only when a rule, a script or
the owner says so, or when the account is blocked (a usage limit, a rejected login). It only ever moves to another
subscription login, never to an API key. A switch reaches every running agent on its next turn, with no restart.

## Why it looks like this: comparison with OmO

- OmO picks an account per request: the pin from `SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT` (or settings, or the stored
  pin in auth.json), else its own ranking, and moves to the next account when one is blocked. It re-reads its settings
  and the environment on every request (`anthropic-subscription/stream.js`, `settings.js`).
- dotz sets that variable in each OmO process it runs (the dotz extension updates it at the start of every turn, task
  workers included), so the rules below decide the pin and OmO's own failover still covers a limit mid-turn.
- OmO has no time or usage rules, and names accounts by slot id. Aliases and rules are dotz's own layer.

## Folder layout

```
~/.dotz/accounts/
  aliases.json      display names
  rules.json        manual pick, rules, script
  decisions.jsonl   one line each time the decision changes
  <your script>     optional, e.g. a copy of docs/account-examples/work-hours.ts
```

## aliases.json

A slot id (`/claude-account` in OmO lists them) or an email, mapped to the name to show:

```json
{ "default": "개인 계정", "work-login": "회사 계정" }
```

한도, /quota, /account, the usage and 설정 screens and the worklog show the alias; the raw id is on a detail line.
Rules, the script and chat commands can name an account by its id or its alias.

## rules.json

```json
{
  "rules": [
    { "name": "한도 거의 다 씀", "when": { "five_hour_left_below": 10 }, "do": { "prefer": ["개인 계정", "회사 계정"] } },
    { "name": "근무 시간", "when": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "09:00", "to": "18:00" }, "do": { "pin": "회사 계정" } },
    { "name": "그 밖", "do": { "pin": "개인 계정" } }
  ],
  "script": { "path": "~/.dotz/accounts/work-hours.ts", "timeout_ms": 5000, "every_minutes": 5 }
}
```

- `when` (all conditions must hold; usage and block conditions are about the account in use now):
  `days` (`mon`..`sun`), `from` / `to` (`HH:MM` KST; `from` later than `to` wraps midnight),
  `five_hour_left_below` / `seven_day_left_below` (percent of the window left), `rate_limited: true`,
  `auth_error: true`, `unavailable: "<account>"` (that account is blocked or gone). No `when` = always.
- `do`: `{ "pin": "<account>" }`, `{ "prefer": ["a", "b"] }` (the first usable one, skipping one under the rule's
  threshold), or `{ "auto": true }` (dotz's own choice: stay, move only when blocked).
- `manual`: `{ "account": "<account>", "until"?: "<ISO time>", "reason"?: "..." }`, written by `/account <name>` or
  "개인 계정으로 바꿔줘"; `/account auto` removes it.

Order: `manual` (until it expires), then the script's answer, then the first rule whose `when` holds, then automatic.
A blocked or missing account is skipped: a `pin` falls through to the next step, a `prefer` takes the next account.

## The script hook

Any executable, or a `.ts`/`.js` file run with `bun`. dotz runs it every `every_minutes`, before an orchestrator or lane
turn, and when an agent starts a turn (at most once per 30 seconds), killed after `timeout_ms`.

- stdin: `{ "now": ISO, "current": "<id>"|null, "accounts": [{ "name", "alias", "blocked": null|"rate_limit"|"auth_error",
  "blocked_until", "five_hour_left", "seven_day_left" }] }` (usage is null when unknown); env `DOTZ_ACCOUNT_CURRENT`.
- stdout: the account (id or alias) on the first line, an optional reason on the second.
- No output, a non-zero exit, a timeout or an unknown account = no opinion: the rules decide. The error is logged.

Dry run before pointing rules.json at it:

```
echo '{"now":"2026-10-21T01:00:00Z","current":"home","accounts":[{"name":"work","alias":"회사 계정","blocked":null,"five_hour_left":80},{"name":"home","alias":"개인 계정","blocked":null,"five_hour_left":90}]}' \
  | bun docs/account-examples/work-hours.ts
work
근무 시간이라 회사 계정을 써요
```

`docs/account-examples/work-hours.test.ts` runs the same dry run for a weekday, a Saturday and a low 5-hour window.

## Where to look

- `decisions.jsonl`: a line only when the account or the script's error changes (not on every run).
- `~/.dotz/account-switches.jsonl`: every switch with its kind (`rule`, `script`, `manual`, `limit`, ...) and reason.
- In chat: `/account` (current account and why, the rules), `/account <name>`, `/account auto`.
