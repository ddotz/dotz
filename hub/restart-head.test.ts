import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestartGate, gatewayCodeChanged, promptHeadPrint } from "./restart.ts";
import { advance } from "./runtime/test-clock.ts";

const root = mkdtempSync(join(tmpdir(), "dotz-restart-head-"));
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(root, "t-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(o: { head: boolean; tokens: number; lastHeadAgoMs?: number }) {
	const state = { head: o.head, tokens: o.tokens, code: false, exits: 0, holds: 0 };
	const headFile = join(dir, "restart-head");
	if (o.lastHeadAgoMs !== undefined) writeFileSync(headFile, `${Date.now() - o.lastHeadAgoMs}\n`);
	const gate = createRestartGate({
		busy: () => [],
		collecting: () => false,
		startedAt: Date.now() - 3600_000,
		minGapMs: 5 * 60_000,
		noticeAfterMs: 20 * 60_000,
		notice: () => {},
		hold: () => state.holds++,
		log: () => {},
		exit: () => state.exits++,
		headChanged: () => state.head,
		codeChanged: () => state.code,
		contextTokens: () => state.tokens,
		headFile,
	});
	return { gate, state, headFile };
}

test("a restart that changes the prompt head waits, holding nothing, until the context is small, then goes and is remembered", async () => {
	const { gate, state } = setup({ head: true, tokens: 184_000 });
	expect(gate.request({ auto: true })).toContain("deferred");
	await advance(3 * 3600_000);
	expect(state.exits).toBe(0);
	expect(state.holds).toBe(0);
	expect(gate.waiting()).toBe(false);
	state.tokens = 46_000;
	await advance(65_000);
	expect(state.exits).toBe(1);
	const next = setup({ head: true, tokens: 30_000 });
	expect(next.gate.request({ auto: true })).toContain("deferred");
	await advance(65_000);
	expect(next.state.exits).toBe(0);
});

test("a restart that does not change the prompt head goes now, whatever the context", async () => {
	const { gate, state } = setup({ head: false, tokens: 184_000 });
	expect(gate.request({ auto: true })).toBe("gateway restarting");
	await advance(2000);
	expect(state.exits).toBe(1);
});

test("the owner's restart is never deferred, and it takes a deferred one with it", async () => {
	const { gate, state } = setup({ head: true, tokens: 184_000 });
	gate.request({ auto: true });
	await advance(10 * 60_000);
	expect(state.exits).toBe(0);
	gate.request();
	await advance(2000);
	expect(state.exits).toBe(1);
});

test("a prompt-head restart goes at once when the gateway's own code changed, and a deferred one goes once it does", async () => {
	const now = setup({ head: true, tokens: 184_000 });
	now.state.code = true;
	expect(now.gate.request({ auto: true })).toBe("gateway restarting");
	await advance(2000);
	expect(now.state.exits).toBe(1);
	const later = setup({ head: true, tokens: 184_000 });
	expect(later.gate.request({ auto: true })).toContain("deferred");
	await advance(10 * 60_000);
	expect(later.state.exits).toBe(0);
	later.state.code = true;
	await advance(65_000);
	expect(later.state.exits).toBe(1);
});

test("the gateway code watch sees a source written after it was armed, not one older", () => {
	const src = join(dir, "src");
	mkdirSync(join(src, "sub"), { recursive: true });
	writeFileSync(join(src, "sub", "a.ts"), "export {};\n");
	const changed = gatewayCodeChanged([src]);
	expect(changed()).toBe(false);
	writeFileSync(join(src, "sub", "b.md"), "note\n");
	expect(changed()).toBe(false);
	const later = new Date(Date.now() + 5000);
	writeFileSync(join(src, "sub", "a.ts"), "export const x = 1;\n");
	utimesSync(join(src, "sub", "a.ts"), later, later);
	expect(changed()).toBe(true);
});

test("prompt-head restarts come at most once a day, and a deferred one never waits past a day", async () => {
	const small = setup({ head: true, tokens: 30_000, lastHeadAgoMs: 2 * 3600_000 });
	small.gate.request({ auto: true });
	await advance(21 * 3600_000);
	expect(small.state.exits).toBe(0);
	await advance(2 * 3600_000);
	expect(small.state.exits).toBe(1);

	const big = setup({ head: true, tokens: 184_000 });
	big.gate.request({ auto: true });
	await advance(23 * 3600_000);
	expect(big.state.exits).toBe(0);
	await advance(2 * 3600_000);
	expect(big.state.exits).toBe(1);
});

test("the prompt head print changes with the system note, an extension source or the harness binary, not with an extension test", () => {
	const ext = join(dir, "extension");
	mkdirSync(join(ext, "fixtures"), { recursive: true });
	writeFileSync(join(ext, "index.ts"), "export const tool = 'reads mail';\n");
	writeFileSync(join(ext, "index.test.ts"), "test('x', () => {});\n");
	writeFileSync(join(ext, "fixtures", "case.ts"), "export const x = 1;\n");
	const omp = join(dir, "omp");
	writeFileSync(omp, "v1");
	const print = (note = "MODE") => promptHeadPrint({ systemNote: note, extensionDir: ext, harness: omp });
	const first = print();
	writeFileSync(join(ext, "index.test.ts"), "test('y', () => {});\n");
	writeFileSync(join(ext, "fixtures", "case.ts"), "export const x = 2;\n");
	expect(print()).toBe(first);
	expect(print("MODE edited")).not.toBe(first);
	writeFileSync(join(ext, "index.ts"), "export const tool = 'reads and sends mail';\n");
	const second = print();
	expect(second).not.toBe(first);
	writeFileSync(omp, "v2 of the harness");
	expect(print()).not.toBe(second);
});
