// Verification codes from the macOS Messages database (DESIGN R4): the newest code that arrived after a given time, for a
// service. The database is opened read-only; the code is returned to the caller and never logged here.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export class MessagesAccessError extends Error {}

export type OtpService = "google" | "instagram" | "generic";
export const MESSAGES_DB = () => join(homedir(), "Library", "Messages", "chat.db");

// Apple dates are ns since 2001-01-01 (older databases: seconds).
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

// typedstream: ... "NSString" 01 94 84 01 2B <len> <utf8 bytes> ...; len is one byte, or 0x81 + 2-byte little endian.
export function decodeAttributedBody(buf: Uint8Array): string | undefined {
	const marker = Buffer.from("NSString");
	const at = Buffer.from(buf).indexOf(marker);
	if (at < 0) return undefined;
	let i = at + marker.length;
	const limit = Math.min(buf.length, i + 16);
	while (i < limit && buf[i] !== 0x2b) i++;
	if (i >= limit) return undefined;
	i++;
	let len = buf[i++];
	if (len === undefined) return undefined;
	if (len === 0x81) {
		if (i + 2 > buf.length) return undefined;
		len = buf[i]! | (buf[i + 1]! << 8);
		i += 2;
	}
	if (i + len > buf.length) return undefined;
	return Buffer.from(buf.subarray(i, i + len)).toString("utf8");
}

const NEAR_CODE = /코드|code|인증|verification/i;

// The code inside one message for the service, or undefined when the message is not a code for it.
export function extractCode(text: string, service: OtpService): string | undefined {
	if (service === "google") {
		const g = /\bG-(\d{6})\b/.exec(text);
		if (g) return g[1];
		return /구글|google/i.test(text) ? /\b(\d{6})\b/.exec(text)?.[1] : undefined;
	}
	if (service === "instagram") return /instagram|facebook|meta|인스타|페이스북|메타/i.test(text) ? /\b(\d{6,8})\b/.exec(text)?.[1] : undefined;
	return NEAR_CODE.test(text) ? /\b(\d{4,8})\b/.exec(text)?.[1] : undefined;
}

type Row = { text: string | null; attributedBody: Uint8Array | null; sender: string | null };

function open(db: string): Database {
	try {
		return new Database(db, { readonly: true });
	} catch (e) {
		throw new MessagesAccessError(`메시지 보관함을 열지 못했어요 (${(e as Error).message.slice(0, 80)})`);
	}
}

// Newest matching code received after `since`, or undefined.
export function readCodeSince(db: string, service: OtpService, since: Date): string | undefined {
	const conn = open(db);
	try {
		const sinceSec = (since.getTime() - APPLE_EPOCH_MS) / 1000;
		const rows = conn
			.query(
				`SELECT m.text AS text, m.attributedBody AS attributedBody, h.id AS sender
				 FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
				 WHERE m.is_from_me = 0 AND (CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000.0 ELSE m.date END) > ?
				 ORDER BY m.date DESC LIMIT 50`,
			)
			.all(sinceSec) as Row[];
		for (const r of rows) {
			const body = r.text ?? (r.attributedBody ? decodeAttributedBody(r.attributedBody) : undefined);
			if (!body) continue;
			const code = extractCode(body, service);
			if (code) return code;
		}
		return undefined;
	} catch (e) {
		if (e instanceof MessagesAccessError) throw e;
		throw new MessagesAccessError(`메시지 보관함을 읽지 못했어요 (${(e as Error).message.slice(0, 80)})`);
	} finally {
		conn.close();
	}
}

export type WaitOpts = { db?: string; service: OtpService; since: Date; timeoutMs?: number; pollMs?: number; sleep: (ms: number) => Promise<void> };

// Polls until a code shows up or timeoutMs of injected sleep passed; undefined on timeout.
export async function waitForCode(o: WaitOpts): Promise<string | undefined> {
	const db = o.db ?? MESSAGES_DB();
	const poll = o.pollMs ?? 3000;
	const timeout = o.timeoutMs ?? 120_000;
	for (let waited = 0; ; waited += poll) {
		const code = readCodeSince(db, o.service, o.since);
		if (code) return code;
		if (waited >= timeout) return undefined;
		await o.sleep(poll);
	}
}

// Throws MessagesAccessError when the database cannot be read (no Full Disk Access).
export function probeMessages(db: string = MESSAGES_DB()): void {
	readCodeSince(db, "generic", new Date());
}
