import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const REMEMBERED = { state: "remembered", text: '기억했어요: "인사는 짧게 쓴다" · 범위: 이 사람', scope: "recipient", scopes: ["recipient", "channel", "everywhere"] };
const ONCE = { state: "once", text: "이번만 반영했어요", scope: "channel", scopes: ["channel", "everywhere"] };
const item = (ref: string, draft: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인해 보고 말씀드릴게요.", hash: "h1", ...draft }, original: { who: "김팀장", text: "자료 금요일까지 되나요?" } });
const posts: Record<string, unknown>[] = [];
let answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({});
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [], counts: { waiting: 0, failed: 0, unsure: 0, sending: 0, sentToday: 0 }, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/reply/act" && req.method === "POST") {
			const body = (await req.json()) as Record<string, unknown>;
			posts.push(body);
			return json({ ok: true, ...answer(body) });
		}
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 800 });
await view.navigate(`${hub.origin}/`);
const { waitFor, ev, run } = on(view);
await waitFor(`typeof rqItemCard === "function" && RA.loaded`);
const mount = (it: object) => run(`RA.items.set(${JSON.stringify((it as { ref: string }).ref)}, ${JSON.stringify(it)}); const box = document.getElementById("ra-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "ra-test" })); box.replaceChildren(rqItemCard(RA.items.get(${JSON.stringify((it as { ref: string }).ref)})))`);
const line = (ref: string) => ev<{ text: string; state: string; buttons: [string, string][] } | null>(`(() => { const n = document.querySelector("#ra-test [data-ref=${ref}] [data-k=learned]"); return n && { text: n.querySelector(".rq-learn-tx").textContent, state: n.dataset.state, buttons: [...n.querySelectorAll("button")].map(b => [b.dataset.k, b.textContent]) }; })()`);

test("a remembered lesson is one quiet line on the card with 범위 바꾸기 and 이번만", async () => {
	await mount(item("RREM0001", { learned: REMEMBERED }));
	expect(await line("RREM0001")).toEqual({ text: REMEMBERED.text, state: "remembered", buttons: [["learn-scope", "범위 바꾸기"], ["learn-once", "이번만"]] });
});

test("a one-off lesson says so and offers 앞으로도 in place of 이번만", async () => {
	await mount(item("RONC0001", { learned: ONCE }));
	expect(await line("RONC0001")).toEqual({ text: ONCE.text, state: "once", buttons: [["learn-scope", "범위 바꾸기"], ["learn-keep", "앞으로도"]] });
});

test("sent and dropped cards carry the line too, and a card that learned nothing has none", async () => {
	await mount(item("RSNT0001", { state: "sent", learned: REMEMBERED }));
	expect((await line("RSNT0001"))?.state).toBe("remembered");
	await mount(item("RDRP0001", { state: "dropped", learned: ONCE }));
	expect((await line("RDRP0001"))?.state).toBe("once");
	await mount(item("RNON0001"));
	expect(await line("RNON0001")).toBeNull();
});

test("a lesson held for one scope has no 범위 바꾸기", async () => {
	await mount(item("RONE0001", { learned: { ...REMEMBERED, scope: "everywhere", scopes: ["everywhere"] } }));
	expect((await line("RONE0001"))?.buttons).toEqual([["learn-once", "이번만"]]);
});

test("one press posts one act: 범위 바꾸기 names the next scope after the current one and wraps, 이번만 and 앞으로도 name none, and the card repaints from the item the hub returns", async () => {
	const click = (ref: string, k: string) => run(`document.querySelector("#ra-test [data-ref=${ref}] [data-k=${k}]").click()`);
	answer = body => ({ item: item(String(body.ref), { learned: body.action === "learn-once" ? ONCE : { ...REMEMBERED, scope: body.scope ?? "recipient", text: '기억했어요: "인사는 짧게 쓴다" · 범위: 이 채널' } }) });
	await mount(item("RPRS0001", { learned: REMEMBERED }));
	posts.length = 0;
	await click("RPRS0001", "learn-scope");
	await waitFor(`(document.querySelector("#ra-test [data-ref=RPRS0001] .rq-learn-tx") || {}).textContent === ${JSON.stringify('기억했어요: "인사는 짧게 쓴다" · 범위: 이 채널')}`);
	await click("RPRS0001", "learn-once");
	await waitFor(`(document.querySelector("#ra-test [data-ref=RPRS0001] [data-k=learned]") || {}).dataset?.state === "once"`);
	answer = body => ({ item: item(String(body.ref), { learned: { ...REMEMBERED, scope: "everywhere", scopes: ["recipient", "channel", "everywhere"] } }) });
	await click("RPRS0001", "learn-keep");
	await waitFor(`(document.querySelector("#ra-test [data-ref=RPRS0001] [data-k=learned]") || {}).dataset?.state === "remembered"`);
	await click("RPRS0001", "learn-scope");
	await waitFor(`!RA.busy.has("RPRS0001")`);
	expect(posts.map(p => [p.action, p.scope])).toEqual([["learn-scope", "channel"], ["learn-once", undefined], ["learn-keep", undefined], ["learn-scope", "recipient"]]);
});
