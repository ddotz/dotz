// The one reply card (design 4.3, lane U1) in the real page against a fake hub: every send state draws its foot, one press is one POST, a
// revise's `next` swaps the card in place, a refused direct edit keeps the typed text, and the undo count changes in place.
import { afterAll, expect, test } from "bun:test";
import { advanceTimers, fakeHub, fixPageNow, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인해 보고 말씀드릴게요." }, original: { who: "김팀장", text: "자료 금요일까지 되나요?" }, ...o });
const posts: Record<string, unknown>[] = [];
let answer: (b: Record<string, unknown>) => Response = () => json({ ok: true });
let release: () => void = () => undefined;
// Resolves when the page's next POST /api/reply/act has reached the fake hub (and waits there until `release`).
let arrived: () => void = () => undefined;
const nextPost = () => new Promise<void>(r => (arrived = r));
const hub = fakeHub({
	stream: "fake",
	slowTimers: true,
	api: async (req, url) => {
		if (url.pathname === "/api/drafts/RFILES1/files") return json({ files: [{ name: "견적서.pdf", size: "120KB" }], canAttach: true, library: false, editable: true, tracked: true, original: true, attachIssues: [] });
		if (url.pathname === "/api/reply/queue") return json({ items: [item("RAAAAAA"), item("RBBBBBB")], counts: { waiting: 2, failed: 0, unsure: 0, sending: 0, sentToday: 0 }, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/reply/act" && req.method === "POST") {
			const b = (await req.json()) as Record<string, unknown>;
			posts.push(b);
			const held = new Promise<void>(r => (release = r));
			arrived();
			await held;
			return answer(b);
		}
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const ev = async <T>(expr: string): Promise<T> => JSON.parse((await view.evaluate(`JSON.stringify(${expr})`)) as string) as T;
const mount = (code: string) => view.evaluate(`(() => { const box = document.getElementById("ra-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "ra-test" })); box.replaceChildren(); ${code}; return 0; })()`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof rqItemCard === "function" && RA.loaded`);

test("the lead card's 보내기 is filled, the others tonal; one press makes one POST and a second press while it waits makes none", async () => {
	await mount(`box.append(rqItemCard(RA.items.get("RAAAAAA"), { lead: true }), rqItemCard(RA.items.get("RBBBBBB")))`);
	expect(await ev(`[...document.querySelectorAll("#ra-test [data-k=send]")].map(b => b.classList.contains("tonal"))`)).toEqual([false, true]);
	expect(await ev(`raCounts()`)).toEqual({ waiting: 2, failed: 0, unsure: 0, sending: 0 });
	answer = () => json({ ok: true, item: item("RAAAAAA", { send: { state: "undo", at: NOW, until: Date.now() + 9000, actions: [] } }) });
	const first = nextPost();
	await view.evaluate(`document.querySelector("#ra-test [data-ref=RAAAAAA] [data-k=send]").click(), 0`);
	await first;
	await waitFor(`document.querySelector("#ra-test [data-ref=RAAAAAA] [data-k=send]").disabled`);
	await view.evaluate(`document.querySelector("#ra-test [data-ref=RAAAAAA] [data-k=send]").click(), 0`);
	release();
	await waitFor(`!!document.querySelector("#ra-test [data-ref=RAAAAAA] .rq-send.undo")`);
	expect(posts.filter(p => p.ref === "RAAAAAA")).toEqual([{ ref: "RAAAAAA", action: "send" }]);
	expect(await ev(`document.querySelector("#ra-test [data-ref=RAAAAAA] .rq-send.undo").textContent`)).toMatch(/\d+초 후 보내요/);
});

test("the undo count changes in place, without drawing the card again", async () => {
	const before = await ev<string>(`document.querySelector("#ra-test [data-ref=RAAAAAA] [data-until]").textContent`);
	await view.evaluate(`window.__card = document.querySelector("#ra-test [data-ref=RAAAAAA]"), 0`);
	// The page's clock moves 3 s on, then its 1 s tick (a virtual slow timer) runs.
	await fixPageNow(view, Date.now() + 3000);
	await advanceTimers(view, 1000);
	await waitFor(`document.querySelector("#ra-test [data-ref=RAAAAAA] [data-until]").textContent !== ${JSON.stringify(before)}`);
	expect(await ev(`window.__card === document.querySelector("#ra-test [data-ref=RAAAAAA]")`)).toBe(true);
});

test("every send state draws its own foot with the server's buttons", async () => {
	const r = { code: "net_cut", text: "보내는 중에 연결이 끊겼어요" };
	await view.evaluate(`(() => {
		const st = ${JSON.stringify({
			sending: { state: "sending", at: NOW, attempt: 1, actions: [] },
			sent: { state: "sent", at: NOW, how: "owner", actions: [] },
			auto: { state: "failed", at: NOW, reason: { code: "offline", text: "인터넷에 연결되지 않았어요" }, safeToAuto: true, attempts: 1, auto: { attempt: 1, max: 3, nextAt: NOW }, actions: ["retry"] },
			failed: { state: "failed", at: NOW, reason: { code: "rejected", text: "메일에서 이 글을 받지 않았어요" }, safeToAuto: false, attempts: 1, actions: ["retry", "drop"] },
			unsure: { state: "unsure", at: NOW, reason: r, attempts: 1, actions: ["resolve_sent", "open_channel", "resolve_retry"] },
		})};
		const box = document.getElementById("ra-test"); box.replaceChildren();
		for (const [k, s] of Object.entries(st)) { RA.items.set("S" + k, { ...RA.items.get("RBBBBBB"), ref: "S" + k, item: "mail:S" + k, send: s }); box.append(rqItemCard(RA.items.get("S" + k))); }
	})(), 0`);
	const foot = (k: string) => ev<{ cls: string; text: string; keys: string[] }>(`(() => { const f = document.querySelector('[data-ref="S${k}"] .rq-send, [data-ref="S${k}"] .rq-sent'); return { cls: f.className, text: f.textContent, keys: [...f.querySelectorAll("[data-k]")].map(b => b.dataset.k) }; })()`);
	expect((await foot("sending")).cls).toContain("sending");
	expect((await foot("sent")).cls).toContain("rq-sent");
	expect((await foot("auto")).text).toContain("(1/3)");
	expect(await foot("failed")).toMatchObject({ cls: "rq-send failed", keys: ["retry", "edit", "drop"] });
	expect((await foot("failed")).text).toContain("보내지 못했어요 - 메일에서 이 글을 받지 않았어요");
	expect(await foot("unsure")).toMatchObject({ cls: "rq-send unsure", keys: ["resolve-sent", "open", "resolve-retry"] });
	expect((await foot("unsure")).text).toContain("자동으로 다시 보내지 않아요");
});

test("a revise's next swaps the card in place; a refused direct edit keeps the typed text and shows the causes", async () => {
	await mount(`box.append(rqItemCard(RA.items.get("RBBBBBB")))`);
	await view.evaluate(`raLive({ kind: "reply", ref: "RBBBBBB", next: "RCCCCCC", item: ${JSON.stringify(item("RCCCCCC", { draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "목요일까지 보내드릴게요.", replaces: { ref: "RBBBBBB", text: "확인해 보고 말씀드릴게요." } } }))} }), 0`);
	expect(await ev(`[...document.querySelectorAll("#ra-test .ra-card")].map(c => c.dataset.ref)`)).toEqual(["RCCCCCC"]);
	expect(await ev(`document.querySelector("#ra-test .ra-card").textContent.includes("목요일까지 보내드릴게요.")`)).toBe(true);

	answer = () => json({ ok: false, code: "forbidden_word", error: "쓰지 않기로 한 표현이 들어 있어요 ('무조건')", lint: ["쓰지 않기로 한 표현 '무조건'이(가) 있어요"] }, 422);
	await view.evaluate(`document.querySelector("#ra-test [data-k=manual]").click(), 0`);
	await waitFor(`!!document.querySelector("#ra-test [data-k=edit-text]")`);
	const edit = nextPost();
	await view.evaluate(`(() => { const a = document.querySelector("#ra-test [data-k=edit-text]"); a.value = "무조건 목요일!"; a.dispatchEvent(new Event("input")); document.querySelector("#ra-test [data-k=edit-send]").click(); })(), 0`);
	await edit;
	release();
	await waitFor(`!!document.querySelector("#ra-test .ra-lint")`);
	expect(await ev(`document.querySelector("#ra-test [data-k=edit-text]").value`)).toBe("무조건 목요일!");
	expect(await ev(`document.querySelector("#ra-test .ra-lint").textContent`)).toContain("무조건");
	expect(posts.at(-1)).toEqual({ ref: "RCCCCCC", action: "edit", text: "무조건 목요일!", send: true });
});

test("a mail card quotes its original with 원문 보기 and lists the files staged on the draft", async () => {
	await mount(`RA.items.set("RFILES1", { ...RA.items.get("RBBBBBB"), ref: "RFILES1", item: "mail:RFILES1", conv: "mail:RFILES1", original: { who: "김팀장 <kim@example.com>", text: "견적서 보내주세요" } }); box.append(rqItemCard(RA.items.get("RFILES1")))`);
	await waitFor(`!!document.querySelector("#ra-test [data-ref=RFILES1] .dr-files .dr-fn")`);
	expect(await ev(`document.querySelector("#ra-test [data-ref=RFILES1] .dr-files .dr-fn").textContent`)).toBe("견적서.pdf");
	expect(await ev(`document.querySelector("#ra-test [data-ref=RFILES1] .rq-ot").textContent`)).toBe("견적서 보내주세요");
	expect(await ev(`!!document.querySelector("#ra-test [data-ref=RFILES1] .rq-og")`)).toBe(true);
});
