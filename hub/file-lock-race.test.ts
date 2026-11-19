import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "./file-lock.ts";

const root = mkdtempSync(join(tmpdir(), "file-lock-race-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fakeNow = Date.now;
beforeEach(() => void (Date.now = () => new Date().getTime()));
afterEach(() => void (Date.now = fakeNow));
const makeStale = (path: string) => {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path);
	const old = new Date(new Date().getTime() - 60_000);
	utimesSync(path, old, old);
};

const lineReader = (stream: ReadableStream<Uint8Array>) => {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = "";
	return async (): Promise<string> => {
		for (;;) {
			const end = buffered.indexOf("\n");
			if (end >= 0) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				return line;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error("a waiter ended before its round");
			buffered += value;
		}
	};
};

test("waiters that all find a stale lock at once: one takes it over, and no write is lost", async () => {
	const dir = join(root, "race"), counter = join(dir, "counter");
	const procs = 8, rounds = 40;
	mkdirSync(dir);
	writeFileSync(counter, "0");
	const children = Array.from({ length: procs }, () =>
		Bun.spawn(["bun", join(import.meta.dir, "fixtures", "file-lock-child.ts"), dir, String(rounds)], { stdout: "pipe", stderr: "pipe", timeout: 20_000 }),
	);
	const reports = children.map(c => lineReader(c.stdout));
	let took = 0;
	for (let r = 0; r < rounds; r++) {
		makeStale(`${counter}.lock`);
		writeFileSync(join(dir, `go-${r}`), "");
		for (const report of await Promise.all(reports.map(next => next()))) took += Number(report);
	}
	await Promise.all(children.map(c => c.exited));
	for (const c of children) expect(c.exitCode, await new Response(c.stderr).text()).toBe(0);
	expect(took).toBeGreaterThanOrEqual(rounds);
	expect(Number(readFileSync(counter, "utf8"))).toBe(took);
	expect(existsSync(`${counter}.lock`)).toBe(false);
	expect(existsSync(`${counter}.lock.takeover`)).toBe(false);
}, 30_000);

test("a takeover guard left by a waiter that died in it is taken over once stale, and the stale lock after it", () => {
	const file = join(root, "dead-guard");
	makeStale(`${file}.lock`);
	makeStale(`${file}.lock.takeover`);
	const release = lock(file, { budgetMs: 2_000 });
	expect(existsSync(`${file}.lock`)).toBe(true);
	expect(existsSync(`${file}.lock.takeover`)).toBe(false);
	release();
	expect(existsSync(`${file}.lock`)).toBe(false);
});

test("a stale lock is not removed while another waiter's fresh takeover guard stands", () => {
	const file = join(root, "busy-guard");
	makeStale(`${file}.lock`);
	mkdirSync(`${file}.lock.takeover`);
	expect(() => lock(file, { budgetMs: 300 })).toThrow("잠겨 있어요");
	expect(existsSync(`${file}.lock`)).toBe(true);
});
