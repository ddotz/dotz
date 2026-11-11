// 삭제하면 원본도 삭제: the one way a delete reaches the real mailbox. Default off, per mail app instance (hub/app-settings.ts delete_original); off, a delete
// stays in dotz and no source is called (hub/mail-sync.ts trash never calls one).
//   POST /api/mail/delete-original {"keys": ["<key>", ...]}  (at most 200, one pass, in order)
//     -> 200 {"ok": true, "results": [{"key", "ok": true} | {"key", "ok": false, "note": "<one short Korean line>"}]}   ok = the original went and the mail left dotz
//     -> 403 anything but the owner's browser (ownerClick); -> 400 keys is not a list
// Only the web app's delete, after its confirm, calls this. The orchestrator, a rule, a monitor and a peer's forwarded act all carry the hub token or the peer
// header and are refused here; nothing in the hub calls deleteOriginals by itself.
//
// Each source is an adapter with the shape of the reply path: zele = `zele mail trash <thread>`, the mailbox's trash, so a mistake can be undone there. It works
// on a whole thread, so the thread is read first (read-only) and a message from someone else that dotz has not shown stops it. Any other source that lists
// "trash" in its plugin's `mailActions` = its `mailAction({action: "trash"})`. A webmail-no-api site has no delete: `can` is empty and the switch cannot be turned on.
// A failure leaves the mail where it is and answers ok:false; only a done source call removes it from dotz.
//
// Restarts (as hub/approval-send.ts): the mail is kept on file (`pending`) for exactly as long as its source call runs. One still on file at boot may or may not
// have gone. It is never called again by itself: the mail stays in the list and one alert asks him to look (a second delete is safe, the trash takes it once).
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mailOriginalOn, setMailTrashProbe } from "./app-settings.ts";
import { log, writeAtomic } from "./config.ts";
import { appEntries } from "./integrations.ts";
import { isOwnAddress, ownAddresses } from "./mail-state.ts";
import { canOf, type SyncDeps } from "./mail-sync.ts";
import { mailByKey, mailRecords, type MailRecord } from "./mail.ts";
import { instanceOf } from "./reply-model.ts";
import { parseThread, zeleRead, type ThreadMessage } from "./zele.ts";

export type PendingDelete = { key: string; subject: string };
export type PendingStore = { load: () => PendingDelete[]; save: (items: PendingDelete[]) => void };
export type OriginalDeps = Pick<SyncDeps, "exec" | "plugin" | "remove" | "changed" | "log"> & {
	/** The mail's app has the switch on and its source can trash. Asked again here: the card the page drew may be old. */
	allowed: (r: MailRecord) => boolean;
	/** `zele mail read <thread>`: the text of the thread. Read-only. */
	read: (id: string, account: string) => Promise<string>;
	pending: PendingStore;
};
export type OriginalResult = { ok: boolean; note?: string };

const CALL_MS = 60_000;
const SLACK_MS = 5 * 60_000;
const KEYS_MAX = 200;
const FAILED = "원본을 지우지 못해서 메일을 그대로 뒀어요";
const NOT_ON = "원본 삭제가 꺼져 있어서 지우지 않았어요";
const NO_SUPPORT = "이 메일함은 원본 삭제를 지원하지 않아요";
const REFUSED = "메일함이 삭제를 거절해서 메일을 그대로 뒀어요";
const NEWER = "아직 안 본 새 메일이 같은 대화에 있어서 원본을 지우지 않았어요";
const BUSY = "이 메일의 원본을 지우는 중이에요";

const limited = async <T>(job: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${CALL_MS / 1000}s`)), CALL_MS); })]);
	} finally {
		clearTimeout(timer);
	}
};

/** The thread's messages after what the record stands for. A zele stamp (`<count>|<date>`, hub/zele.ts) says how many it held; any other id has only the time. */
const afterRecord = (r: MailRecord, messages: readonly ThreadMessage[]): readonly ThreadMessage[] => {
	const count = /^(\d{1,4})\|/.exec(r.msg ?? "")?.[1];
	return count ? messages.slice(Number(count)) : messages.filter(m => Date.parse(m.date) > Date.parse(r.at) + SLACK_MS);
};

/** What stops the call, or undefined. zele can only trash a whole thread, so it must hold nothing he has not seen. */
async function refusal(r: MailRecord, d: OriginalDeps): Promise<string | undefined> {
	if (r.source !== "zele") return undefined;
	const messages = parseThread(await limited(d.read(r.id, r.account ?? "")));
	if (!messages.length) return FAILED;
	const own = ownAddresses(r.account ? [r.account] : []);
	return afterRecord(r, messages).some(m => !isOwnAddress(m.from, own)) ? NEWER : undefined;
}

/** The adapter of each source: undefined = the original went, else the line that says why not. */
async function trash(r: MailRecord, d: OriginalDeps): Promise<string | undefined> {
	if (r.source === "zele") {
		const out = await limited(d.exec(["zele", "mail", "trash", r.id, ...(r.account ? ["--account", r.account] : [])]));
		if (out.code === 0) return undefined;
		d.log?.(`mail ${r.key}: trash not done in zele: ${out.stderr.trim().slice(0, 200)}`);
		return FAILED;
	}
	const done = await limited(d.plugin({ source: r.source, id: r.id, action: "trash" }));
	return done === true ? undefined : done === false ? REFUSED : NO_SUPPORT;
}

/** The original of one mail, then the mail itself. One source call at most; ok is true only when it was done. */
export async function deleteOriginal(key: string, d: OriginalDeps): Promise<OriginalResult> {
	const r = mailByKey(key);
	if (!r) return { ok: false, note: "이 메일을 찾지 못했어요" };
	if (!d.allowed(r)) return { ok: false, note: NOT_ON };
	if (d.pending.load().some(p => p.key === key)) return { ok: false, note: BUSY };
	let kept = false;
	const release = () => {
		if (kept) d.pending.save(d.pending.load().filter(p => p.key !== key));
		kept = false;
	};
	try {
		const stop = await refusal(r, d);
		if (stop) return { ok: false, note: stop };
		if (d.pending.load().some(p => p.key === key)) return { ok: false, note: BUSY };
		d.pending.save([...d.pending.load(), { key, subject: r.subject }]);
		kept = true;
		const failed = await trash(r, d);
		if (failed) return { ok: false, note: failed };
		await d.remove(key);
		d.changed(key);
		return { ok: true };
	} catch (error) {
		d.log?.(`mail ${key}: original not deleted: ${(error as Error).message}`);
		return { ok: false, note: FAILED };
	} finally {
		release();
	}
}

export async function deleteOriginals(keys: readonly string[], d: OriginalDeps): Promise<Array<OriginalResult & { key: string }>> {
	const results: Array<OriginalResult & { key: string }> = [];
	for (const key of keys) results.push({ key, ...(await deleteOriginal(key, d)) });
	return results;
}

/** The owner's own click: a same-origin browser request. The bot's and a peer's requests carry the hub token or come through the peer door; a script has no fetch metadata. */
export const ownerClick = (req: Request, peer: string): boolean => peer === "none" && !req.headers.has("x-dotz-token") && req.headers.get("sec-fetch-site") === "same-origin";

export async function originalDeleteRoute(req: Request, peer: string, b: { keys?: unknown }, d: OriginalDeps): Promise<Response> {
	if (!ownerClick(req, peer)) return Response.json({ error: "원본 삭제는 웹앱에서 직접 눌러야 해요" }, { status: 403 });
	if (!Array.isArray(b.keys) || b.keys.some(k => typeof k !== "string")) return Response.json({ error: "keys must be an array of mail keys" }, { status: 400 });
	return Response.json({ ok: true, results: await deleteOriginals((b.keys as string[]).slice(0, KEYS_MAX), d) });
}

/** Boot: what was in flight when the gateway stopped is told once, and never called again. */
export function recoverOriginalDeletes(store: PendingStore, report: (text: string) => void): void {
	const left = store.load();
	if (!left.length) return;
	report(`원본을 지우던 중에 게이트웨이가 멈췄어요: ${left.map(p => p.subject).join(", ")}. 메일은 목록에 그대로 있으니 메일함에 원본이 남아 있으면 다시 삭제해 주세요`);
	store.save([]);
}

/** Whether a mail goes through deleteOriginal now. One read of the apps file for the whole list. */
export const originalDeletable = (dataDir: string, sync: Pick<SyncDeps, "webmail" | "pluginCan">) => {
	const on = mailOriginalOn(dataDir);
	return (r: Pick<MailRecord, "key" | "source" | "dir">): boolean => r.dir !== "out" && canOf(r.source, sync).includes("trash") && on(r.key);
};

/** Whether any mail of app instance `app` comes from a source that can trash (the settings row asks). */
export const instanceCanTrash = (dataDir: string, app: string, sync: Pick<SyncDeps, "webmail" | "pluginCan">): boolean => {
	const entries = appEntries(dataDir);
	return mailRecords().some(r => r.dir !== "out" && canOf(r.source, sync).includes("trash") && instanceOf(entries, "mail", `mail:${r.key}`) === app);
};

const fileStore = (file: string): PendingStore => ({
	load: () => {
		if (!existsSync(file)) return [];
		try {
			return JSON.parse(readFileSync(file, "utf8")) as PendingDelete[];
		} catch (error) {
			log(`mail: ${file} unreadable, starting empty: ${error}`);
			return [];
		}
	},
	save: items => writeAtomic(file, `${JSON.stringify(items)}\n`),
});

/** The real parts: the same transports as the two-way sync, the real thread read, the file that outlives a restart. Installs the settings row's probe. */
export const originalDeps = (dataDir: string, sync: SyncDeps): OriginalDeps => (setMailTrashProbe(app => instanceCanTrash(dataDir, app, sync)), {
	allowed: r => originalDeletable(dataDir, sync)(r),
	exec: sync.exec,
	plugin: sync.plugin,
	read: zeleRead,
	remove: sync.remove,
	changed: sync.changed,
	...(sync.log ? { log: sync.log } : {}),
	pending: fileStore(join(dataDir, "mail-original-deletes.json")),
});
