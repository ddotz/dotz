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

test("the sidebar folds to an icon rail and back: the toggle, the shortcut and a reload keep it, names stay readable, dots stay on the icons", async () => {
	const rail = () => ev<{ side: number; tog: string; pressed: string; label: string | null; text: number; saved: string | null; early: boolean }>(v, `(() => ({
		side: document.querySelector("#brand").parentElement.offsetWidth, tog: document.querySelector("#side-tog").title, pressed: document.querySelector("#side-tog").getAttribute("aria-expanded"),
		label: document.querySelector('.ni[data-view="projects"]').getAttribute("aria-label"), text: document.querySelector('.ni[data-view="projects"] .nl').offsetWidth,
		saved: localStorage.getItem("dotz-side"), early: document.documentElement.classList.contains("side-min") }))()`);
	await load([self, other], "PR.list.length === 2");
	expect((await rail()).side).toBe(232);
	await run(v, `document.querySelector("#side-tog").click()`);
	const min = await rail();
	expect(min).toMatchObject({ side: 60, pressed: "false", label: "프로젝트", text: 0, saved: "min" });
	expect(min.tog).toContain("펼치기");
	expect(min.tog).toContain("\\");
	await run(v, `ts(MAIN).unread = 3; paintAttn(); PR.list.find(p => p.name === "맥북").unread = 2; prPaint()`);
	const dots = await ev<{ w: number; right: number; bottom: number; logoDot: boolean; chev: boolean; overflow: boolean }>(v, `(() => {
		document.querySelector("#nav-att").getAnimations().forEach(a => a.finish());
		const d = document.querySelector("#nav-att").getBoundingClientRect(), i = document.querySelector('.ni[data-view="chat"] .ic').getBoundingClientRect(), c = document.querySelector("#brand-c");
		return { w: d.width, right: d.right - i.right, bottom: d.bottom - i.bottom, logoDot: getComputedStyle(c, "::after").content !== "none" && c.offsetWidth === 6, chev: !!c.querySelector(".ic").getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth };
	})()`);
	expect(dots).toEqual({ w: 6, right: 3, bottom: 2, logoDot: true, chev: false, overflow: false });
	await run(v, `ts(MAIN).unread = 0; paintAttn(); document.querySelector("#brand").click()`);
	await waitFor("PR.node");
	await run(v, `prClose(false)`);
	await v.navigate(`${hub.origin}/`);
	await waitFor(`typeof PR !== "undefined"`);
	expect((await rail()).early).toBe(true);
	expect((await rail()).side).toBe(60);
	await run(v, `document.dispatchEvent(new KeyboardEvent("keydown", { code: "Backslash", key: "₩", [isMac ? "metaKey" : "ctrlKey"]: true }))`);
	expect(await rail()).toMatchObject({ side: 232, pressed: "true", saved: null });
});

test("the fold button sits between the sidebar and the title on the title's line, the same in both states", async () => {
	const at = () => ev<{ inSide: boolean; off: number; mid: number; titleOff: number }>(v, `(() => {
		const b = document.querySelector("#side-tog"), r = b.getBoundingClientRect(), t = document.querySelector("#title").getBoundingClientRect(), m = document.querySelector(".main").getBoundingClientRect();
		return { inSide: !!b.closest(".side"), off: r.left - m.left, mid: r.top + r.height / 2 - (t.top + t.height / 2), titleOff: t.left - m.left };
	})()`);
	const wide = await at();
	expect(wide).toEqual({ inSide: false, off: -8, mid: 0, titleOff: 24 });
	await run(v, "sideToggle()");
	expect(await at()).toEqual(wide);
	await run(v, "sideToggle()");
});

test("the folded usage row is a ring with the expanded row's value and warning color, and a tap opens 사용량", async () => {
	const quota = (remaining: number) => `noteQuota({ providers: [{ provider: "anthropic", limits: [{ id: "7d", window: "7d", label: "7d", limit: 100, remaining: ${remaining} }] }] })`;
	const row = () => ev<{ shown: string; n: string; p: string; color: string; barColor: string; title: string; label: string | null; h: number }>(v, `(() => {
		const s = document.querySelector("#sf-usage"), r = s.querySelector(".sf-ring"), c = getComputedStyle(r);
		return { shown: c.display, n: r.textContent, p: r.style.getPropertyValue("--p"), color: c.color, barColor: getComputedStyle(s.querySelector(".sf-v")).color, title: s.title, label: s.getAttribute("aria-label"), h: r.getBoundingClientRect().height };
	})()`);
	await run(v, quota(24));
	const wide = await row();
	expect(wide.shown).toBe("none");
	await run(v, "sideToggle()");
	const warn = await row();
	expect(warn).toMatchObject({ shown: "grid", n: "24", p: "24", color: wide.barColor, title: "사용량 · 7일 24% 남음", label: "사용량 · 7일 24% 남음", h: 36 });
	await run(v, quota(80));
	const calm = await row();
	expect(calm.n).toBe("80");
	expect(calm.color).not.toBe(warn.color);
	await run(v, `document.querySelector("#sf-usage").click()`);
	await waitFor(`current === "usage"`);
	await run(v, `sideToggle(); go("home")`);
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
