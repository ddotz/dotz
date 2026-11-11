import { afterAll, describe, expect, test } from "bun:test";
import { decisionsOf } from "./notices-decisions.ts";
import { fakeHub, inbox, json, on } from "./test-web.ts";

// The question sheet shows the pictures the asking message attached (wherever its [file] lines stand) and, when one message asked several
// questions, every one of them in turn: which one is showing, the answer going only to its own question, what was typed kept while moving.
// Notices come from the hub's own parser (decisionsOf); the page is a headless browser, every request is recorded and nothing leaves the process.
const AT = "2026-11-10T09:19:00.000Z";
const BODY = "[ask] 시안을 골라 주세요\n\n앞 설명이에요\n\n결정: 색\n**1) 파랑**\n푸른 톤이에요\n**2) 안 됨**\n이유를 적어 주세요\n\n결정: 글자\n**1) 크게**\n읽기 편해요\n**2) 작게**\n많이 들어가요\n[file] /tmp/mock-a.png\n[file] /tmp/mock-b.png\n[file] /tmp/notes.pdf\n뒤 설명이에요";
const THREE = `${BODY}\n\n결정: 위치\n**1) 위**\n**2) 아래**`;
const decide = (text: string, to = "main"): Record<string, any>[] =>
	decisionsOf({ ts: AT, kind: "out", source: "orchestrator", target: to, text } as never).map((d, i) => ({
		id: `q${i + 1}`, ts: AT, updated: AT, at: AT, kind: "decision", tone: "ask", title: d.title, text: d.detail, open: to, src: to, read: false,
		decision: { options: d.options, to, reply_to: AT, group: d.group, state: "open" },
	}));
const PNG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#6c8"/></svg>`;
let notices: Record<string, any>[] = [];
const answered = inbox<{ id: string; n: number }>();
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices" && req.method === "GET") return json({ unread: notices.length, items: notices });
		if (url.pathname === "/api/file") return new Response(PNG, { headers: { "content-type": "image/svg+xml" } });
		const an = /^\/api\/notices\/([^/]+)\/answer$/.exec(url.pathname);
		if (an && req.method === "POST") {
			const { n } = await req.json() as { n: number };
			answered.push({ id: an[1]!, n });
			const item = notices.find(x => x.id === an[1])!;
			item.decision = { ...item.decision, state: "answered", answer: `${n})` };
			return json({ item, unread: 0 });
		}
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor, ev, run } = on(view);
const settled = () => view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
const load = async (list: Record<string, any>[]) => {
	notices = list;
	answered.length = 0;
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof noticeSheetOpen === "function" && S`);
	await waitFor(`typeof loadNotices === "function"`);
	await run(`loadNotices()`);
	await waitFor(`NT.items.length === ${list.length}`);
};
const openSheet = async (id: string) => {
	await run(`noticeSheetOpen(${JSON.stringify(id)})`);
	await waitFor(`NS.node && NS.id === ${JSON.stringify(id)} && document.querySelector("#ds-t")`);
	await settled();
};
const shown = () => ev<{ id: string; title: string; count: string | null; thumbs: number; chips: number; opts: number; next: number }>(`({ id: NS.id, title: document.querySelector("#ds-t").textContent, count: (document.querySelector('[data-k="count"]') || {}).textContent || null, thumbs: document.querySelectorAll(".fs-body .mfiles .thumb").length, chips: document.querySelectorAll(".fs-body .mfiles .fatt").length, opts: document.querySelectorAll(".fs-ft .ds-opt").length, next: document.querySelectorAll('.fs-ft [data-k="next"]').length })`);
const press = (sel: string) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);

describe("the hub keeps the message's files on every question", () => {
	test("each question's text holds all [file] lines, even those after the last block, and no option takes one as its description", () => {
		const ds = decisionsOf({ ts: AT, kind: "out", source: "orchestrator", target: "main", text: BODY } as never);
		expect(ds).toHaveLength(2);
		for (const d of ds) expect(d.detail.split("\n").filter(l => l.startsWith("[file] "))).toEqual(["[file] /tmp/mock-a.png", "[file] /tmp/mock-b.png", "[file] /tmp/notes.pdf"]);
		expect(ds.flatMap(d => d.options.map(o => o.desc)).some(s => s.startsWith("[file]"))).toBe(false);
	});
});

describe("the question sheet", () => {
	test("both questions of one message show the pictures as previews and a file chip, and a picture opens enlarged", async () => {
		await load(decide(BODY));
		for (const id of ["q1", "q2"]) {
			await openSheet(id);
			expect(await shown()).toMatchObject({ id, thumbs: 2, chips: 1, opts: 2 });
			if (id === "q1") {
				await press(".fs-body .mfiles .thumb");
				await waitFor(`document.querySelector("dialog.lbox[open]")`);
				await run(`document.querySelector("dialog.lbox").close()`);
				await waitFor(`!document.querySelector("dialog.lbox[open]")`);
			}
			await run(`ntSheetClose(false)`);
			await waitFor(`!NS.node`);
		}
	}, 30_000);

	test("with the pictures in, the option buttons end inside the sheet on a phone", async () => {
		await load(decide(BODY));
		await openSheet("q1");
		await waitFor(`[...document.querySelectorAll(".fs-body .thumb img")].every(i => i.complete)`);
		const r = await ev<{ last: number; sheet: number; view: number; first: number }>(`(() => { const b = [...document.querySelectorAll(".fs-ft button")], s = document.querySelector(".ds-sheet, .fs-card, dialog[open]").getBoundingClientRect(); return { last: b[b.length - 1].getBoundingClientRect().bottom, first: b[0].getBoundingClientRect().top, sheet: s.bottom, view: innerHeight }; })()`);
		expect(r.last).toBeLessThanOrEqual(r.sheet + 0.5);
		expect(r.last).toBeLessThanOrEqual(r.view);
		expect(r.first).toBeGreaterThan(0);
		// the pictures and the file card start where the sheet's text starts (they are not pushed to the right like the owner's own attachments in a chat)
		const x = await ev<{ title: number; thumbs: number[] }>(`({ title: document.querySelector("#ds-t").getBoundingClientRect().left, thumbs: [...document.querySelectorAll(".fs-body .mfiles")].map(m => (m.classList.contains("ans-card") ? m : m.firstElementChild).getBoundingClientRect().left) })`);
		expect(x.thumbs.length).toBeGreaterThan(0);
		for (const l of x.thumbs) expect(Math.abs(l - x.title)).toBeLessThanOrEqual(0.5);
	}, 30_000);

	test("a message with one question has no number and no way to another question", async () => {
		await load(decide("[ask] 하나만 골라요\n\n결정: 색\n**1) 파랑**\n**2) 초록**\n[file] /tmp/mock-a.png"));
		await openSheet("q1");
		expect(await shown()).toMatchObject({ count: null, next: 0, thumbs: 1 });
	}, 30_000);

	test("answering question 2 of 3 sends to question 2 only, then the sheet shows question 3 and the other two still wait", async () => {
		await load(decide(THREE));
		await openSheet("q1");
		expect(await shown()).toMatchObject({ id: "q1", count: " · 1/3", next: 1 });
		await press('.fs-ft [data-k="next"]');
		await waitFor(`NS.id === "q2"`);
		expect(await shown()).toMatchObject({ id: "q2", count: " · 2/3", thumbs: 2 });
		await press('.fs-ft [data-k="o1"]');
		await answered.until(a => a.length > 0, 10_000, "the answer to q2");
		expect([...answered]).toEqual([{ id: "q2", n: 1 }]);
		await waitFor(`NS.id === "q3"`);
		expect(await shown()).toMatchObject({ id: "q3", count: " · 3/3" });
		expect(await ev<string[]>(`NT.items.map(n => n.id + ":" + n.decision.state)`)).toEqual(["q1:open", "q2:answered", "q3:open"]);
		await press('.fs-ft [data-k="o2"]');
		await answered.until(a => a.length > 1, 10_000, "the answer to q3");
		expect(answered[1]).toEqual({ id: "q3", n: 2 });
		await waitFor(`NS.id === "q1"`);
		await press('.fs-ft [data-k="o1"]');
		await answered.until(a => a.length > 2, 10_000, "the answer to q1");
		expect(answered[2]).toEqual({ id: "q1", n: 1 });
		await waitFor(`!NS.node`);
		expect(await ev<number>(`document.querySelectorAll(".ds-sheet, .fs-card[open]").length`)).toBe(0);
	}, 30_000);

	test("moving to another question and back keeps the reason being written", async () => {
		await load(decide(THREE));
		await openSheet("q1");
		await press('.fs-ft [data-k="o2"]');
		await waitFor(`document.querySelector(".fs-ft .dc-note")`);
		await run(`(() => { const t = document.querySelector(".fs-ft .dc-note"); t.value = "색이 탁해요"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
		await run(`ntSheetGo("q2")`);
		await waitFor(`NS.id === "q2" && !document.querySelector(".fs-ft .dc-note")`);
		await run(`ntSheetGo("q1")`);
		await waitFor(`NS.id === "q1" && document.querySelector(".fs-ft .dc-note")`);
		expect(await ev<string>(`document.querySelector(".fs-ft .dc-note").value`)).toBe("색이 탁해요");
		expect(answered).toEqual([]);
	}, 30_000);
});
