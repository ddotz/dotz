import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The mail app's frame (web/js/30-mailboxes.js mxTwo, web/css/20-monitoring.css .app-two) in a headless browser against a fake hub: on a wide window the mailbox
// panel stays at the left edge when a mail opens and the mail takes the list's place beside it; on a phone the mail is its own screen.
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const BOXES = [
	{ id: "base", name: "일반", icon: "mail", notify: true, base: true },
	{ id: "b-doc", name: "문서 요청", icon: "mail", notify: true, mode: "ask" },
	{ id: "b-pay", name: "결제", icon: "mail", notify: true, mode: "ask" },
];
const MAILS = Array.from({ length: 12 }, (_, i) => ({ key: `p-${i + 1}`, subject: `문서 ${i + 1}번 부탁드려요`, from: `Kim <kim${i + 1}@example.com>`, box: i === 2 ? "b-pay" : i % 2 ? "base" : "b-doc", read: i % 3 === 0, at: ago(i + 1) }));
let hits: Record<string, number> = {};

const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		hits[p] = (hits[p] ?? 0) + 1;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", app: "mail", label: "개인 메일", icon: "mail", kind: "app", conv: ["mail:"], state: "connected", notices: [], unread: 4, needs: { drafts: 0, unread: 4, sentToday: 0, unreplied: 0 }, boxes: BOXES, account: "me@example.com" }], available: [] });
		if (p === "/api/conversations") return json({ items: MAILS.map(m => ({ target: `mail:${m.key}`, unread: m.read ? 0 : 1, read: null, mail: { subject: m.subject, from: m.from, source: "acme", at: m.at, summary: "요약이에요", read: m.read, archived: false, starred: false, can: CAN, box: m.box }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		return undefined;
	},
});
afterAll(() => hub.stop());
beforeEach(() => { hits = {}; });

const visible = (v: View, sel: string) => ev<boolean>(v, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
const left = (v: View, sel: string) => ev<number>(v, `Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().left)`);
const ready = (v: View) => waitFor(v, `NT.loaded && INTG.items.length === 1 && CONV.has("mail:p-1")`);
async function openList(width: number, height = 900): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await ready(v);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === ${MAILS.length}`);
	return v;
}
const openMail = async (v: View, key = "p-1") => {
	await run(v, `go("monitoring", "c:mail:${key}")`);
	await waitFor(v, `current === "chat" && monCtx === "mail:${key}"`);
};

describe("a wide window", () => {
	test("opening a mail keeps the mailbox panel where it was and puts the mail in the main area", async () => {
		const v = await openList(1280);
		const panel = await left(v, "#mx-pane");
		expect(panel).toBeLessThan(300);
		await openMail(v);
		await waitFor(v, `document.querySelector("#v-chat.app-two > #chat-convo.app-side .mx-pr")`);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#chat-convo .mx-pr .hd")].map(e => e.firstChild.textContent)`)).toEqual(["전체", "문서 요청", "결제", "일반"]);
		expect(await left(v, "#chat-convo")).toBe(panel);
		expect(await visible(v, "#chat-convo")).toBe(true);
		expect(await visible(v, "#v-chat .composer")).toBe(true);
		expect(await ev<boolean>(v, `document.querySelector("#v-chat .chatbox").getBoundingClientRect().left >= document.querySelector("#chat-convo").getBoundingClientRect().right`)).toBe(true);
		expect(await ev<number>(v, `document.querySelectorAll("#chat-convo .mx-pr.on").length`)).toBe(1);
	}, 40_000);

	test("going back shows the same list nodes at the same place, and nothing is fetched again", async () => {
		const v = await openList(1280, 420);
		await run(v, `window.__row = document.querySelector('#mon-tl > .mr[data-t="mail:p-6"]'); document.querySelector("#mon-timeline").scrollTop = 120`);
		await waitFor(v, `MON.tlTop > 0 && MON.tlTop === document.querySelector("#mon-timeline").scrollTop`);
		const top = await ev<number>(v, `MON.tlTop`);
		const before = { ...hits };
		await openMail(v, "p-6");
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `current === "monitoring" && !MON.list`);
		await waitFor(v, `document.querySelector("#mon-timeline").scrollTop === ${top}`);
		expect(await ev<boolean>(v, `document.querySelector('#mon-tl > .mr[data-t="mail:p-6"]') === window.__row`)).toBe(true);
		expect(await ev<string>(v, `decodeURIComponent(location.hash)`)).toBe("#monitoring/i:mail");
		expect(hits["/api/conversations"]).toBe(before["/api/conversations"]);
	}, 40_000);

	test("a box picked in the panel beside the open mail is that box's list", async () => {
		const v = await openList(1280);
		await openMail(v);
		await waitFor(v, `document.querySelector("#chat-convo .mx-pr")`);
		await run(v, `[...document.querySelectorAll("#chat-convo .mx-pr")].find(r => r.querySelector(".hd").firstChild.textContent === "결제").click()`);
		await waitFor(v, `current === "monitoring" && MX.box === "b-pay" && document.querySelectorAll("#mon-tl > .mr").length === 1`);
		expect(await ev<string>(v, `decodeURIComponent(location.hash)`)).toBe("#monitoring/i:mail/all/b-pay");
		expect(await ev<number>(v, `document.querySelectorAll("#mx-pane .mx-pr.on").length`)).toBe(1);
	}, 40_000);

	test("an address of an open mail lands in the frame, with the panel and the mail", async () => {
		const v = await hub.view({ width: 1280, height: 900 });
		await v.navigate(`${hub.origin}/#monitoring/c:mail%3Ap-1`);
		await ready(v);
		await waitFor(v, `document.querySelector("#v-chat.app-two > #chat-convo .mx-pr")`);
		expect(await ev<string>(v, `target`)).toBe("mail:p-1");
		expect(await ev<string>(v, `decodeURIComponent(location.hash)`)).toBe("#monitoring/c:mail:p-1");
		expect(await ev<string>(v, `document.querySelector("#chat-convo .mx-pr.on .hd").firstChild.textContent`)).toBe("전체");
		expect(await visible(v, "#v-chat .composer")).toBe(true);
	}, 40_000);
});

describe("a phone", () => {
	test("the mail opens as its own screen and back returns to the list", async () => {
		const v = await openList(390);
		await openMail(v);
		expect(await ev<boolean>(v, `document.querySelector("#v-chat").classList.contains("app-two")`)).toBe(false);
		expect(await visible(v, "#chat-convo")).toBe(false);
		expect(await visible(v, "#v-chat .composer")).toBe(true);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `current === "monitoring" && document.querySelectorAll("#mon-tl > .mr").length === ${MAILS.length}`);
		expect(await visible(v, "#mx-pane")).toBe(false);
	}, 40_000);
});
