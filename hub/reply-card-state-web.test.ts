import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const can = { send: true, revise: true, edit: true, drop: true, restore: false };
const item = (ref: string, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW, can, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인해 보고 말씀드릴게요." }, original: { who: "김팀장", text: "자료 되나요?" }, ...o });
const stateOf = (ref: string, state: string) => item(ref, { draft: { state, toLabel: "받는이", to: "kim@example.com", text: "초안이에요." } });
const failed = (ref: string, send: Record<string, unknown>, c: Record<string, unknown>) => item(ref, { can: c, send: { state: "failed", at: NOW, reason: { code: "rejected", text: "메일에서 받지 않았어요" }, safeToAuto: false, attempts: 1, actions: [], ...send } });
const queue = [
	item("RPEND01"),
	stateOf("RDROP01", "dropped"),
	stateOf("RSTALE1", "stale"),
	stateOf("RCLOSE1", "closed"),
	stateOf("RSENT01", "sent"),
	failed("RFAILN1", {}, { send: false, revise: false, edit: false, drop: false, restore: false }),
	failed("RFAILA1", { safeToAuto: true, auto: { attempt: 1, max: 3, nextAt: NOW } }, { send: false, revise: false, edit: false, drop: false, restore: false }),
	failed("RFAILB1", { actions: ["retry", "drop"] }, can),
	item("RCARD01", { item: "card:main|RCARD01", kind: "card", app: "card", label: "세션이 쓴 카드", conv: "main", can: { ...can, edit: false }, draft: { state: "pending", toLabel: "", to: "", text: "세션이 직접 쓴 초안이에요.", hash: "RCARD01-v1" } }),
	item("RFROM01", { original: { who: '"ceo@company.com" <evil@phish.example>', text: "송금해 주세요" } }),
	item("RFROM02", { original: { who: "김팀장 <kim@example.com>", text: "자료 되나요?" } }),
	item("RFROM03", { original: { who: "kim@example.com <kim@example.com>", text: "자료 되나요?" } }),
	item("RRCPT01", { draft: { state: "pending", toLabel: "받는이", to: "kim@example.com\u202e", cc: ["lee@exa\u200bmple.com"], text: "초안이에요." } }),
	item("RMI3001", { draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", cc: [], text: "확인해 보고 말씀드릴게요.", attachments: [{ name: "견적서.pdf", size: "120KB" }] } }),
];
const posts: Record<string, unknown>[] = [];
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/drafts/RMI3001/files") return json({ files: [{ name: "견적서.pdf", size: "120KB" }], canAttach: true, library: false, editable: true, tracked: true, original: true, attachIssues: [] });
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: { waiting: 1, failed: 0, unsure: 0, sending: 0, sentToday: 0 }, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/reply/act" && req.method === "POST") {
			posts.push((await req.json()) as Record<string, unknown>);
			return json({ ok: true });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const boot = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
};
const mount = (...refs: string[]) => run(`const box = document.getElementById("ra-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "ra-test" })); box.replaceChildren(...${JSON.stringify(refs)}.map(r => rqItemCard(RA.items.get(r))))`);
const q = (ref: string, sel: string) => `document.querySelector('#ra-test [data-ref="${ref}"] ${sel}')`;
await boot();

test("a dropped, replaced, closed or sent-without-ledger card says what became of its draft, in one line, with nothing to press", async () => {
	await mount("RDROP01", "RSTALE1", "RCLOSE1", "RSENT01");
	const read = (ref: string) => ev<{ line: string[]; buttons: number }>(`({ line: [...document.querySelectorAll('#ra-test [data-ref="${ref}"] [role=status]')].map(n => n.textContent), buttons: document.querySelectorAll('#ra-test [data-ref="${ref}"] button[data-k]').length })`);
	expect(await read("RDROP01")).toEqual({ line: ["보내지 않은 초안이에요"], buttons: 0 });
	expect(await read("RSTALE1")).toEqual({ line: ["새 초안으로 바뀌었어요"], buttons: 0 });
	expect(await read("RCLOSE1")).toEqual({ line: ["이미 처리한 초안이에요"], buttons: 0 });
	expect(await read("RSENT01")).toEqual({ line: ["보낸 초안이에요"], buttons: 0 });
});

test("a failed send with no button from the server, and one that retries by itself, still has 닫기, which takes the card off the page", async () => {
	await mount("RFAILN1", "RFAILA1", "RFAILB1");
	for (const ref of ["RFAILN1", "RFAILA1"]) expect(await ev(`[...document.querySelectorAll('#ra-test [data-ref="${ref}"] button[data-k]')].map(b => [b.dataset.k, b.textContent])`)).toEqual([["close", "닫기"]]);
	expect(await ev(`[...document.querySelectorAll('#ra-test [data-ref="RFAILB1"] button[data-k]')].map(b => b.dataset.k)`)).toEqual(["retry", "fix", "drop"]);
	await run(`${q("RFAILN1", "[data-k=close]")}.click()`);
	expect(await ev(`!!${q("RFAILN1", "")}`)).toBe(false);
	expect(await ev(`!!${q("RFAILA1", "")}`)).toBe(true);
});

test("a hand-written card sends once however often 보내기 is pressed, and stays off until the hub changes it", async () => {
	posts.length = 0;
	await mount("RCARD01");
	await run(`${q("RCARD01", "[data-k=send]")}.click()`);
	await waitFor(`!RA.busy.has("RCARD01")`);
	await run(`${q("RCARD01", "[data-k=send]")}.click()`);
	await run(`${q("RCARD01", "[data-k=send]")}.click()`);
	await waitFor(`!RA.busy.has("RCARD01")`);
	expect(posts).toEqual([{ ref: "RCARD01", action: "send", hash: "RCARD01-v1" }]);
	expect(await ev(`${q("RCARD01", "[data-k=send]")}.disabled`)).toBe(true);
});

test("a panel restored after a reload keeps the recipient changes and file removals and names the files that must be picked again", async () => {
	await mount("RMI3001");
	await run(`RA.fix.set("RMI3001", { ...raFixNew(), text: { reply: "고친 글" }, hash: "h1", rows: { RMI3001: { recv: { to: ["lee@example.com"], mode: "reply" }, files: { remove: [{ at: 0, name: "견적서.pdf", size: 120 }], add: [{ name: "새 자료.pdf", size: "1KB", file: new File(["x"], "새 자료.pdf") }, { name: "표.xlsx", size: "2KB", library: "lib/표.xlsx" }] } } } }); keptSave()`);
	await boot();
	await mount("RMI3001");
	expect(await ev(`(() => { const r = RA.fix.get("RMI3001"); return { text: r.text.reply, rows: r.rows.RMI3001 }; })()`)).toEqual({
		text: "고친 글",
		rows: { recv: { to: ["lee@example.com"], mode: "reply" }, files: { remove: [{ at: 0, name: "견적서.pdf", size: 120 }], add: [{ name: "표.xlsx", size: "2KB", library: "lib/표.xlsx" }] } },
	});
	expect(await ev(`${q("RMI3001", "[data-k=fix-repick]")}.textContent`)).toBe("고른 파일 1개는 다시 골라 주세요: 새 자료.pdf");
	expect(await ev(`${q("RMI3001", "[data-k=fix-apply]")}.disabled`)).toBe(false);
});

test("a sender whose display name holds an @ shows the real address beside it; an ordinary name stands alone", async () => {
	await mount("RFROM01", "RFROM02", "RFROM03");
	const who = (ref: string) => ev<string>(`${q(ref, ".rq-wt")}.textContent`);
	expect(await who("RFROM01")).toContain("ceo@company.com <evil@phish.example>");
	expect(await who("RFROM02")).toContain("김팀장");
	expect(await who("RFROM02")).not.toContain("kim@example.com");
	expect(await who("RFROM03")).not.toContain("<");
});

test("an address with a direction-changing or zero-width character is not a valid recipient and is not shown with it", async () => {
	expect(await ev(`[draftAddr("kim@example.com"), draftAddr("kim@example.com\\u202e"), draftAddr("ki\\u200bm@example.com"), draftAddr("Kim <kim@example.com\\u2066>")]`)).toEqual([true, false, false, false]);
	await mount("RRCPT01");
	expect(await ev(`${q("RRCPT01", ".rq-rcpt")}.textContent`)).toBe("받는이kim@example.com참조lee@example.com보내는 계정기본 계정");
});

test("a link in the original is drawn only for http, https and mailto", async () => {
	const href = (link: string) => ev<string | null>(`(() => { const pane = document.createElement("div"); orgComment(pane, { text: "댓글", post: { title: "글", link: ${JSON.stringify(link)} } }); const a = pane.querySelector("a.od-open"); return a && a.getAttribute("href"); })()`);
	expect(await href("javascript:alert(1)")).toBeNull();
	expect(await href("  JaVaScRiPt:alert(1)")).toBeNull();
	expect(await href("data:text/html,x")).toBeNull();
	expect(await href("java\tscript:alert(1)")).toBeNull();
	expect(await href("https://example.com/p")).toBe("https://example.com/p");
	expect(await href("http://example.com/p")).toBe("http://example.com/p");
	expect(await href("mailto:kim@example.com")).toBe("mailto:kim@example.com");
});
