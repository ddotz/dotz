import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit, onBroadcast } from "./events.ts";
import { CARD_AUDIT_ID, type CardAudit, MIGRATIONS, MIGRATIONS_FILE, runMigrations } from "./migrations.ts";
import { draftCardCounts, listNotices, openDraftCards, refreshStoredDrafts, resetNoticesForTest, setDraftHandled, settleHandledDrafts } from "./notices.ts";

// The real cards, the real settle path and the real run-once record; only the facts of the apps and the chat turn are stand-ins.
const audit = MIGRATIONS.filter(m => m.id === CARD_AUDIT_ID);
const sent = new Set<string>();
let dir: string;
let turns: { closed: number; refreshed: number; open: number }[];
beforeEach(() => {
	resetNoticesForTest();
	sent.clear();
	setDraftHandled((_d, _n, ref) => sent.has(ref));
	dir = mkdtempSync(join(tmpdir(), "dz-card-audit-"));
	turns = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cards: CardAudit = {
	known: () => draftCardCounts().all,
	closeSent: () => settleHandledDrafts(),
	refresh: () => refreshStoredDrafts(),
	open: () => draftCardCounts().open,
	turn: c => void turns.push(c),
};
const start = () => runMigrations({ dataDir: dir, ask: () => undefined, notify: () => undefined, log: () => undefined, migrations: audit, cards });
const text = (ref: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "a@example.com", toLabel: "받는이", subject: "Re: 샘플", body: "샘플 답장입니다", ref, question: "이 답장 보낼까요?" })}`;
const post = (to: string, body: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: to, text: body });
const card = (ref: string) => listNotices(100).items.find(i => i.decision?.draft?.ref === ref)!;

test("a card the send records prove is closed as resolved, with no answer", async () => {
	post("mail:sample-1", text("d1"));
	sent.add("d1");
	await start();
	expect(card("d1").decision).toMatchObject({ state: "answered", resolved: true });
	expect(card("d1").decision!.answer).toBeUndefined();
	expect(turns).toEqual([{ closed: 1, refreshed: 0, open: 0 }]);
});

test("a stale card takes its draft's ref in the title, so 보내기 passes the gate, and stays open", async () => {
	// A card stored before the title followed its draft: the draft says d1, the title still the bot's ref.
	post("mail:sample-1", text("mail:1a1a.1"));
	card("mail:1a1a.1").decision!.draft!.ref = "d1";
	const title = () => openDraftCards().find(c => c.ref === "d1")!.title;
	expect(title()).toEndWith("(mail:1a1a.1)");
	await start();
	expect(title()).toEndWith("(d1)");
	expect(card("d1").decision!.state).toBe("open");
	expect(turns).toEqual([{ closed: 0, refreshed: 1, open: 1 }]);
});

test("a card no record proves stays open, and the audit sends, approves and discards nothing", async () => {
	post("mail:sample-1", text("d1"));
	post("mail:sample-2", text("d2"));
	sent.add("d2");
	const spawn = spyOn(Bun, "spawn");
	const seen: string[] = [];
	onBroadcast(e => void seen.push(String(e.kind)));
	await start();
	expect(spawn).not.toHaveBeenCalled();
	spawn.mockRestore();
	expect(seen.filter(k => /_send$|^out$|^approvals$/.test(k))).toEqual([]);
	const kept = card("d1").decision!;
	expect(kept.state).toBe("open");
	expect(kept.send).toBeUndefined();
	expect(kept.answer).toBeUndefined();
});

test("two starts run once: one chat turn, and the second start changes nothing", async () => {
	post("mail:sample-1", text("d1"));
	await start();
	sent.add("d1");
	await start();
	expect(turns).toHaveLength(1);
	expect(card("d1").decision!.state).toBe("open");
	expect(JSON.parse(readFileSync(join(dir, MIGRATIONS_FILE), "utf8")).done[CARD_AUDIT_ID]).toBeDefined();
});

test("a fresh install with no cards gets no turn and is done", async () => {
	expect(await start()).toEqual({ ran: [], failed: [] });
	post("mail:sample-1", text("d1"));
	await start();
	expect(turns).toEqual([]);
});

test("a gateway without an orchestrator leaves the audit for a later start", async () => {
	post("mail:sample-1", text("d1"));
	await runMigrations({ dataDir: dir, ask: () => undefined, notify: () => undefined, log: () => undefined, migrations: audit });
	expect(turns).toEqual([]);
	await start();
	expect(turns).toHaveLength(1);
});

test("a failed turn is retried at the next start, still as one turn", async () => {
	post("mail:sample-1", text("d1"));
	const notes: string[] = [];
	const broken = { ...cards, turn: () => { throw new Error("no turn"); } };
	const r = await runMigrations({ dataDir: dir, ask: () => undefined, notify: t => void notes.push(t), log: () => undefined, migrations: audit, cards: broken });
	expect(r.failed).toEqual([CARD_AUDIT_ID]);
	expect(notes).toHaveLength(1);
	await start();
	expect(turns).toHaveLength(1);
});
