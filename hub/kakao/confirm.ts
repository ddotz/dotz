// Confirmation of a pressed 전송 from the database (read-only): KakaoTalk's own input emptying is not proof that the message left, so after a
// press the send waits for the owner's newest message of that text in that room. A send that cannot be confirmed is counted as sent once
// (unconfirmed) and never pressed again. All waits go through the injected clock/sleep, so a test drives them without real time.
import { readFileSync } from "node:fs";
import { getSecret } from "./creds.ts";
import { type KakaoDb, messages as dbMessages, sqlcipherDb } from "./db.ts";
import { sameText } from "./room.ts";
import type { KakaoPaths, Runner } from "./types.ts";

export type ConfirmMsg = { text: string; fromMe: boolean; sentAt: number };
// Reads the newest messages of one room. Injected: the gateway reuses its open database, a test its fixture.
export type ConfirmRead = (chatId: string) => Promise<ConfirmMsg[]>;
// true: the message is in the database; false: it is not (within the deadline); undefined: there is no database to ask.
export type Confirmer = (input: { chatId: string; text: string; since: number }) => Promise<boolean | undefined>;

export const CONFIRM_MS = 10_000;
const CONFIRM_EVERY_MS = 500;
// A message typed just before the press can be timestamped a few seconds earlier (the database clock, not ours).
const SKEW_MS = 5_000;

export type PollOpts = { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number };

export async function pollConfirm(read: ConfirmRead, input: { chatId: string; text: string; since: number }, opts: PollOpts = {}): Promise<boolean> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const deadline = now() + (opts.timeoutMs ?? CONFIRM_MS);
	const since = input.since - SKEW_MS;
	for (;;) {
		try {
			const list = await read(input.chatId);
			const hit = list.some(m => m.fromMe && sameText(m.text, input.text) && (m.sentAt > 1e11 ? m.sentAt : m.sentAt * 1000) >= since);
			if (hit) return true;
		} catch {}
		const left = deadline - now();
		if (left <= 0) return false;
		await sleep(Math.min(opts.intervalMs ?? CONFIRM_EVERY_MS, left));
	}
}

// The install's own database, opened once per install from its config and the Keychain key (the same pair cli.ts uses). Anything missing
// (no config, no database path, no key, an unreadable database) answers undefined.
type DbInfo = { db: KakaoDb; me: string };
const dbs = new Map<string, Promise<DbInfo | undefined>>();
function dbInfo(paths: KakaoPaths, runner: Runner): Promise<DbInfo | undefined> {
	const known = dbs.get(paths.config);
	if (known) return known;
	const opening = (async (): Promise<DbInfo | undefined> => {
		try {
			const config = JSON.parse(readFileSync(paths.config, "utf8")) as { dbPath?: unknown; userId?: unknown };
			if (typeof config?.dbPath !== "string" || !config.dbPath) return undefined;
			const key = await getSecret("dbkey", { paths, runner });
			if (!key) return undefined;
			return { db: sqlcipherDb(config.dbPath, key, runner), me: String(config.userId ?? "") };
		} catch {
			return undefined;
		}
	})();
	dbs.set(paths.config, opening);
	return opening;
}

// The confirmer of a production send: the owner's newest message of the text, within the deadline.
export function dbConfirmer(paths: KakaoPaths, runner: Runner, opts: PollOpts = {}): Confirmer {
	return async input => {
		const info = await dbInfo(paths, runner);
		if (!info) return undefined;
		const read: ConfirmRead = chatId => dbMessages(info.db, chatId, 20, info.me).then(list => list.map(m => ({ text: m.text, fromMe: m.fromMe, sentAt: m.sentAt })));
		return pollConfirm(read, input, opts);
	};
}

// The room's newest message (what the list shows under its name), for telling same-name rooms apart when the caller's room facts carry no
// preview. Undefined when there is no database to ask.
export function dbPreview(paths: KakaoPaths, runner: Runner): (chatId: string) => Promise<string | undefined> {
	return async chatId => {
		const info = await dbInfo(paths, runner);
		if (!info) return undefined;
		try {
			const list = await dbMessages(info.db, chatId, 1, info.me);
			const text = list.at(-1)?.text ?? "";
			return text.trim() ? text : undefined;
		} catch {
			return undefined;
		}
	};
}
