import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// An owner's answer ("1) 보내기" tapped or typed) is proof for a send only when the gateway wrote it: the gateway adds an HMAC `seal` to every inbox line,
// keyed by a 0600 file next to the log, so a line another process appended by hand carries no valid seal. Readers (the send CLIs) never create the key.
const keyFile = (inboxPath: string): string => join(dirname(inboxPath), "secrets", "approval-key");
const KEY_BYTES = 32;

/** The key of this inbox, or undefined when it has none (nothing is then sealed, so nothing verifies). */
export function readSealKey(inboxPath: string): Buffer | undefined {
	try {
		const key = readFileSync(keyFile(inboxPath));
		return key.length >= KEY_BYTES ? key : undefined;
	} catch {
		return undefined;
	}
}

function gatewayKey(inboxPath: string): Buffer {
	const have = readSealKey(inboxPath);
	if (have) return have;
	const file = keyFile(inboxPath);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const key = randomBytes(KEY_BYTES);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, key, { mode: 0o600 });
	renameSync(tmp, file);
	return key;
}

const mac = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(body).digest();

/** The inbox line (without its newline) for `event`, sealed over every field of it. Gateway side only: this creates the key when there is none. */
export function sealLine(inboxPath: string, event: Record<string, unknown>): string {
	const { seal: _own, ...body } = event;
	return JSON.stringify({ ...body, seal: mac(gatewayKey(inboxPath), JSON.stringify(body)).toString("hex") });
}

/** Append `event` to the inbox the way the gateway does: sealed. */
export const appendSealed = (inboxPath: string, event: Record<string, unknown>): void => appendFileSync(inboxPath, `${sealLine(inboxPath, event)}\n`);

/** Was this parsed inbox line sealed with `key`? A line changed after sealing, or sealed with another key, or not sealed at all, is not. */
export function isSealed(key: Buffer | undefined, line: Record<string, unknown>): boolean {
	if (!key || typeof line.seal !== "string") return false;
	const { seal, ...body } = line;
	const want = mac(key, JSON.stringify(body));
	const got = Buffer.from(seal, "hex");
	return got.length === want.length && timingSafeEqual(got, want);
}
