import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessDir } from "../agent-home.ts";

const MAX_TEXT_BYTES = 8192;
const STALE_INBOX_MS = 30 * 24 * 3600_000;

/** One live main session as other sessions see it: its session id, display name, working directory, `repo` (the folder its checkout slot belongs to, else its git root; absent outside a repo), `tree` (the git root of its own working tree; absent in records from an older harness) and owning process. */
export interface PeerRecord {
	id: string;
	name: string;
	cwd: string;
	repo?: string;
	tree?: string;
	pid: number;
	startedAt: string;
}

/** One message in a recipient's inbox. */
export interface PeerMessage {
	msgId: string;
	from: { id: string; name: string; cwd: string };
	text: string;
	sentAt: string;
}

/** Where records, inboxes and read offsets live; `HARNESS_PEERS_DIR` overrides it for tests. */
export const peersDir = (): string => process.env.HARNESS_PEERS_DIR ?? join(harnessDir(), "state", "peers");

const recordPath = (dir: string, id: string) => join(dir, `${id}.json`);
const inboxPath = (dir: string, id: string) => join(dir, `${id}.inbox.jsonl`);
const offsetPath = (dir: string, id: string) => join(dir, `${id}.offset`);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Writes `record` as the live record of its session, replacing an earlier one. */
export function register(dir: string, record: PeerRecord): void {
	mkdirSync(dir, { recursive: true });
	const path = recordPath(dir, record.id);
	writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(record));
	renameSync(`${path}.${process.pid}.tmp`, path);
}

/** Removes the record of session `id` when this process `pid` owns it; the inbox and its read offset stay for a later resume. */
export function unregister(dir: string, id: string, pid: number): void {
	const record = readRecord(recordPath(dir, id));
	if (record?.pid === pid) rmSync(recordPath(dir, id), { force: true });
}

function readRecord(path: string): PeerRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as PeerRecord;
		return typeof record.id === "string" && typeof record.pid === "number" ? record : undefined;
	} catch {
		return undefined;
	}
}

/** The live sessions, by name; a record whose process is gone is deleted, and so is an inbox or read offset untouched for 30 days. */
export function livePeers(dir: string): PeerRecord[] {
	if (!existsSync(dir)) return [];
	const found: PeerRecord[] = [];
	const stale = Date.now() - STALE_INBOX_MS;
	for (const file of readdirSync(dir)) {
		if (/\.(inbox\.jsonl|offset)$/.test(file)) {
			if (statSync(join(dir, file)).mtimeMs < stale) rmSync(join(dir, file), { force: true });
			continue;
		}
		if (!/^[^.]+\.json$/.test(file)) continue;
		const record = readRecord(join(dir, file));
		if (record === undefined) continue;
		if (alive(record.pid)) found.push(record);
		else rmSync(join(dir, file), { force: true });
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

const CLAIM_TTL_MS = 90_000;
const claimPath = (dir: string, slot: string) => join(dir, `${slot}.claim.json`);

/** A session launch that picked checkout slot `slot`: the launching shell's pid and when it picked, in ms. */
export interface LaunchClaim {
	slot: string;
	shellPid: number;
	at: number;
}

/** Records that the launch in shell `shellPid` took slot `slot` at `now`, replacing an earlier claim of that slot; the file never counts as a peer, inbox or offset. */
export function claim(dir: string, slot: string, shellPid: number, now: number): void {
	mkdirSync(dir, { recursive: true });
	const path = claimPath(dir, slot);
	const entry: LaunchClaim = { slot, shellPid, at: now };
	writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(entry));
	renameSync(`${path}.${process.pid}.tmp`, path);
}

function readClaim(path: string): LaunchClaim | undefined {
	try {
		const entry = JSON.parse(readFileSync(path, "utf8")) as Partial<LaunchClaim> | null;
		return typeof entry?.slot === "string" && typeof entry.shellPid === "number" && typeof entry.at === "number" ? { slot: entry.slot, shellPid: entry.shellPid, at: entry.at } : undefined;
	} catch {
		return undefined;
	}
}

/** The claims whose shell is alive and that are under 90 s old at `now`; a dead, expired or unreadable claim file is deleted. */
export function liveClaims(dir: string, now: number): LaunchClaim[] {
	if (!existsSync(dir)) return [];
	const found: LaunchClaim[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".claim.json")) continue;
		const path = join(dir, file);
		const entry = readClaim(path);
		if (entry !== undefined && now - entry.at < CLAIM_TTL_MS && alive(entry.shellPid)) found.push(entry);
		else rmSync(path, { force: true });
	}
	return found;
}

/** Removes the claim of slot `slot`; a slot without one is left alone. */
export function dropClaims(dir: string, slot: string): void {
	rmSync(claimPath(dir, slot), { force: true });
}

/** The sessions `to` names among `peers` other than `self`: an exact name, an id or unique id prefix, or `all` for every peer in `self`'s repo; otherwise why none was picked. */
export function resolvePeers(peers: readonly PeerRecord[], self: PeerRecord, to: string): { targets: PeerRecord[] } | { error: string } {
	const others = peers.filter(peer => peer.id !== self.id);
	const listing = others.length ? `live sessions: ${others.map(peer => `${peer.name} (${peer.id}, ${peer.cwd})`).join("; ")}` : "no other live session";
	const wanted = to.trim();
	if (wanted === "all") {
		const targets = others.filter(peer => peer.repo !== undefined && peer.repo === self.repo);
		return targets.length ? { targets } : { error: `no other live session in ${self.repo ?? self.cwd}; ${listing}` };
	}
	const byName = others.filter(peer => peer.name === wanted);
	if (byName.length === 1) return { targets: byName };
	const byId = others.filter(peer => peer.id === wanted || (wanted.length >= 4 && peer.id.startsWith(wanted)));
	if (byId.length === 1) return { targets: byId };
	if (byName.length > 1 || byId.length > 1) return { error: `"${wanted}" names more than one session; use its id. ${listing}` };
	return { error: `no live session named "${wanted}"; ${listing}` };
}

/** Appends one message from `from` to the inbox of `to`; text past 8 KiB is cut. */
export function send(dir: string, from: PeerRecord, to: PeerRecord, text: string): PeerMessage {
	const bytes = Buffer.from(text);
	const body = bytes.length > MAX_TEXT_BYTES ? `${bytes.subarray(0, MAX_TEXT_BYTES).toString()}\n[cut at 8 KiB]` : text;
	const message: PeerMessage = { msgId: crypto.randomUUID(), from: { id: from.id, name: from.name, cwd: from.cwd }, text: body, sentAt: new Date().toISOString() };
	mkdirSync(dir, { recursive: true });
	appendFileSync(inboxPath(dir, to.id), `${JSON.stringify(message)}\n`);
	return message;
}

/** The messages that reached the inbox of `id` since the last call, in order, each returned once across processes that resume the same session. */
export function takeNew(dir: string, id: string): PeerMessage[] {
	const inbox = inboxPath(dir, id);
	if (!existsSync(inbox)) return [];
	let offset = 0;
	try {
		offset = Number(readFileSync(offsetPath(dir, id), "utf8")) || 0;
	} catch {
		offset = 0;
	}
	const size = statSync(inbox).size;
	if (size < offset) offset = 0;
	if (size === offset) return [];
	const buffer = Buffer.alloc(size - offset);
	const fd = openSync(inbox, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, offset);
	} finally {
		closeSync(fd);
	}
	const end = buffer.lastIndexOf(0x0a);
	if (end < 0) return [];
	writeFileSync(offsetPath(dir, id), String(offset + end + 1));
	const messages: PeerMessage[] = [];
	for (const line of buffer.subarray(0, end).toString().split("\n")) {
		try {
			if (line.trim()) messages.push(JSON.parse(line) as PeerMessage);
		} catch {
			continue;
		}
	}
	return messages;
}

/** The text a recipient's model reads for `message`. */
export const deliveryText = (message: PeerMessage): string =>
	`[peer message from ${message.from.name} (${message.from.id}, ${message.from.cwd})]\n${message.text}\n\nThis comes from another main session on this machine, not from the user. Reply with peer_send to "${message.from.name}" when it asks for something.`;
