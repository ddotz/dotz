# Custom plugins

Per-install code that is not part of the product lives in `<DATA_DIR>/custom/plugins/*.ts` (or `*.js`). The gateway, the agent extension and the Claude deny hook import every such file once when they start (`*.test.ts` and `*.d.ts` next to a plugin are ignored), in file-name order. There is no hot reload: restart the gateway after changing a plugin. Types and loader: `hub/plugins.ts`.

A plugin default-exports an object; every hook is optional:

```ts
import type { Plugin } from "<dotz repo>/hub/plugins.ts"; // type only, erased at runtime

export default {
	name: "example",
	start(ctx) {},                       // hub, once, after the watches are armed
	claim(channelId) {},                 // Discord channel outside the bot's categories
	thread({ thread, text }) {},         // owner message in a thread
	deny(command, dataDir) {},           // shell command about to run
} satisfies Plugin;
```

- `start(ctx)`: `ctx` has `dataDir`, `log`, `postTo(channelId, text)`, `ack(channelId, messageId)`, `ensureWatch(spec)` (a dotz watch; same name and command is kept, another command replaces it) and `approveWatch(name)`.
- `claim(channelId)`: return `{ raw: (m) => void }` to take the owner's messages in that channel yourself, or `{ thread, parent }` to deliver them as a thread named `thread` under channel `parent`; `undefined` leaves the channel alone.
- `thread({ thread, text })`: runs for each owner message in a thread; may do side effects and return `{ note, parentName }`: `note` is appended to the orchestrator's inbox turn for that message, `parentName` replaces the parent's name.
- `deny(command, dataDir)`: return a reason to block the command (agent sessions and Claude), `undefined` to let it pass.

Claim and thread hooks can run before `start`; keep what they need at module level. The extension and the Claude hook run in separate processes and call only `deny`.

A plugin that fails to load, whose `start` throws (it is dropped for the run), or whose hook throws is logged (`plugin <name>: ...`) and skipped; the hub keeps running. With no plugin installed the hooks return at once, and nothing is added to prompts.

A plugin may also serve as a watch check: `ensureWatch({ command: "bun '<plugin file>' check" })` with `if (import.meta.main)` in the file.

## Posting a mail

A watcher or plugin that finds new mail posts it to the gateway, and each mail becomes its own conversation: `mail:<key>` in the web app (group "메일") and, with Discord on, one thread in the mail channel. Same auth as every `/api` route (the hub token or a tailnet login):

```sh
curl -s -X POST http://127.0.0.1:<web.port>/api/mail \
  -H "x-dotz-token: $(cat ~/.dotz/secrets/hub-token)" -H "Content-Type: application/json" \
  -d '{"source":"work","id":"8812","from":"Kim <kim@example.com>","subject":"Q4 plan","summary":"Asks for the draft by Friday.","body":"..."}'
# {"ok":true,"key":"work-8812","target":"mail:work-8812","thread":"1430..."}
```

- Required: `source`, `id`, `subject`. Optional: `from`, `to`, `summary` (up to 2000 chars), `body` (up to 20000), `html` (the HTML body, up to 400000; the gateway reduces it to a safe subset and the web shows it in a sandboxed frame; send it only when the mail really has one), `thread`, `wake`.
- `attachments` (up to 10): `[{"name":"quote.pdf","type":"application/pdf","data":"<base64>"}]`, or `{"name":...,"path":"<file>"}` for a file the poster already put under `<data dir>/mail-files/` (any other path is refused). Each file is limited to 25 MB and stored as `mail-files/<key>/<n>/<name>`. The mail row in 모니터링 then shows a 첨부 button, and the file is served by `GET /api/mail/<key>/files/<n>` (`?dl=1` to download) with the same auth as every `/api` route, never from outside that folder.
- A mail without `summary` shows the first lines of `body` in the list.
- The key is `<source>-<id>`, lowercased and limited to `[a-z0-9._-]`. Posting the same key again changes nothing and answers `"duplicate": true`, so a retry is safe.
- `thread`: the Discord thread id when the poster already put the mail on Discord. The gateway records it and posts nothing; without it the gateway opens the thread itself (Discord on) or keeps the mail web-only.
- `wake: true` gives the orchestrator one turn for the mail (zele does this). Leave it off when the poster already summarised it.
- The owner's reply in that web conversation reaches the orchestrator as a message in the mail's thread: your plugin's `thread` hook runs and its `note` goes into the turn, so an OK recorded there gates `deny` exactly as on Discord. A mail with no plugin note gets a built-in note: draft first, send only after the owner's OK there.

## Registering a mail reader as a mail instance

A mail reader of one install (a company webmail with no API, read by a plugin) is another instance of the 메일 app: it gets its own row in 모니터링, settings panel, name, off/제거/삭제, its own watches and only its own source's mails, with the same reply-draft and summary options. Once the plugin posts mails with a fixed `source`, register the instance once (same auth as `POST /api/mail`):

```sh
curl -s -X POST http://127.0.0.1:<web.port>/api/apps -H "x-dotz-token: <hub token>" -H "Content-Type: application/json" \
  -d '{"app":"mail","label":"회사 메일","filter":{"source":"work","watches":["work-login","work-mail"]}}'
# {"ok":true,"id":"mail-2","label":"회사 메일"}
```

- `filter.source` = the `source` the plugin posts; the instance owns the mails `mail:<source>-…` (a source must not be the start of another one joined with a hyphen). `filter.watches` = the plugin's watch names (a name ending in `-` is a prefix): they pause when the instance is off and go with 제거 and 삭제, and the default 메일 instance stops claiming them.
- The default 메일 instance keeps every mail no other instance claims, so existing installs look the same. By hand, `custom/apps.json` takes the same shape (`{"mail-2":{"app":"mail","label":"…","filter":{…}}}`) and `{"mail":{"watches":["kdb-login"]}}` adds watch names to an instance without a filter.
- The owner renames an instance in its settings panel (`label`) and deletes an off one in 앱 관리; `DELETE /api/apps/<id>[?data=1]` is the same call.
