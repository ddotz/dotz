import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, client, prepare, probe, records, start, stop, waitFor, type Gateway } from "./test/load-qa/harness.ts";
import { ACCOUNTS } from "./test/load-qa/names.ts";
import { SANDBOX_EXEC } from "./test/load-qa/sandbox.ts";

// The regression test of the load install: the real gateway in the macOS sandbox, one small seeded install, the owner's six rules.
const OUT = `/tmp/load-qa/test-${process.pid}`;
const [A, B] = ACCOUNTS.map(a => a.address) as [string, string];
const COMBINED = ["CD0000", "CD0001"]; // the seeded comment cards that carry a mail draft too (seed.ts: the first `compose` comment drafts)
type Json = Record<string, any>;
setDefaultTimeout(60_000);
let g: Gateway;
let api: ReturnType<typeof client>;
const used = new Set<string>();

const flag = (name: string, on: boolean): void => (on ? writeFileSync(join(OUT, name), "") : rmSync(join(OUT, name), { force: true }));
const groups = async (): Promise<Json[]> => (await api.get("/api/approvals")).groups;
const cards = async (): Promise<Json[]> => (await groups()).flatMap(x => x.cards);
const resultOf = async (ref: string): Promise<Json | undefined> => (await api.get("/api/approvals")).results.find((r: Json) => r.ref === ref);
const draftOf = (card: Json): Json => JSON.parse(readFileSync(join(OUT, "data/custom/reply-drafts/drafts.json"), "utf8")).drafts.find((d: Json) => d.id === card.ref);
const sends = (card: Json): number => records(g, "shim-calls.jsonl").filter(s => s.would_send && s.argv.includes(draftOf(card).mailId)).length;
const composeSends = (): number => records(g, "shim-calls.jsonl").filter(s => s.would_send && s.argv[1] === "send").length;
const posts = (): number => records(g, "net-calls.jsonl").filter(n => n.method === "POST" && /comments|replies/.test(n.url)).length;
const approve = (card: Json) => api.post("/api/approvals", { items: [{ ref: card.ref, to: card.to, n: 1 }] });
const settled = (card: Json, state: string) => waitFor(`${card.ref} ${state}`, async () => (await resultOf(card.ref))?.state === state);
/** An unused seeded mail card of one account (cards of the 20 mails the test adds are not in the fake mailbox). */
const fresh = (account: string): Json => {
	const card = seeded.find(c => c.kind === "mail" && !used.has(c.ref) && draftOf(c)?.account === account)!;
	used.add(card.ref);
	return card;
};
let seeded: Json[] = [];

describe.skipIf(!existsSync(SANDBOX_EXEC))("load-qa", () => {
	beforeAll(async () => {
		g = await prepare({ out: OUT, scale: "small" });
		await start(g);
		api = client(g);
		seeded = await cards();
	}, 90_000);
	afterAll(async () => {
		await stop(OUT);
		rmSync(OUT, { recursive: true, force: true });
	});

	test("1 no way out: the probe passes and every send is a recording", async () => {
		const p = await probe(g);
		expect(p.text).not.toContain("[FAIL]");
		expect(p.ok).toBe(true);
		const mail = fresh(A), comment = seeded.find(c => c.kind === "comment" && !COMBINED.includes(c.ref))!;
		await approve(mail);
		await approve(comment);
		await Promise.all([settled(mail, "sent"), settled(comment, "sent")]);
		expect(sends(mail)).toBe(1);
		expect(posts()).toBe(1);
		const writes = records(g, "shim-calls.jsonl").filter(s => s.tool === "zele" && ["send", "reply", "forward"].includes(s.argv[1]));
		expect(writes.every(s => s.would_send === true)).toBe(true);
	});

	test("2 every card is reachable and none is lost when new mail arrives", async () => {
		const open = async () => (await api.get("/api/notices?limit=300")).items.filter((n: Json) => n.decision?.state === "open").map((n: Json) => n.id).sort();
		const [beforeGroups, before] = [await groups(), await cards()];
		expect(before.every(c => c.sendable)).toBe(true);
		expect(await open()).toEqual(before.map(c => c.notice).sort());
		for (let i = 0; i < 20; i++) {
			const acct = ACCOUNTS[i % 2]!;
			const r = await api.post("/api/mail", { source: acct.source, id: `new-${i}`, subject: `new mail ${i}`, from: `Sender <new${i}@sender.example.test>`, to: acct.address, body: "Can we meet tomorrow?", at: new Date().toISOString(), messageId: `<new${i}@sender.example.test>`, needsReply: true, account: acct.address });
			expect(r.status).toBe(200);
		}
		const after = await waitFor("20 more cards", async () => ((await cards()).length >= before.length + 20 ? await cards() : false));
		// Groups move up with their newest card, so the order is compared inside each group.
		for (const bg of beforeGroups) {
			const ag = (await groups()).find(x => x.key === bg.key)!;
			expect(ag.cards.map((c: Json) => c.ref).filter((r: string) => bg.cards.some((c: Json) => c.ref === r))).toEqual(bg.cards.map((c: Json) => c.ref));
		}
		expect(await open()).toEqual(after.map(c => c.notice).sort());
	});

	test("3 a hanging send of one account stops nothing else", async () => {
		const [a, b] = [fresh(A), fresh(B)];
		flag(`hang-mail-${A}`, true);
		await approve(a);
		await waitFor("the hanging send to start", () => sends(a) === 1);
		await approve(b);
		// The only seeded card of the second account waits for a missing attachment, so it ends failed; either end proves the lane moved on.
		await waitFor("the other account's send to end", async () => ["sent", "failed"].includes((await resultOf(b.ref))?.state));
		expect((await api.post("/api/message", { text: "ping" })).status).toBe(200);
		expect((await resultOf(a.ref))?.state).toBe("sending");
		flag(`hang-mail-${A}`, false);
		await settled(a, "sent");
	});

	test("4 a failed send is visible and retries exactly once", async () => {
		const [x, sentinel] = [fresh(A), fresh(A)];
		flag("fail-mail", true);
		await approve(x);
		const failed = await waitFor("a failed result", async () => ((await resultOf(x.ref))?.state === "failed" ? await resultOf(x.ref) : false));
		expect(failed.text.length).toBeGreaterThan(0);
		expect(sends(x)).toBe(0);
		flag("fail-mail", false);
		const retry = () => api.post("/api/approvals/failed", { op: "retry", items: [{ ref: x.ref, to: x.to }] });
		expect((await retry()).body.results[0].ok).toBe(true);
		await settled(x, "sent");
		expect(sends(x)).toBe(1);
		expect((await retry()).body.results[0].ok).toBe(false);
		await approve(sentinel); // the lane is serial: a second send of x would have run before this one finishes
		await settled(sentinel, "sent");
		expect(sends(x)).toBe(1);
	});

	test("5 a restart does not send twice", async () => {
		const [first, second] = [fresh(A), fresh(A)];
		flag("hang-mail", true);
		await approve(first);
		await approve(second);
		await waitFor("the first send to start", () => sends(first) === 1);
		process.kill(g.pid, "SIGKILL");
		await waitFor("the gateway to die", () => !alive(g.pid));
		await start(g);
		flag("hang-mail", false);
		await settled(second, "sent");
		expect(sends(first)).toBe(1);
		expect(sends(second)).toBe(1);
	});

	test("6 a combined card posts the comment and sends the mail once each", async () => {
		const combined = (await cards()).find(c => c.ref === COMBINED[0])!;
		const [mails, comments] = [composeSends(), posts()];
		// Option 1 (보내기) is refused for the compose mail (it asks for a file and has none): the owner sends it as is with 이대로 보내기.
		const notice = (await api.get("/api/notices?limit=300")).items.find((n: Json) => n.id === combined.notice);
		const option = notice.decision.options.find((o: Json) => o.label === "이대로 보내기");
		expect((await api.post(`/api/notices/${combined.notice}/answer`, { n: option.n, label: option.label })).status).toBe(200);
		await waitFor("both sends", () => composeSends() > mails && posts() > comments);
		await settled(combined, "sent");
		expect(composeSends() - mails).toBe(1);
		expect(posts() - comments).toBe(1);
	});

	test("7 a comment POST cut by a restart ends 확인 필요, posts nothing by itself, and the owner closes it", async () => {
		const card = (await cards()).find(c => /^CD/.test(c.ref) && !COMBINED.includes(c.ref))!;
		const before = posts();
		flag("hang-comment", true);
		await approve(card);
		await waitFor("the POST to start", () => posts() === before + 1);
		process.kill(g.pid, "SIGKILL");
		await waitFor("the gateway to die", () => !alive(g.pid));
		await Bun.$`pkill -9 -f ${`comments.ts send ${card.ref}`}`.quiet();
		await start(g);
		flag("hang-comment", false);
		const row = await waitFor("the unsure row", async () => (await api.get("/api/replies")).failed.find((f: Json) => f.ref === card.ref && f.unsure) ?? false);
		expect((await resultOf(card.ref))?.state).toBe("unsure");
		expect((await api.post("/api/approvals", { items: [{ ref: card.ref, to: card.to, n: 1 }] })).status).toBeLessThan(500);
		expect(posts()).toBe(before + 1);
		expect((await api.post(`/api/comments/sends/${encodeURIComponent(row.sendId)}/done`, {})).status).toBe(200);
		expect((await api.get("/api/replies")).failed.some((f: Json) => f.ref === card.ref)).toBe(false);
		expect(posts()).toBe(before + 1);
	});
});
