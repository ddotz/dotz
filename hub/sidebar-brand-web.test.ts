import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on, run } from "./test-web.ts";

// The wide sidebar's top is one row: logo, bot name and, with a computer to switch to, one chevron that opens the computer list. A dot at the chevron's
// bottom right speaks for the other computers. Tabs show one dot after their text from the same values as the phone tab bar's badges.
let peers: object[] = [];
const hub = fakeHub({ api: (_req, url) => (url.pathname === "/api/peers" ? json(peers) : undefined) });
const v = await hub.view({ width: 1280, height: 800 });
const { waitFor } = on(v);
afterAll(() => hub.stop());
const self = { name: "맥미니", url: "http://a.test", self: true, online: true };
const other = { name: "맥북", url: "http://b.test", self: false, online: true };
const load = async (list: object[], ready: string) => {
	peers = list;
	await v.navigate(`${hub.origin}/`);
	await run(v, "localStorage.removeItem('dotz-peers'); prLoad()");
	await waitFor(ready);
};
const brand = () => ev<{ width: number; chev: boolean; rows: number; dot: boolean; nameRight: number; chevLeft: number }>(v, `(() => {
	const b = document.querySelector("#brand"), c = document.querySelector("#brand-c"), n = document.querySelector("#brand-name");
	return { width: b.scrollWidth, chev: !!c.offsetParent, rows: document.querySelectorAll("#gwpick").length, dot: getComputedStyle(c, "::after").content !== "none", nameRight: n.getBoundingClientRect().right, chevLeft: c.getBoundingClientRect().left };
})()`);

test("one computer: no chevron, and the name goes home", async () => {
	await load([self], "PR.list.length === 1");
	const b = await brand();
	expect(b.rows).toBe(0);
	expect(b.chev).toBe(false);
	await run(v, `go("settings"); document.querySelector("#brand").click()`);
	await waitFor(`current === "home" && !PR.node`);
});

test("several computers: the row opens the list under it with the current one marked, and a dot follows the other computer's unread", async () => {
	await load([self, other, { ...other, name: "서버", url: "http://c.test", online: false }], "PR.list.length === 3");
	const b = await brand();
	expect(b.chev).toBe(true);
	expect(b.dot).toBe(false);
	expect(b.chevLeft - b.nameRight).toBeLessThanOrEqual(6);
	await run(v, `document.querySelector("#brand").click()`);
	await waitFor("PR.node");
	const menu = await ev<{ anchored: boolean; current: string; rows: string[]; below: boolean }>(v, `(() => {
		const sheet = PR.node.firstElementChild;
		return { anchored: PR.node.classList.contains("anch"), current: PR.node.querySelector('.pr-row[aria-current="true"]').textContent, rows: [...PR.node.querySelectorAll(".pr-row:not(.pr-manage)")].map(r => r.textContent), below: parseFloat(sheet.style.top) >= document.querySelector("#brand").getBoundingClientRect().bottom };
	})()`);
	expect(menu.anchored).toBe(true);
	expect(menu.below).toBe(true);
	expect(menu.current).toContain("맥미니");
	expect(menu.rows.some(r => r.includes("서버") && r.includes("연결 안 됨"))).toBe(true);
	await run(v, `prClose(false); PR.list.find(p => p.name === "맥북").unread = 2; prPaint()`);
	expect((await brand()).dot).toBe(true);
	await run(v, `PR.list.find(p => p.name === "맥북").unread = 0; prPaint()`);
	expect((await brand()).dot).toBe(false);
});

test("a tab with something new shows one dot right after its text, and none reserves space once it clears", async () => {
	await run(v, `ts(MAIN).unread = 3; paintAttn()`);
	const g = await ev<{ text: string; w: number; gap: number; label: string | null }>(v, `(() => {
		const b = document.querySelector("#nav-att"), s = getComputedStyle(b);
		return { text: s.fontSize, w: b.offsetWidth, gap: b.offsetLeft - b.parentElement.querySelector(".nl").offsetLeft - b.parentElement.querySelector(".nl").offsetWidth, label: b.parentElement.getAttribute("aria-label") };
	})()`);
	expect(g.text).toBe("0px");
	expect(g.w).toBe(6);
	expect(g.gap).toBeGreaterThanOrEqual(0);
	expect(g.gap).toBeLessThanOrEqual(6);
	expect(g.label).toBe("채팅, 읽지 않은 대화 1개");
	await run(v, `ts(MAIN).unread = 0; paintAttn()`);
	expect(await ev(v, `document.querySelector("#nav-att").getBoundingClientRect().width`)).toBe(0);
});
