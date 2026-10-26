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
	reply(draft) {},                     // an approved mail reply of a source this plugin posts (files included)
	repliesWithFiles(source) {},         // true when reply sends draft.attachments for that source
} satisfies Plugin;
```

- `start(ctx)`: `ctx` has `dataDir`, `log`, `postTo(channelId, text)`, `ack(channelId, messageId)`, `ensureWatch(spec)` (a dotz watch; same name and command is kept, another command replaces it) and `approveWatch(name)`.
- `claim(channelId)`: return `{ raw: (m) => void }` to take the owner's messages in that channel yourself, or `{ thread, parent }` to deliver them as a thread named `thread` under channel `parent`; `undefined` leaves the channel alone.
- `thread({ thread, text })`: runs for each owner message in a thread; may do side effects and return `{ note, parentName }`: `note` is appended to the orchestrator's inbox turn for that message, `parentName` replaces the parent's name.
- `deny(command, dataDir)`: return a reason to block the command (agent sessions and Claude), `undefined` to let it pass.

Claim and thread hooks can run before `start`; keep what they need at module level. The extension and the Claude hook run in separate processes and call only `deny`. `reply` also runs in the reply-drafts CLI (`features/reply-drafts/bin/draft.ts send`), which loads the plugins itself.

A plugin that fails to load, whose `start` throws (it is dropped for the run), or whose hook throws is logged (`plugin <name>: ...`) and skipped; the hub keeps running. With no plugin installed the hooks return at once, and nothing is added to prompts.

A plugin may also serve as a watch check: `ensureWatch({ command: "bun '<plugin file>' check" })` with `if (import.meta.main)` in the file.
A check that sends its own alerts and exits 0 while its source is logged out should print `DOTZ_DISCONNECTED since=<ISO time>`: the app's 모니터링 row then shows 연결 끊김 with that time (hub/watch-status.ts). Without it the row reads as connected.

## Posting a mail

A watcher or plugin that finds new mail posts it to the gateway, and each mail becomes its own conversation: `mail:<key>` in the web app (group "메일") and, with Discord on, one thread in the mail channel. Same auth as every `/api` route (the hub token or a tailnet login):

```sh
curl -s -X POST http://127.0.0.1:<web.port>/api/mail \
  -H "x-dotz-token: $(cat ~/.dotz/secrets/hub-token)" -H "Content-Type: application/json" \
  -d '{"source":"work","id":"8812","from":"Kim <kim@example.com>","subject":"Q4 plan","summary":"Asks for the draft by Friday.","body":"..."}'
# {"ok":true,"key":"work-8812","target":"mail:work-8812","thread":"1430..."}
```

- Required: `source`, `id`, `subject`. Optional: `from`, `to`, `cc` (참조), `summary` (up to 2000 chars), `body` (up to 20000), `html` (the HTML body, up to 400000; the gateway reduces it to a safe subset and the web shows it in a sandboxed frame; send it only when the mail really has one), `thread`, `wake`.
- `attachments` (up to 10): `[{"name":"quote.pdf","type":"application/pdf","data":"<base64>"}]`, or `{"name":...,"path":"<file>"}` for a file the poster already put under `<data dir>/mail-files/` (any other path is refused). Each file is limited to 25 MB and stored as `mail-files/<key>/<n>/<name>`. The mail row in 모니터링 then shows a 첨부 button, and the file is served by `GET /api/mail/<key>/files/<n>` (`?dl=1` to download) with the same auth as every `/api` route, never from outside that folder.
- A mail without `summary` shows the first lines of `body` in the list.
- Direction: a mail written by the owner is outgoing. Post it with `"direction":"out"`, a sent `folder` (`SENT`, `보낸편지함`) or `labels` containing `SENT`; the gateway also treats a `from` that is one of his own addresses as outgoing (`zele whoami` accounts, `mail.own_addresses` / `zele.aliases` in config.json; plus-tags and Gmail dots are ignored). An outgoing mail is listed under 보낸 메일 and never counts as unread, never wakes the bot and never gets a reply draft; posted for a thread already recorded, it marks that thread 답장함.
- `messageId` (optional): names the newest message of the thread. The same id posted again is a repeat. Another id for a known thread is a newer message: the thread becomes a new mail again (any reply state is reset, even 답장함, 답장 안 함 or 참고만), and the wake, notice and reply draft fire for it once.
- The key is `<source>-<id>`, lowercased and limited to `[a-z0-9._-]`. Posting the same key again changes nothing and answers `"duplicate": true`, so a retry is safe.
- `thread`: the Discord thread id when the poster already put the mail on Discord. The gateway records it and posts nothing; without it the gateway opens the thread itself (Discord on) or keeps the mail web-only.
- `wake: true` gives the orchestrator one turn for the mail (zele does this). Leave it off when the poster already summarised it.
- The owner's reply in that web conversation reaches the orchestrator as a message in the mail's thread: your plugin's `thread` hook runs and its `note` goes into the turn, so an OK recorded there gates `deny` exactly as on Discord. A mail with no plugin note gets a built-in note: draft first, send only after the owner's OK there.

## Sending a reply, with files

The reply-drafts feature sends a reply the owner approved (보내기). For a mail whose `source` is neither `zele` nor a webmail-no-api site, it asks the plugins, in file-name order, until one returns a result:

```ts
reply(draft) { // draft: { source, id, to, subject?, body, attachments: [{ name, path, size }] }
	if (draft.source !== "work") return undefined;           // not mine: the next plugin, else "send it by hand"
	// ... send draft.body to draft.to; attach every file at draft.attachments[i].path (absolute, on this computer)
	return { ok: true, message: "답장을 보냈어요" };            // or { ok: false, message: "why" }
},
repliesWithFiles(source) { return source === "work"; },     // true only when reply really sends draft.attachments
```

- `attachments` are the files staged for that draft: the owner added them in the send sheet, or reply-drafts matched them in the mail instance's 첨부 파일 폴더 setting and the owner confirmed them. Without `repliesWithFiles`, the sheet says the account cannot send files, asks once more before 보내기, and a draft that holds files is not sent at all.
- zele sends them with `zele mail reply <id> --attach <path>` (one flag per file). A webmail-no-api site cannot send files: its adapter only saves a text draft.
- A throw in `reply` is a failed send (logged, the owner sees why); returning `undefined` means the source is not this plugin's.

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
