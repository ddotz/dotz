// The KakaoTalk room and the comment thread draw a draft the one reply queue holds as its card (design 4.4, lane U6): no head of its own, the queue's
// actions, and for a comment reply that carries a mail, 고치기 picks the part it changes.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, kind: string) => ({ item: `${kind}:${ref}`, ref, kind, app: kind, label: kind, conv: `${kind}:x`, at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "대화방", to: "동아리방", text: `초안 ${ref}` } });
const posts: Record<string, unknown>[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: [item("KROOM01", "kakao"), item("CDTHRD1", "comment")], counts: {}, triageMin: 3, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			posts.push((await req.json()) as Record<string, unknown>);
			posted();
			return json({ ok: true });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const mount = (code: string) => run(`const box = document.getElementById("rt-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "rt-test" })); box.replaceChildren(${code})`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof kkDraftCard === "function" && typeof cmDraftCard === "function" && RA.loaded`);

test("a KakaoTalk room draft is the queue card, bare, and 보내기 posts send", async () => {
	await mount(`kkDraftCard({ code: "KROOM01", text: "초안 KROOM01" })`);
	expect(await ev(`[!!document.querySelector("#rt-test .ra-card[data-ref=KROOM01]"), !!document.querySelector("#rt-test .rq-hd")]`)).toEqual([true, false]);
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#rt-test [data-k=send]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "KROOM01", action: "send" });
});

test("a comment reply with a mail picks the part of a 고치기 and posts it with the change", async () => {
	await mount(`cmDraftCard({ code: "CDTHRD1", text: "초안 CDTHRD1", mail: { to: "a@b.c", body: "메일" } })`);
	await run(`document.querySelector("#rt-test [data-k=edit]").click()`);
	await waitFor(`!!document.querySelector("#rt-test .rq-rv")`);
	await run(`const f = document.querySelector("#rt-test .rq-rv"); f.value = "더 짧게"; f.dispatchEvent(new Event("input"))`);
	const p = new Promise<void>(r => (posted = r));
	await run(`document.querySelector("#rt-test [data-k=revise-go]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "CDTHRD1", action: "revise", change: "더 짧게", part: "reply" });
});
