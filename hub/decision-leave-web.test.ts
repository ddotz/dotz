import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// An answered decision card leaves the way docs/ui-spec.md says (움직임): it stays where it is while it fades and is removed only after motionOut ends,
// whether it is a question of its own notice or a mail draft whose answer is echoed back before the request is done. Headless browser, nothing leaves the process.
const AT = "2026-11-03T09:19:00.000Z";
const opt = (n: number, label: string) => ({ n, label, desc: "", rec: false });
const DRAFT_ASK = "[ask] 견적서 회신을 보낼까요?\n\n결정: 견적서 회신\n**1) 보내기**\n이 초안으로 답장해요\n**2) 보내지 않기**\n초안을 버려요";
const note = (id: string, options: object[], extra: object = {}) => ({ id, ts: AT, updated: AT, at: AT, kind: "decision", tone: "ask", title: "공지 형태", text: "배포 공지를 어떤 형태로 정리할까요?", open: "main", src: "main", read: false, decision: { options, to: "main", reply_to: AT, group: 1, state: "open", ...extra } });
let history: unknown[] = [];
let notices: ReturnType<typeof note>[] = [];
let echo = false;
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices" && req.method === "GET") return json({ unread: notices.length, items: notices });
		const an = /^\/api\/notices\/([^/]+)\/answer$/.exec(url.pathname);
		if (an && req.method === "POST") {
			const { n, label } = await req.json() as { n: number; label: string };
			const item = notices.find(x => x.id === an[1])!;
			if (echo) hub.push({ ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text: `${n}) ${label}`, picks: [{ q: item.title, n, label }] });
			item.decision = { ...item.decision, state: "answered", answer: `${n})` };
			return json({ item, unread: 0 });
		}
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);

// Taps the card's first option and samples every animation frame until the card has been gone for three frames in a row (at most 400 frames, so a card that never leaves ends the run):
// the card's opacity and its offset from the top of the page. Time is counted in frames, not milliseconds.
const TAP = `(async () => {
	const card = document.querySelector("#dcard"), lp = e => { let t = 0; for (let o = e; o; o = o.offsetParent) t += o.offsetTop; return t; };
	const top0 = lp(card), fr = [];
	let gone = 0;
	card.querySelector(".dc-row").click();
	await new Promise(res => { const tick = () => {
		const here = card.isConnected && !card.hidden && card.getClientRects().length > 0;
		fr.push({ here, op: here ? Number(getComputedStyle(card).opacity) : null, top: here ? lp(card) : null });
		gone = here ? 0 : gone + 1;
		if (gone >= 3 || fr.length >= 400) res(1); else requestAnimationFrame(tick);
	}; tick(); });
	return JSON.stringify({ fr, top0 });
})()`;

async function tapAndWatch(events: unknown[], items: typeof notices, rows: number) {
	history = events; notices = items;
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(`typeof openTarget === "function" && S && NT.loaded`);
	await view.evaluate(`(openTarget("main", "chat"), 0)`);
	await waitFor(`document.querySelectorAll("#dcard .dc-row").length === ${rows}`);
	await view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => 0)`);
	await view.evaluate(`new Promise(res => { const c = document.querySelector("#dcard"); let last = -1, n = 0; const tick = () => { const t = c.getBoundingClientRect().top; n = t === last ? n + 1 : 0; last = t; if (n >= 10) res(0); else requestAnimationFrame(tick); }; tick(); })`);
	const { fr, top0 } = JSON.parse((await view.evaluate(TAP)) as string) as { fr: { here: boolean; op: number | null; top: number | null }[]; top0: number };
	const there = fr.filter(f => f.here);
	expect(fr.some(f => !f.here)).toBe(true);
	expect(there.filter(f => f.op !== null && f.op < 1).length).toBeGreaterThanOrEqual(2);
	expect(Math.max(...there.map(f => Math.abs((f.top as number) - top0)))).toBeLessThanOrEqual(1);
}

describe("an answered decision card leaving", () => {
	test("the last question of a notice fades for at least two frames in place, then goes", async () => {
		echo = false;
		await tapAndWatch([], [note("d1", [opt(1, "짧은 공지"), opt(2, "목록 공지"), opt(3, "공지 없이 배포")])], 3);
	}, 30_000);

	test("a mail draft answered with the echo of the answer arriving first leaves the same way", async () => {
		echo = true;
		const draft = { toLabel: "받는이", to: "kim@example.com", mode: "reply", subject: "견적서 회신", body: "안녕하세요.", ref: "dr-1" };
		await tapAndWatch([{ ts: AT, kind: "out", source: "orchestrator", target: "web", text: DRAFT_ASK }], [note("d2", [opt(1, "보내기"), opt(2, "보내지 않기")], { draft })], 2);
	}, 30_000);
});
