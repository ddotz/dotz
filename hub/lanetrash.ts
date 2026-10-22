// Deleting ended lanes (owner 2026-10-20: "종료된 레인 개별 삭제 ... 한번에 여러개 선택해서도"). Nothing is erased at once:
// the lane's folder (lane.json, brief, reports, asks, overlay) and its session transcript move into
// DATA_DIR/trash/<ts>-<name>/, kept TRASH_KEEP_MS and purged by the hourly data cleanup (hygiene.ts); restoreLanes()
// below moves them back (the web app's 되돌리기). A live or running lane is refused.
//
// Git: a lane worktree with uncommitted changes refuses the delete (nothing of it is touched). A clean one is removed with
// a plain `git worktree remove` (never --force); its branch is deleted with `git branch -d` only when it has no commits
// outside the base branch, otherwise the branch stays and the result says so (restore re-adds the worktree from it).
//
// Discord: the lane's channel mapping is dropped at once; a lane's own channel is deleted by the bot CHANNEL_DELAY_MS later
// (past the undo window; restore before then keeps it). A home-thread lane only loses its mapping: the thread and its
// parent work channel stay.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DATA_DIR, log, paths, writeAtomic } from "./config.ts";
import { newCtx } from "./context.ts";
import { broadcast } from "./events.ts";
import { type Lane, laneRunning, lanes } from "./lanes.ts";
import { dropChannelNotices, dropLaneNotices } from "./notices.ts";

export const TRASH_DIR = join(DATA_DIR, "trash");
export const TRASH_KEEP_MS = 7 * 86_400_000;
export const CHANNEL_DELAY_MS = 60_000;

export type LaneChannel = { id: string; home?: string };
// discord.ts behind a port, so tests (and a gateway without Discord) run without the bot.
type ChannelPort = { take(lane: string): LaneChannel | undefined; put(lane: string, ch: LaneChannel): void; remove(id: string): Promise<void> };
let port: ChannelPort = { take: () => undefined, put: () => {}, remove: async () => {} };
export function setTrashChannels(p: ChannelPort): void {
	port = p;
}

type Meta = {
	id: string;
	name: string;
	deletedAt: string;
	laneDir: string;
	sessions: Array<{ from: string; to: string }>;
	worktree?: { path: string; repo: string; branch: string; base: string; branchKept: boolean; note: string };
	channel?: LaneChannel & { deleteAt: number; deleted?: boolean };
};
type DeleteResult = { name: string; ok: true; id: string; notes: string[] } | { name: string; ok: false; error: string };
type RestoreResult = { id: string; name?: string; ok: true; notes: string[] } | { id: string; name?: string; ok: false; error: string };

class LaneDeleteRefused extends Error {}

const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
// Same filesystem in practice (all under the home folder); a cross-device move falls back to copy + remove.
function move(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
		cpSync(from, to, { recursive: true });
		rmSync(from, { recursive: true, force: true });
	}
}
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const metaFile = (id: string) => join(TRASH_DIR, id, "meta.json");
const writeMeta = (m: Meta) => writeAtomic(metaFile(m.id), `${JSON.stringify(m, null, 2)}\n`);
function readMeta(id: string): Meta | undefined {
	try {
		return JSON.parse(readFileSync(metaFile(id), "utf8")) as Meta;
	} catch {
		return undefined;
	}
}
const timers = new Map<string, Timer>();

function deleteChannelNow(m: Meta): void {
	timers.delete(m.id);
	const live = readMeta(m.id);
	// Restored or purged meanwhile: the lane has its channel back, or the entry is gone.
	if (!live?.channel || live.channel.deleted || live.channel.home) return;
	const ch = live.channel;
	void port.remove(ch.id).then(
		() => {
			if (!existsSync(metaFile(m.id))) return;
			live.channel = { ...ch, deleted: true };
			writeMeta(live);
			log(`lane delete: discord channel ${ch.id} of ${live.name} deleted`);
		},
		e => log(`lane delete: discord channel ${ch.id} of ${live.name} not deleted (retried by the hourly cleanup): ${e}`),
	);
}

function dropWorktree(lane: Lane): Meta["worktree"] {
	const w = lane.worktree;
	if (!w || !existsSync(w.path)) return undefined;
	const status = git(w.path, "status", "--porcelain");
	if (!status.ok) throw new LaneDeleteRefused(`worktree ${w.path} could not be checked: ${status.err}`);
	if (status.out) throw new LaneDeleteRefused(`worktree ${w.path} has uncommitted changes; nothing was deleted`);
	const unique = git(w.repo, "rev-list", "--count", `${w.base}..${w.branch}`);
	const kept = !unique.ok || Number(unique.out) > 0;
	const rm = git(w.repo, "worktree", "remove", w.path);
	if (!rm.ok) throw new LaneDeleteRefused(`git worktree remove ${w.path} failed: ${rm.err}`);
	if (kept) return { ...w, branchKept: true, note: `branch ${w.branch} kept (${unique.ok ? `${unique.out} commit(s) not in ${w.base}` : `could not compare with ${w.base}`}); worktree folder removed` };
	const del = git(w.repo, "branch", "-d", w.branch);
	return { ...w, branchKept: !del.ok, note: del.ok ? `worktree and branch ${w.branch} removed (no commits outside ${w.base})` : `worktree removed; branch ${w.branch} kept: ${del.err}` };
}

function deleteLane(name: string, now = Date.now()): DeleteResult {
	const lane = lanes.get(name);
	if (!lane) return { name, ok: false, error: `세션 ${name}이(가) 없어요` };
	if (lane.proc || laneRunning(lane)) return { name, ok: false, error: `세션 ${name}은(는) 아직 실행 중이에요. 종료된 세션만 지울 수 있어요` };
	const id = `${stamp(now)}-${name}`;
	const root = join(TRASH_DIR, id);
	if (existsSync(root)) return { name, ok: false, error: `휴지통에 ${id}이(가) 이미 있어요` };
	let worktree: Meta["worktree"];
	try {
		worktree = dropWorktree(lane);
	} catch (e) {
		if (e instanceof LaneDeleteRefused) return { name, ok: false, error: e.message };
		throw e;
	}
	const notes: string[] = [];
	if (worktree) notes.push(worktree.note);
	const laneDir = join(paths.lanes, name);
	const m: Meta = { id, name, deletedAt: new Date(now).toISOString(), laneDir, sessions: [] };
	if (worktree) m.worktree = worktree;
	mkdirSync(root, { recursive: true });
	if (existsSync(laneDir)) move(laneDir, join(root, "lane"));
	// A merged branch is gone, so the saved record points back at the owner's checkout (as lanes.ts dropWorktree does).
	if (worktree && !worktree.branchKept) {
		const file = join(root, "lane", "lane.json");
		if (existsSync(file)) {
			const rec = JSON.parse(readFileSync(file, "utf8"));
			rec.cwd = join(worktree.repo, relative(worktree.path, rec.cwd));
			delete rec.worktree;
			writeAtomic(file, `${JSON.stringify(rec, null, 2)}\n`);
		}
	}
	const session = lane.sessionFile;
	if (session && existsSync(session)) {
		const artifacts = session.replace(/\.jsonl$/, "");
		for (const from of [session, ...(artifacts !== session && existsSync(artifacts) ? [artifacts] : [])]) {
			const to = join(root, "sessions", basename(from));
			move(from, to);
			m.sessions.push({ from, to });
		}
	}
	const ch = port.take(name);
	if (ch) {
		m.channel = { ...ch, deleteAt: now + CHANNEL_DELAY_MS };
		notes.push(ch.home ? "discord thread mapping dropped (thread and work channel kept)" : "discord channel is deleted in a minute");
	}
	writeMeta(m);
	lanes.delete(name);
	// Its notices go with it: questions closed, the rest read and off the badge.
	dropLaneNotices(name);
	if (ch) dropChannelNotices(`ch:${ch.id}`);
	if (m.channel && !m.channel.home) timers.set(id, setTimeout(() => deleteChannelNow(m), CHANNEL_DELAY_MS));
	log(`lane delete: ${name} -> trash/${id}${notes.length ? ` (${notes.join("; ")})` : ""}`);
	return { name, ok: true, id, notes };
}

export function deleteLanes(names: string[], now = Date.now()): DeleteResult[] {
	const out = [...new Set(names)].map(n => {
		try {
			return deleteLane(n, now);
		} catch (e) {
			log(`lane delete: ${n} failed: ${e}`);
			return { name: n, ok: false as const, error: (e as Error).message };
		}
	});
	if (out.some(r => r.ok)) broadcast({ kind: "lanes", deleted: out.filter(r => r.ok).map(r => r.name) });
	return out;
}

function restoreOne(id: string): RestoreResult {
	const m = basename(id) === id ? readMeta(id) : undefined;
	if (!m) return { id, ok: false, error: `휴지통에 ${id}이(가) 없어요` };
	const root = join(TRASH_DIR, id);
	if (lanes.has(m.name) || existsSync(m.laneDir)) return { id, name: m.name, ok: false, error: `세션 ${m.name}이(가) 이미 있어서 되돌릴 수 없어요` };
	const notes: string[] = [];
	clearTimeout(timers.get(id));
	timers.delete(id);
	if (existsSync(join(root, "lane"))) move(join(root, "lane"), m.laneDir);
	for (const s of m.sessions) if (existsSync(s.to) && !existsSync(s.from)) move(s.to, s.from);
	const file = join(m.laneDir, "lane.json");
	const rec = JSON.parse(readFileSync(file, "utf8"));
	const w = m.worktree;
	if (w?.branchKept && rec.worktree && !existsSync(w.path)) {
		const add = git(w.repo, "worktree", "add", w.path, w.branch);
		if (add.ok) notes.push(`worktree re-added from ${w.branch}`);
		else {
			// No worktree: the lane resumes in the owner's checkout path, and lanes.ts makes it a fresh worktree on resume.
			rec.cwd = join(w.repo, relative(w.path, rec.cwd));
			delete rec.worktree;
			writeAtomic(file, `${JSON.stringify(rec, null, 2)}\n`);
			notes.push(`worktree not re-added (${add.err}); branch ${w.branch} is still there`);
		}
	}
	if (m.channel && !m.channel.deleted) {
		port.put(m.name, { id: m.channel.id, ...(m.channel.home ? { home: m.channel.home } : {}) });
		notes.push("discord channel kept");
	} else if (m.channel) notes.push("discord channel was already deleted; the lane gets a new one when it is launched again");
	lanes.set(m.name, { ...rec, lastText: "", ctx: newCtx() } as Lane);
	rmSync(root, { recursive: true, force: true });
	log(`lane restore: trash/${id} -> ${m.name}${notes.length ? ` (${notes.join("; ")})` : ""}`);
	return { id, name: m.name, ok: true, notes };
}

export function restoreLanes(ids: string[]): RestoreResult[] {
	const out = [...new Set(ids)].map(id => {
		try {
			return restoreOne(id);
		} catch (e) {
			log(`lane restore: ${id} failed: ${e}`);
			return { id, ok: false as const, error: (e as Error).message };
		}
	});
	if (out.some(r => r.ok)) broadcast({ kind: "lanes", restored: out.flatMap(r => (r.ok && r.name ? [r.name] : [])) });
	return out;
}

export function trashList(): Array<{ id: string; name: string; deletedAt: string }> {
	if (!existsSync(TRASH_DIR)) return [];
	return readdirSync(TRASH_DIR)
		.flatMap(id => {
			const m = readMeta(id);
			return m ? [{ id, name: m.name, deletedAt: m.deletedAt }] : [];
		})
		.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// Hourly (hygiene.ts runDataCleanup): entries past TRASH_KEEP_MS go for good; a channel whose delayed delete was lost to
// a gateway restart (or failed) is deleted now.
export function purgeTrash(now = Date.now()): string | undefined {
	if (!existsSync(TRASH_DIR)) return undefined;
	const gone: string[] = [];
	for (const id of readdirSync(TRASH_DIR)) {
		const m = readMeta(id);
		const at = m ? Date.parse(m.deletedAt) : statSync(join(TRASH_DIR, id)).mtimeMs;
		if (now - at >= TRASH_KEEP_MS) {
			if (m?.channel && !m.channel.deleted && !m.channel.home) void port.remove(m.channel.id).catch(e => log(`trash purge: discord channel ${m.channel?.id} not deleted: ${e}`));
			clearTimeout(timers.get(id));
			timers.delete(id);
			rmSync(join(TRASH_DIR, id), { recursive: true, force: true });
			gone.push(id);
		} else if (m?.channel && !m.channel.deleted && !m.channel.home && now >= m.channel.deleteAt && !timers.has(id)) deleteChannelNow(m);
	}
	return gone.length ? `purged ${gone.length} deleted lane(s) older than ${TRASH_KEEP_MS / 86_400_000} days from trash: ${gone.join(", ")}` : undefined;
}
