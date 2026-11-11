import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The mail screens' visual pass (web/css/20-mailboxes.css, 20-mail-thread.css, web/js/30-mailboxes.js) in a headless browser against a fake hub:
// the same-thread list stays inside a phone, a list that failed to load says so with a retry, and a 456px list column keeps the subject readable.
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const BOXES = [
	{ id: "base", name: "일반", icon: "mail", notify: true, base: true },
	{ id: "b-doc", name: "문서 요청", icon: "mail", notify: true, mode: "ask" },
];
const MAILS = Array.from({ length: 6 }, (_, i) => ({ key: `v-${i + 1}`, subject: i === 5 ? "분기 정산 자료와 계약서 최종본, 그리고 다음 주 미팅 일정 확인을 한꺼번에 부탁드려요 (긴 제목)" : `다음 주 미팅 일정 확인 부탁드려요 ${i + 1}`, from: "Kim <kim@example.com>", box: i % 2 ? "base" : "b-doc", read: i % 3 === 0, at: ago(i + 1) }));
let failList = false;

const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", app: "mail", label: "개인 메일", icon: "mail", kind: "app", conv: ["mail:"], state: "connected", notices: [], unread: 4, needs: { drafts: 0, unread: 4, sentToday: 0, unreplied: 0 }, boxes: BOXES, account: "me@example.com" }], available: [] });
		if (p === "/api/conversations") {
			if (failList) return new Response("down", { status: 500 });
			return json({ items: MAILS.map(m => ({ target: `mail:${m.key}`, unread: m.read ? 0 : 1, read: null, mail: { subject: m.subject, from: m.from, source: "acme", at: m.at, summary: "요약이에요", read: m.read, archived: false, starred: false, can: CAN, box: m.box }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());
beforeEach(() => { failList = false; });

async function openList(width: number, height = 900): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `NT.loaded && INTG.items.length === 1 && CONV.has("mail:v-1")`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	if (width >= 640) {
		await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
		await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	} else {
		await waitFor(v, `current === "monitoring" && NM.loaded`);
		await run(v, `go("monitoring", "i:mail")`);
		await waitFor(v, `MON.sel === "i:mail" && document.querySelector("#mon-tl .mr-filter")`);
		await run(v, `document.querySelector('#mon-tl .mr-filter [data-filter="all"]').click()`);
	}
	await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === ${MAILS.length}`);
	return v;
}

describe("the mail screens", () => {
	test("on a phone the same-thread list opened from a mail stays inside the viewport", async () => {
		const v = await openList(390, 800);
		await run(v, `go("monitoring", "c:mail:v-1")`);
		await waitFor(v, `current === "chat" && monCtx === "mail:v-1"`);
		await run(v, `document.querySelector("#tl").append(el("div", { class: "bm mopen" }, mailMetaNode("mail:v-1", null)))`);
		await waitFor(v, `document.querySelector(".mth-mb")`);
		await run(v, `document.querySelector(".mth-mb").click()`);
		await waitFor(v, `(() => { const l = document.querySelector(".mth-m > .mth-list"); return l && !l.hidden && l.getClientRects().length > 0; })()`);
		const box = await ev<{ l: number; r: number; w: number }>(v, `(() => { const r = document.querySelector(".mth-m > .mth-list").getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: innerWidth }; })()`);
		expect(box.l).toBeGreaterThanOrEqual(0);
		expect(box.r).toBeLessThanOrEqual(box.w);
	}, 40_000);

	test("a list that failed to load says so and the retry brings the mail", async () => {
		failList = true;
		const v = await hub.view({ width: 1280, height: 900 });
		await v.navigate(`${hub.origin}/`);
		await waitFor(v, `NT.loaded && INTG.items.length === 1`);
		await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
		await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
		await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
		await waitFor(v, `CV.failed && document.querySelector("#mon-tl > .mx-fail")`);
		expect(await ev<string>(v, `document.querySelector("#mon-tl > .mx-fail").textContent`)).toContain("메일을 불러오지 못했어요");
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl > .mr").length`)).toBe(0);
		failList = false;
		await run(v, `document.querySelector('#mon-tl > .mx-fail [data-k="retry"]').click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === ${MAILS.length} && !document.querySelector("#mon-tl > .mx-fail")`);
	}, 40_000);

	test("at 1100 (a 456px list column) the row keeps a readable subject", async () => {
		const v = await openList(1100);
		const s = await ev<{ row: number; title: number; scroll: number }>(v, `(() => { const r = document.querySelector("#mon-tl > .mr"), t = r.querySelector(".rc-title"); return { row: Math.round(r.getBoundingClientRect().width), title: t.clientWidth, scroll: t.scrollWidth }; })()`);
		expect(s.row).toBeLessThanOrEqual(460);
		expect(s.title).toBeGreaterThanOrEqual(150);
	}, 40_000);

	test("the list heading does not repeat the chosen mailbox: 전체 has no title of its own", async () => {
		const v = await openList(1280);
		expect(await ev<number>(v, `document.querySelectorAll("#mon-tl > .mx-bh").length`)).toBe(0);
	}, 40_000);
});
