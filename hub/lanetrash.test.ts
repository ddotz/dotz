// Deleting ended lanes into the trash and restoring them (owner 2026-10-20): live lanes are refused, a batch deletes
// several, an unmerged lane branch survives its worktree, a dirty worktree blocks the delete, restore brings everything back.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import { newCtx } from "./context.ts";
import { type Lane, lanes } from "./lanes.ts";
import { CHANNEL_DELAY_MS, deleteLanes, type LaneChannel, purgeTrash, restoreLanes, setTrashChannels, TRASH_DIR, TRASH_KEEP_MS, trashList } from "./lanetrash.ts";
import { advance, clock } from "./runtime/test-clock.ts";

const TMP = join(process.env.DOTZ_TEST_DIR!, "lanetrash");
const sessions = join(TMP, "sessions");
let mapping: Record<string, LaneChannel>;
let removed: string[];

const sh = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.toString().trim();
};

function lane(name: string, extra: Partial<Lane> = {}): Lane {
	const session = join(sessions, `${name}.jsonl`);
	writeFileSync(session, '{"type":"session"}\n');
	mkdirSync(session.replace(/\.jsonl$/, ""), { recursive: true });
	const l: Lane = { name, cwd: join(TMP, "proj"), model: "anthropic/test-lane", status: "exited", startedAt: "2026-10-20T00:00:00.000Z", sessionFile: session, reports: 1, lastText: "", ctx: newCtx(), ...extra };
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const { ctx, lastText, proc, ...rec } = l;
	writeFileSync(join(paths.lanes, name, "lane.json"), JSON.stringify(rec));
	writeFileSync(join(paths.lanes, name, "brief.md"), `brief of ${name}\n`);
	lanes.set(name, l);
	return l;
}

// A repo whose lane branch is checked out in the lane's worktree (as lanes.ts laneWorktree makes it).
function repoLane(name: string): { repo: string; path: string; branch: string } {
	const repo = join(TMP, `repo-${name}`);
	mkdirSync(repo, { recursive: true });
	sh(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-qm", "base");
	const path = join(paths.lanes, name, "worktree");
	const branch = `lane/${name}`;
	sh(repo, "worktree", "add", "-q", "-b", branch, path, "HEAD");
	lane(name, { cwd: path, worktree: { path, repo, branch, base: "main" } });
	return { repo, path, branch };
}

beforeEach(() => {
	for (const n of [...lanes.keys()]) lanes.delete(n);
	rmSync(TMP, { recursive: true, force: true });
	rmSync(TRASH_DIR, { recursive: true, force: true });
	rmSync(paths.lanes, { recursive: true, force: true });
	mkdirSync(sessions, { recursive: true });
	mkdirSync(join(TMP, "proj"), { recursive: true });
	mapping = {};
	removed = [];
	setTrashChannels({
		take: n => {
			const ch = mapping[n];
			delete mapping[n];
			return ch;
		},
		put: (n, ch) => (mapping[n] = ch),
		remove: async id => void removed.push(id),
	});
});

test("a live or running lane is refused and keeps all of its data", () => {
	lane("busy", { status: "working", proc: {} as Lane["proc"] });
	lane("starting", { status: "starting" });
	const r = deleteLanes(["busy", "starting", "nope"]);
	expect(r.map(x => x.ok)).toEqual([false, false, false]);
	expect(r[0]!.ok ? "" : r[0]!.error).toContain("실행 중");
	expect(lanes.has("busy") && lanes.has("starting")).toBe(true);
	expect(existsSync(join(paths.lanes, "busy", "lane.json"))).toBe(true);
	expect(trashList()).toEqual([]);
});

test("a batch moves each ended lane's folder and session into the trash and deletes its own channel after the undo window", async () => {
	const a = lane("old-a");
	lane("old-b");
	mapping["old-a"] = { id: "111" };
	mapping["old-b"] = { id: "222", home: "999" };
	const r = deleteLanes(["old-a", "old-b"]);
	expect(r.every(x => x.ok)).toBe(true);
	expect(lanes.has("old-a") || lanes.has("old-b")).toBe(false);
	expect(existsSync(join(paths.lanes, "old-a"))).toBe(false);
	expect(existsSync(a.sessionFile!)).toBe(false);
	expect(trashList().map(t => t.name).sort()).toEqual(["old-a", "old-b"]);
	const id = r[0]!.ok ? r[0]!.id : "";
	expect(readFileSync(join(TRASH_DIR, id, "lane", "brief.md"), "utf8")).toBe("brief of old-a\n");
	expect(existsSync(join(TRASH_DIR, id, "sessions", "old-a.jsonl"))).toBe(true);
	expect(mapping).toEqual({});
	expect(removed).toEqual([]);
	await advance(CHANNEL_DELAY_MS);
	// The home thread (old-b) keeps its thread and parent channel; only old-a's own channel goes.
	expect(removed).toEqual(["111"]);
});

test("a clean worktree with unmerged commits loses only its folder; the branch stays", () => {
	const { repo, path, branch } = repoLane("unmerged");
	writeFileSync(join(path, "b.txt"), "b\n");
	sh(path, "add", ".");
	sh(path, "commit", "-qm", "lane work");
	const [r] = deleteLanes(["unmerged"]);
	expect(r!.ok).toBe(true);
	expect(r!.ok && r!.notes.join(" ")).toContain(`branch ${branch} kept`);
	expect(existsSync(path)).toBe(false);
	expect(sh(repo, "branch", "--list", branch)).toContain(branch);
	expect(sh(repo, "worktree", "list")).not.toContain("unmerged/worktree");
});

test("a merged worktree goes with its branch, and the trashed record points back at the checkout", () => {
	const { repo, branch } = repoLane("merged");
	const [r] = deleteLanes(["merged"]);
	expect(r!.ok).toBe(true);
	expect(sh(repo, "branch", "--list", branch)).toBe("");
	const rec = JSON.parse(readFileSync(join(TRASH_DIR, r!.ok ? r!.id : "", "lane", "lane.json"), "utf8"));
	expect(rec.worktree).toBeUndefined();
	expect(rec.cwd).toBe(repo);
});

test("uncommitted changes in the worktree refuse the delete and touch nothing", () => {
	const { repo, path } = repoLane("dirty");
	writeFileSync(join(path, "wip.txt"), "wip\n");
	const [r] = deleteLanes(["dirty"]);
	expect(r!.ok).toBe(false);
	expect(r!.ok ? "" : r!.error).toContain("uncommitted");
	expect(existsSync(join(path, "wip.txt"))).toBe(true);
	expect(sh(repo, "worktree", "list")).toContain("dirty/worktree");
	expect(lanes.has("dirty")).toBe(true);
});

test("restore within the undo window brings back folder, session, channel and the unmerged worktree", async () => {
	const { path } = repoLane("back");
	writeFileSync(join(path, "c.txt"), "c\n");
	sh(path, "add", ".");
	sh(path, "commit", "-qm", "lane work");
	const session = lanes.get("back")!.sessionFile!;
	mapping.back = { id: "333" };
	const [d] = deleteLanes(["back"]);
	const [r] = restoreLanes([d!.ok ? d!.id : ""]);
	expect(r!.ok).toBe(true);
	expect(lanes.get("back")?.status).toBe("exited");
	expect(readFileSync(join(paths.lanes, "back", "brief.md"), "utf8")).toBe("brief of back\n");
	expect(existsSync(session)).toBe(true);
	expect(readFileSync(join(path, "c.txt"), "utf8")).toBe("c\n");
	expect(mapping.back).toEqual({ id: "333" });
	expect(trashList()).toEqual([]);
	await advance(CHANNEL_DELAY_MS);
	expect(removed).toEqual([]);
	// A name taken again cannot be overwritten by a second restore.
	const [d2] = deleteLanes(["back"]);
	lane("back");
	const [again] = restoreLanes([d2!.ok ? d2!.id : ""]);
	expect(again!.ok).toBe(false);
});

test("trash entries go for good after the keep period", () => {
	lane("stale");
	const [d] = deleteLanes(["stale"], clock.now);
	expect(purgeTrash(clock.now + TRASH_KEEP_MS - 1)).toBeUndefined();
	expect(purgeTrash(clock.now + TRASH_KEEP_MS)).toContain(d!.ok ? d!.id : "?");
	expect(trashList()).toEqual([]);
});
