// A [file] chip must always open: a message's files are copied into <data dir>/files/ when it is sent (so a deleted /tmp file still opens),
// an old path outside the roots is served from the home folder or /tmp, secrets and traversal stay refused, a gone file says so.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "./events.ts";
import { allowedRoots, fileRoute, LOST } from "./files.ts";
import { FILES, snapshotsIdle } from "./filesnap.ts";

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
