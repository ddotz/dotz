import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, idleState, json, on, type View, waitFor } from "./test-web.ts";

// A lane's question on the 알림 screen and its card (web/js/31-notices-screen.js, 30-notices.js) at phone and desktop widths: one row, the card says which
// work it is about, the question and each answer's result, and agent prose flows instead of breaking before every phrase box (owner 2026-11-05).
// ASK_OLD draws the two items the hub used to make for one question. Screenshots go to ASK_SHOTS when it names a folder.
const SHOTS = process.env.ASK_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OLD = !!process.env.ASK_OLD;
const AT = "2026-11-04T15:31:34.621Z";
const PROSE = "앞서 올린 두 결정(자기 주소가 있는 컴퓨터를 여는 방식, 설치한 앱에서 공개 주소를 여는 방식)에 답해 주시면 구현을 시작할게요. 계획에도 답 대기로 표시했어요. 워커 두 개의 패치는 둘 다 0바이트라 적용할 게 없고, 레인에 미커밋 변경도 없어요.";
const row = { ts: AT, at: AT, updated: AT, read: false, tone: "ask", open: "lane:web", src: "lane:web", by: "lane:web" };
const cardItem = () => OLD
	? { ...row, id: "card", cls: "ask", kind: "decision", title: "형의 답을 기다리는 중이에요", text: `형의 답을 기다리는 중이에요. ${PROSE}`, decision: { options: [], to: "lane:web", reply_to: AT, group: 1, state: "open" } }
	: { ...row, id: "card", cls: "ask", kind: "decision", title: "자기 주소가 있는 컴퓨터를 고르면 어떻게 열까요?", text: `${PROSE}\n\n결정: 자기 주소가 있는 컴퓨터를 고르면 어떻게 열까요?\n**1) 그 주소의 웹앱으로 이동**\n화면과 기능이 그대로예요.\n**2) 평소 채팅 화면에서 중계**\n앱 안에 머물러요.`,
		decision: { options: [{ n: 1, label: "그 주소의 웹앱으로 이동", desc: "화면과 기능이 그대로예요. 그 주소에서 기기 연결은 한 번 해야 해요." }, { n: 2, label: "평소 채팅 화면에서 중계", desc: "앱 안에 머물지만 화면 일부는 못 써요." }], to: "lane:web", reply_to: AT, group: 1, state: "open" } };
const twin = { ...row, id: "twin", cls: "ask", kind: "result", title: "외부 접속 웹앱 전환", text: `형의 답을 기다리는 중이에요. ${PROSE}`, key: "lane:web" };
let notices: Record<string, unknown>[] = [];
const hub = fakeHub({
	state: () => idleState({ notices_unread: notices.filter(n => !n.read).length, lanes: [{ name: "web", title: "외부 접속 웹앱 전환", status: "idle", live: true, alive: true, home: "ch:7" }], channels: { work: { 7: "dotz 웹앱" } } }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices" && req.method === "GET") return json({ items: notices, unread: notices.filter(n => !n.read).length, gone: [] });
		if (p === "/api/notices/card/answer") {
			const n = notices[0] as { read: boolean; decision: Record<string, unknown> };
			n.read = true; n.decision.state = "answered"; n.decision.answer = "1) 그 주소의 웹앱으로 이동";
			return json({ ok: true, item: n, unread: 0 });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
// The rendered lines of the body's first paragraph, and how many its text needs at this width with no box in the way.
const LINES = `(() => {
	const p = document.querySelector(".fs-body .md p"), r = document.createRange();
	r.selectNodeContents(p);
	const tops = new Set([...r.getClientRects()].filter(c => c.width > 1).map(c => Math.round(c.bottom / 8)));
	const s = document.createElement("span");
	s.textContent = p.textContent; s.style.cssText = "white-space:nowrap;position:absolute;visibility:hidden";
	p.append(s);
	const need = Math.ceil(s.getBoundingClientRect().width / p.clientWidth);
	s.remove();
	return { lines: tops.size, need, boxes: p.querySelectorAll(".wph").length };
})()`;

describe.each([[412], [1280]])("a lane question at %ipx", width => {
	test("one row, a card that answers itself, prose that flows, and answering clears the row", async () => {
		notices = OLD ? [cardItem(), twin] : [cardItem()];
		const v = await hub.view({ width, height: 844 });
		const q = on(v);
		await v.navigate(`${hub.origin}/#notices`);
		await q.waitFor(`typeof NT !== "undefined" && NT.loaded && document.querySelector('#v-notices .list[data-g="need"] .nsc-r')`);
		await shot(v, `list-${width}.png`);
		await q.run(`document.querySelector('#v-notices .list[data-g="need"] .nsc-r .nsc-tx').click()`);
		await q.waitFor(`document.querySelector(".fs-body .md p")`);
		await shot(v, `card-${width}.png`);
		const rows = await ev<string[]>(v, `[...document.querySelectorAll('#v-notices .list[data-g="need"] .nsc-r .hd')].map(x => x.textContent)`);
		expect(rows).toEqual(["자기 주소가 있는 컴퓨터를 고르면 어떻게 열까요?"]);
		expect(await ev<string>(v, `document.querySelector('#v-notices .nsc-s').textContent`)).toContain("dotz 웹앱 · 외부 접속 웹앱 전환");
		expect(await ev<string>(v, `document.querySelector(".fs-ey").textContent`)).toBe("dotz 웹앱 · 외부 접속 웹앱 전환 · 답변 필요");
		expect(await ev<string>(v, `document.querySelector("#ds-t").textContent`)).toContain("어떻게 열까요");
		expect(await ev<string[]>(v, `[...document.querySelectorAll(".ds-opt .ds-lb")].map(x => x.textContent)`)).toEqual(["그 주소의 웹앱으로 이동", "평소 채팅 화면에서 중계"]);
		expect(await ev<number>(v, `document.querySelectorAll(".ds-opt .ds-ds").length`)).toBe(2);
		const wrap = await ev<{ lines: number; need: number; boxes: number }>(v, LINES);
		expect(wrap.boxes).toBe(0);
		expect(wrap.lines).toBeLessThanOrEqual(wrap.need + 1);
		await q.run(`document.querySelector('.ds-opt[data-k="o1"]').click()`);
		await q.waitFor(`NT.items[0].decision.state === "answered"`);
		await q.waitFor(`!document.querySelector('#v-notices .list[data-g="need"]')`);
	});
});
