# Webmail without an API (design of record)

Shipped feature folder (hub/featuredirs.ts), **off by default** (`enabled: false` in feature.md, per the owner rule
[10-22]: shipped integrations start off and are turned on with a setup step on request). Nothing runs until the owner asks
and setup writes a per-site spec and config into the custom layer. zele stays the first choice for mail/calendar; this
feature is only for sites that have no API, no official CLI and no zele support. An install where another machine owns mail
(features/no-mail-calendar-here) keeps that rule.

## What was generalized from the owner's working setup

The owner's Mac mini runs a hand-built watcher for one company webmail. This feature keeps the *mechanism* it proved and
drops everything specific to that company. Generalized, in order:

- reaching a no-API webmail by replaying its own web-client XHR/JSON calls with the browser's cookies, instead of an API;
- reading the login session out of the Aside cookie store (Chromium v10 keychain + AES-128-CBC decrypt), filtered to the
  site's own hosts;
- telling "logged in" from "logged out" from the list response (JSON array = in; redirect / 401 / 403 / a 200 login page
  = out), not from the HTTP status alone;
- keeping the session alive cheaply (a cookie-bearing request extends the server's sliding session; a real tab load every
  few hours renews rotating cookies, done by the gateway's `session` watch);
- a baseline of seen ids so only genuinely new mail is reported, with a numeric high-water mark so an old mail sliding back
  into the window after a delete is not re-reported;
- recover from a dropped login once (a silent background tab load, no second factor), then ask the owner;
- draft-only sending: compose locally, send only after the owner's explicit OK in the mail thread.

Left out (never in the repo): the company name, its hosts, endpoints, mailbox ids, account ids, any mail content or hint,
secrets, and the owner's own launchd jobs. Each install captures its own `spec.json` into `~/.dotz/custom/webmail/<site>/`.

## The SiteSpec (lib/spec.ts)

The one generalization boundary. A spec describes a site's own API shape with no personal data: `origin`, `cookieHosts`,
the `list` / `read` / `search` / `send` endpoints as URL-path templates (`{mailbox}`, `{id}`, `{q}`), the JSON path to the
mail array (`listPath`), and the field paths within a mail (`id` required; `from` / `subject` / `time` / `read`
best-effort). `lib/capture.ts` infers a spec from a recording; the owner confirms it at setup.

## Layout

```
features/webmail-no-api/
  feature.md        prompt body (off by default): setup order, read/draft/send rules, login + optimization
  DESIGN.md         this file
  lib/spec.ts       SiteSpec type, dot-path read, URL templating, validate
  lib/config.ts     paths (custom/webmail/<site>), per-site config, injected Ctx
  lib/session.ts    logged-in/out classification, conditional keep-alive request
  lib/adapter.ts    generic list/read/search + makeDraft (never sends), html->text
  lib/capture.ts    the adapter generator: a recording -> a SiteSpec proposal
  lib/cookies.ts    live cookie header from the Aside store (live scripts only; tests inject a fake)
  bin/capture.ts    record XHR from a background Aside tab (or --from a HAR) -> write spec
  bin/setup.ts      write config, home card, sidebar project; print the watch spec to register
  bin/mail.ts       action CLI: list | read | search | draft | send (send guarded by owner approval)
  bin/watch.ts      one-shot watch the gateway runs every poll_minutes
  bin/card.ts       home card data command (offline/pre-setup safe)
  test/*.test.ts    adapter, capture generator, keepalive, watch (incl. logout recovery), off-by-default; fake mail server
```

All TypeScript, run with `bun <abs path>`. No npm dependencies (Bun builtins only, like the rest of dotz). Pure logic
(`lib/*`) takes an injected `Ctx` (`fetch`, `cookieHeader`, `now`, `sleep`, `log`); the `bin/*` scripts build the live Ctx
from the Aside cookie store and global fetch. Tests pass a fake Ctx and a fake mail server, so no test touches the
keychain, a browser or the network.

## Optimization defaults

- `poll_minutes` 5, `refresh_hours` 6, `keepalive` true (all in the per-site config).
- Each poll is one conditional request to the list endpoint with `If-None-Match` / `If-Modified-Since`; an unchanged inbox
  answers 304 with no body, so there is nothing to parse and no new mail to diff: zero model tokens, minimal bytes.
- Minimal fields are requested through `list.params` (e.g. a `fields=id,subject,date` selector the site supports).
- The watch prints one line per new mail and nothing otherwise, so the gateway wakes a model only on real mail.

## Send gate (the only write path)

`bin/mail.ts send <draftId>` refuses unless `~/.dotz/custom/webmail/<site>/send-approved` was touched within 15 minutes.
The orchestrator writes that marker only after the owner says OK (ㅇㅇ/보내) in the mail thread, then runs send once; the
marker and the draft are removed after a send. An install that wants a hard, hook-enforced gate can add a `deny` in a
custom plugin that blocks the raw send command until an OK token appears in the thread; the shipped default is the in-code
TTL guard plus the approval convention.
