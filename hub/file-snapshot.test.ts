// A [file] chip must always open: a message's files are copied into <data dir>/files/ when it is sent (so a deleted /tmp file still opens),
// an old path outside the roots is served from the home folder or /tmp, secrets and traversal stay refused, a gone file says so.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "./events.ts";
import { allowedRoots, fileRoute, LOST } from "./files.ts";
import { FILES, snapshotsIdle, sweepSnapshots } from "./filesnap.ts";

const DATA = process.env.DOTZ_DIR!;
const work = mkdtempSync(join(tmpdir(), "snap-"));
const slashTmp = `/tmp/dotz-snap-${process.pid}-${Date.now().toString(36)}.png`;
afterAll(() => {
	rmSync(work, { recursive: true, force: true });
	rmSync(slashTmp, { force: true });
});

const get = (path: string, method = "GET") => {
	const url = new URL(`http://x/api/file?path=${encodeURIComponent(path)}`);
	return fileRoute(new Request(url, { method }), url, allowedRoots([]), new Set());
};
const send = (...paths: string[]) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: `결과\n${paths.map(p => `[file] ${p}`).join("\n")}` });
const sendLaneReport = (path: string) => emit("inbox", { ts: new Date().toISOString(), kind: "lane_report", source: "lane:a", lane: "a", text: `끝\n[file] ${path}` });

test("a sent file is copied into files/ and still opens after the original is deleted", async () => {
	const shot = join(work, "shot.png");
	writeFileSync(shot, "PNGBYTES");
	send(shot);
	await snapshotsIdle();
	rmSync(shot);
	const res = get(shot);
	expect([res.status, res.headers.get("content-type"), await res.text()]).toEqual([200, "image/png", "PNGBYTES"]);
	expect(existsSync(FILES)).toBe(true);
});

test("a lane report's /tmp file opens after /tmp loses it", async () => {
	writeFileSync(slashTmp, "LANEPNG");
	sendLaneReport(slashTmp);
	await snapshotsIdle();
	rmSync(slashTmp);
	const res = get(slashTmp);
	expect([res.status, await res.text()]).toEqual([200, "LANEPNG"]);
});

test("identical files are stored once, and a changed file at the same path gets its own copy", async () => {
	const a = join(work, "a.txt"), b = join(work, "b.txt");
	writeFileSync(a, "same");
	writeFileSync(b, "same");
	send(a, b);
	await snapshotsIdle();
	const dirs = (path: string) => new Bun.Glob("*/*").scanSync({ cwd: FILES }).toArray().filter(f => f.endsWith(path));
	expect(dirs("a.txt").length + dirs("b.txt").length).toBe(2);
	expect(dirs("a.txt")[0]!.split("/")[0]).toBe(dirs("b.txt")[0]!.split("/")[0]);
	writeFileSync(a, "changed text");
	send(a);
	await snapshotsIdle();
	rmSync(a);
	expect(await get(a).text()).toBe("changed text");
	expect(await get(b).text()).toBe("same");
});

test("an old path nobody snapshotted is served from /tmp or the temp dir, before and after it is a regular file only", async () => {
	const old = join(work, "old.pdf");
	writeFileSync(old, "%PDF");
	const res = get(old);
	expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/pdf"]);
	expect((await get(old, "HEAD")).headers.get("content-length")).toBe("4");
	expect(get(work).status).toBe(400);
});

test("a missing file says it was deleted", async () => {
	const res = get(join(work, "gone.png"));
	expect(res.status).toBe(404);
	expect((await res.json()).error).toBe(LOST);
	expect(decodeURIComponent(res.headers.get("x-file-note")!)).toBe(LOST);
});

test("secrets, keys, the data dir and traversal stay refused", () => {
	mkdirSync(join(work, ".ssh"), { recursive: true });
	mkdirSync(join(work, "Library", "Keychains"), { recursive: true });
	writeFileSync(join(work, ".ssh", "id_ed25519"), "k");
	writeFileSync(join(work, "cert.pem"), "k");
	writeFileSync(join(work, "server.key"), "k");
	writeFileSync(join(work, "Library", "Keychains", "login.keychain-db"), "k");
	mkdirSync(join(DATA, "secrets"), { recursive: true });
	writeFileSync(join(DATA, "secrets", "t.txt"), "k");
	writeFileSync(join(DATA, "config.json.bak"), "k");
	symlinkSync(join(work, ".ssh", "id_ed25519"), join(work, "innocent.png"));
	mkdirSync(join(work, "sub"), { recursive: true });
	send(join(work, "cert.pem"), join(work, "innocent.png"), join(DATA, "secrets", "t.txt"));
	for (const p of [join(work, ".ssh", "id_ed25519"), join(work, "cert.pem"), join(work, "server.key"), join(work, "Library", "Keychains", "login.keychain-db"), join(work, "innocent.png"), join(DATA, "secrets", "t.txt"), join(DATA, "config.json.bak")]) expect([p, get(p).status]).toEqual([p, 403]);
	expect(get(`${work}/sub/../../../../../../../../../../../../../../etc/hosts`).status).toBe(403);
	expect(get("/etc/hosts").status).toBe(403);
	expect(get("/").status).toBe(403);
});

test("a refused secret is never copied into files/", async () => {
	await snapshotsIdle();
	const stored = new Bun.Glob("**/*").scanSync({ cwd: FILES }).toArray();
	expect(stored.some(f => /cert\.pem|id_ed25519|t\.txt|innocent/.test(f))).toBe(false);
});

// Retention: a copy's last use is its file's mtime; the sweep drops copies unused for keep_days, then the least recently used while over the cap.
const DAY = 86_400_000;
const copyDirs = () => readdirSync(FILES, { withFileTypes: true }).filter(d => d.isDirectory() && /^[0-9a-f]{24}$/.test(d.name)).map(d => d.name).sort();
const plant = (id: string, bytes: number, ageDays: number) => {
	const dir = join(FILES, id.padEnd(24, "0"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "f.bin"), Buffer.alloc(bytes));
	const t = (Date.now() - ageDays * DAY) / 1000;
	utimesSync(join(dir, "f.bin"), t, t);
	return dir;
};
const clearCopies = () => copyDirs().forEach(d => rmSync(join(FILES, d), { recursive: true, force: true }));

test("a copy unused for keep_days is deleted, a recent one stays", async () => {
	clearCopies();
	const old = plant("a1", 10, 31), fresh = plant("b2", 10, 29);
	expect(await sweepSnapshots(Date.now(), { keepDays: 30, maxBytes: 1e9 })).toBe(1);
	expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
});

test("over the cap the least recently used copies go first, and the newest stays", async () => {
	clearCopies();
	const a = plant("c1", 100, 3), b = plant("c2", 100, 1), c = plant("c3", 100, 2), d = plant("c4", 100, 0.5);
	expect(await sweepSnapshots(Date.now(), { keepDays: 30, maxBytes: 250 })).toBe(2);
	expect([a, b, c, d].map(existsSync)).toEqual([false, true, false, true]);
	expect(await sweepSnapshots(Date.now(), { keepDays: 30, maxBytes: 1 })).toBe(1); // the newest copy is never removed by the cap
	expect([existsSync(b), existsSync(d)]).toEqual([false, true]);
});

test("serving a copy refreshes its last use, so it outlives the age limit", async () => {
	clearCopies();
	const orig = join(work, "keep-me.txt");
	writeFileSync(orig, "KEEP");
	send(orig);
	await snapshotsIdle();
	const dir = join(FILES, copyDirs()[0]!), copy = join(dir, "keep-me.txt");
	const old = (Date.now() - 40 * DAY) / 1000;
	utimesSync(copy, old, old);
	rmSync(orig);
	expect(await get(orig).text()).toBe("KEEP");
	expect(Date.now() - statSync(copy).mtimeMs).toBeLessThan(60_000);
	expect(await sweepSnapshots(Date.now(), { keepDays: 30, maxBytes: 1e9 })).toBe(0);
	expect(existsSync(copy)).toBe(true);
	// once the copy is deleted and the original is gone too, the chip says so
	utimesSync(copy, old, old);
	expect(await sweepSnapshots(Date.now(), { keepDays: 30, maxBytes: 1e9 })).toBe(1);
	const res = get(orig);
	expect([res.status, (await res.json()).error]).toEqual([404, LOST]);
});

test("the sweep never touches anything outside files/<sha>/ folders", async () => {
	clearCopies();
	const t = (Date.now() - 400 * DAY) / 1000;
	const ancient = (path: string) => { writeFileSync(path, "x"); utimesSync(path, t, t); };
	mkdirSync(join(DATA, "uploads", "u1"), { recursive: true });
	ancient(join(DATA, "uploads", "u1", "old.txt"));
	ancient(join(DATA, "outside.txt"));
	ancient(join(FILES, "index.jsonl"));
	mkdirSync(join(FILES, "not-a-copy"), { recursive: true });
	ancient(join(FILES, "not-a-copy", "x.txt"));
	const target = join(work, "linked");
	mkdirSync(target, { recursive: true });
	ancient(join(target, "x.txt"));
	symlinkSync(target, join(FILES, "f".repeat(24)));
	const gone = plant("d1", 5, 400);
	expect(await sweepSnapshots(Date.now(), { keepDays: 1, maxBytes: 1 })).toBe(1);
	expect(existsSync(gone)).toBe(false);
	for (const path of [join(DATA, "uploads", "u1", "old.txt"), join(DATA, "outside.txt"), join(FILES, "index.jsonl"), join(FILES, "not-a-copy", "x.txt"), join(target, "x.txt")]) expect(existsSync(path)).toBe(true);
	rmSync(join(FILES, "f".repeat(24)), { force: true });
	rmSync(join(FILES, "not-a-copy"), { recursive: true, force: true });
});
