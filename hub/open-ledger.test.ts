// The open-request ledger: the gateway keeps the owner's open requests in a file beside pending.json, so a compaction summary and a new
// session's first prompt can name them without the model carrying the owner's messages.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, LEDGER_MAX } from "./open-ledger.ts";
import { recallText } from "./orchestrator-parts.ts";
import { createPrompts, type PromptDeps } from "./prompts.ts";
import { clock } from "./runtime/test-clock.ts";
import { LEDGER_CAP, ledgerIn, loadLedger, openRequestsBlock, renderOpenRequests, type LedgerEntry } from "./recall-parts.ts";

const HOUR = 3_600_000;
const inbox = (id: string, words: string) => `[dotz inbox] web msg=${id} from owner\n${words}`;

function setup(extra: Partial<PromptDeps> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	const file = ledgerIn(dir);
	const ledger = createLedger(file, { isAnswered: id => q.isAnswered(id), write: (f, t) => writeFileSync(f, t), log: () => {}, now: () => clock.now });
	const state = { working: false, settling: [] as Promise<unknown>[] };
	const q: ReturnType<typeof createPrompts> = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => state.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: () => {
			const sent = (async () => ({ delivered: true }))();
			state.settling.push(sent);
			return sent;
		},
		clearProgress: () => {},
		persist: open => ledger.sync(open, q.openRequests()),
		interim: target => ledger.interim(target),
		log: () => {},
		answered: [],
		recent: () => [],
		...extra,
	});
	const startTurn = (text: string, reply: { target: string; replyTo?: string }) => {
		q.deliver(text, reply);
		state.working = true;
		q.onPrompt(text);
	};
	return { dir, file, clock, ledger, q, state, startTurn, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a request is in the ledger from delivery to its final answer, waits on its worker with an interim time, and survives a restart", async () => {
	const s = setup();
	s.startTurn(inbox("m1", "옮겨 줘"), { target: "web", replyTo: "m1" });
	expect(loadLedger(s.file).map(e => [e.id, e.state, e.text])).toEqual([["m1", "queued", "옮겨 줘"]]);

	s.q.workersSpawned([{ id: "st_move" }]);
	s.q.onAnswer("이동이 끝나면 등록할게요.\n\n[later]");
	s.state.working = false;
	s.q.settleTurn();
	const waiting = loadLedger(s.file);
	expect(waiting.map(e => [e.id, e.state, e.workers])).toEqual([["m1", "deferred", ["st_move"]]]);
	expect(waiting[0].interim).toBe(s.clock.now);

	// A restart: a new ledger over the same file holds the same request.
	const again = createLedger(s.file, { isAnswered: () => false, write: () => {}, log: () => {} });
	expect(again.entries()).toEqual(waiting);

	s.q.workersDone(["st_move"]);
	s.q.onAnswer("다 옮겼어요");
	await Promise.all(s.state.settling);
	expect(loadLedger(s.file)).toEqual([]);
	s.done();
});

test("a deferred request the queue dropped after 3 hours stays as lost until it is answered; a cancelled one within 3 hours is closed", () => {
	const s = setup();
	s.startTurn(inbox("old", "오래된 요청"), { target: "web", replyTo: "old" });
	s.q.workersSpawned([{ id: "st_x" }]);
	s.q.onAnswer("나중에\n\n[later]");
	s.state.working = false;
	s.q.settleTurn();
	s.startTurn(inbox("gone", "취소될 요청"), { target: "chat", replyTo: "gone" });
	s.q.workersSpawned([{ id: "st_y" }]);
	s.q.onAnswer("나중에\n\n[later]");
	s.state.working = false;
	s.q.settleTurn();
	expect(loadLedger(s.file).map(e => e.id).sort()).toEqual(["gone", "old"]);
	s.startTurn(inbox("poke", "하나 더"), { target: "chat", replyTo: "poke" });
	s.q.cancel();
	expect(loadLedger(s.file).map(e => e.id)).toEqual(["old"]);

	s.clock.now += 4 * HOUR;
	s.q.deliver(inbox("new", "새 요청"), { target: "web", replyTo: "new" });
	expect(loadLedger(s.file).map(e => [e.id, e.lost ?? false])).toEqual([["new", false], ["old", true]].reverse());
	s.q.markAnswered("old");
	s.q.deliver(inbox("next", "다음 요청"), { target: "web", replyTo: "next" });
	expect(loadLedger(s.file).map(e => e.id)).not.toContain("old");
	s.clock.now -= 4 * HOUR;
	s.done();
});

test("a gateway note before the inbox header is not stored, and the owner's words are cut", () => {
	const s = setup();
	s.q.deliver(`[gateway note] something\n${inbox("m9", `${"가".repeat(900)}`)}`, { target: "web", replyTo: "m9" });
	const [e] = loadLedger(s.file);
	expect(e.text.startsWith("가")).toBe(true);
	expect(e.text.length).toBeLessThanOrEqual(400);
	s.done();
});

test("past the ledger bound the oldest lose their words first and only then leave, each logged", () => {
	const logged: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	const ledger = createLedger(ledgerIn(dir), { isAnswered: () => false, write: () => {}, log: l => logged.push(l) });
	const open = Array.from({ length: LEDGER_MAX + 5 }, (_, i) => ({ text: `request ${i}`, at: 1000 + i, target: "web", replyTo: `r${i}`, deferred: true as const }));
	ledger.sync(open, []);
	const kept = ledger.entries();
	expect(kept.length).toBe(LEDGER_MAX);
	expect(kept[0].id).toBe("r5");
	expect(kept[0].text).toBe("");
	expect(kept.at(-1)?.text).toBe(`request ${LEDGER_MAX + 4}`);
	expect(logged.length).toBe(5);
	rmSync(dir, { recursive: true, force: true });
});

const entry = (i: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: `m${String(i).padStart(3, "0")}`, target: "web", at: 1_800_000_000_000 + i * 60_000, text: `request number ${i} ${"x".repeat(500)}`, state: "queued", ...over });

test("the block lists the newest first inside its character budget, cuts each message, and names the rest by id with the file", () => {
	const all = Array.from({ length: 80 }, (_, i) => entry(i));
	const block = renderOpenRequests(all, "/d/pending-ledger.json", "Asia/Seoul", all[79].at + 1000);
	expect(block.length).toBeLessThanOrEqual(LEDGER_CAP);
	const lines = block.split("\n");
	expect(lines[1]).toContain("m079");
	const shown = lines.filter(l => l.startsWith("- ")).map(l => l.split(" · ")[0].slice(2));
	expect(shown).toEqual([...shown].sort().reverse());
	const tail = lines.at(-1)!;
	expect(tail).toContain("/d/pending-ledger.json");
	const named = tail.match(/m\d{3}/g)!;
	expect([...shown, ...named].sort()).toEqual(all.map(e => e.id).sort());
	expect(lines[1]).toContain("…");
	expect(lines[1]).toContain("01-15 18:19");
});

test("an open request older than 14 days is named as stale by id, not dropped, and nothing open gives an empty block", () => {
	const old = entry(1, { at: 1_800_000_000_000 - 15 * 86_400_000, state: "deferred", workers: ["st_a"] });
	const fresh = entry(2, { at: 1_800_000_000_000 });
	const block = renderOpenRequests([old, fresh], "/d/l.json", "UTC", 1_800_000_060_000);
	expect(block).toContain("m002");
	expect(block.split("\n").at(-1)).toContain("m001");
	expect(block.split("\n").filter(l => l.startsWith("- ")).join()).not.toContain("m001");
	expect(renderOpenRequests([], "/d/l.json", "UTC")).toBe("");
	expect(openRequestsBlock("/no/such/file.json", "UTC")).toBe("");
});

test("a new session's first prompt carries the block", () => {
	expect(recallText("", "BLOCK-MARK-1")).toContain("BLOCK-MARK-1");
	expect(recallText("")).not.toContain("BLOCK-MARK-1");
});

test("the ledger file is read back as written", () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	const file = ledgerIn(dir);
	writeFileSync(file, JSON.stringify([entry(1)]));
	expect(loadLedger(file)).toEqual([entry(1)]);
	writeFileSync(file, "not json");
	expect(loadLedger(file)).toEqual([]);
	expect(readFileSync(file, "utf8")).toBe("not json");
	rmSync(dir, { recursive: true, force: true });
});
