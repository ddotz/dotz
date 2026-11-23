import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.PROJECT_PANEL_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const ts = (i: number) => new Date(Date.UTC(2026, 10, 20, 1, i)).toISOString();
const talk = (t: string) => Array.from({ length: 60 }, (_, i) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: t, text: `${i}번 메시지예요. 대화가 길어서 한 줄을 넘기도록 조금 길게 씁니다.` }));
const PROJECTS = [
	{ key: "ch:7001", name: "유튜브", pinned: false, lanes: [], newest: 0, channel: { id: "7001", name: "유튜브" }, recordKey: "ch:7001" },
	{ key: "ch:7002", name: "블로그", pinned: false, lanes: [], newest: 0, channel: { id: "7002", name: "블로그" }, recordKey: "ch:7002" },
	{ key: "dir:/tmp/site", name: "사이트", pinned: false, lanes: [], newest: 0, recordKey: "dir:/tmp/site" },
];
let rev = 0;
const detail = (key: string) => ({
	key, monitors: [], lanes: [], work: [], routines: [], schedules: [], watches: [],
	record: { title: (PROJECTS.find(p => p.key === key) || PROJECTS[0]!).name },
	info: { summary: `요약 ${rev}`, blocked: Array.from({ length: 14 }, (_, i) => `막힌 일 ${i + 1}: 확인할 내용을 길게 적어 두었어요`), next: ["다음 일"], decided: [] },
	results: Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, kind: "report", title: `결과 ${i + 1}`, at: ts(i), lane: "yt" })),
});
let work = { "7001": { name: "유튜브" }, "7002": { name: "블로그" } } as Record<string, { name: string }>;
const deletes: string[] = [];
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work }, discord: {}, notices_unread: 0 });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: PROJECTS.filter(x => !x.key.startsWith("ch:") || work[x.key.slice(3)]), routines: [], links: [] });
		if (p === "/api/custom/project") return json(detail(url.searchParams.get("key") || ""));
		if (p === "/api/projects/ch%3A7001/delete-plan") return json({ key: "ch:7001", channel: "ch:7001", name: "유튜브", monitors: [], logins: [], standing: "", notices: 0, messages: 60, running: [], archive: "" });
		if (p === "/api/projects/ch%3A7001" && req.method === "DELETE") {
			deletes.push(p);
			work = { "7002": { name: "블로그" } };
			return json({ ok: true, channel: "ch:7001", name: "유튜브", removed: {}, discord: { ok: true } });
		}
		if (p === "/api/history") { const t = url.searchParams.get("target") || ""; return json({ target: t, events: t.startsWith("ch:") ? talk(t) : [] }); }
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => { hub.stop(); });
afterEach(() => { hub.release(); });

const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const PANEL = `((n) => !!n && !n.hidden && n.getClientRects().length > 0 && !!n.querySelector(".pm-o"))(document.querySelector("#pv-panel"))`;
const CLOSED = `!${PANEL}`;
const READ = `((tl) => { const a = tl.getBoundingClientRect().top, n = [...document.querySelectorAll("#tl [data-ts]")].find(m => m.getBoundingClientRect().bottom > a + 1); return n ? n.dataset.ts + "@" + Math.round(n.getBoundingClientRect().top - a) : ""; })($("#timeline"))`;
const TOG = `!!document.querySelector(".cv-head .pv-tog")`;
const settle = (v: View) => v.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);
const LIT = `[...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view)`;
const touch = (v: View) => v.evaluate(`(window.dispatchEvent(new Event("pointerup")), true)`);
const back = (v: View) => v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no popstate")), 8000); addEventListener("popstate", () => { clearTimeout(t); res(true); }, { once: true }); history.back(); })`);

async function boot(width: number, hash = "", height = 844): Promise<View> {
	work = { "7001": { name: "유튜브" }, "7002": { name: "블로그" } };
	const v = await hub.view({ width, height }, `/${hash}`);
	await waitFor(v, `typeof S !== "undefined" && S && typeof PRJ !== "undefined"`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `prjLoad()`);
	await waitFor(v, `PRJ && CV.loaded`);
	return v;
}
async function openChat(v: View, t: string) {
	await run(v, `go("chat", ${JSON.stringify(t)})`);
	await waitFor(v, `current === "chat" && target === ${JSON.stringify(t)} && ts(${JSON.stringify(t)}).hLoaded && document.querySelectorAll("#tl [data-ts]").length > 20`);
	await settle(v);
}

test("S2/REQ2: #project/<key> of a project with a chat is that chat with its panel open; #chat/<target> is the chat alone; a project without a chat or a deleted one keeps the project screen", async () => {
	const v = await boot(1280);
	await run(v, `go("project", "ch:7001")`);
	await waitFor(v, `PM.key === "ch:7001" && PM.D`);
	await settle(v);
	expect(await ev(v, `[current, target, location.hash, ${PANEL}, document.querySelector("#v-project").hidden]`)).toEqual(["chat", "ch:7001", "#project/ch%3A7001", true, true]);
	expect(await ev(v, LIT)).toEqual(["chat"]);
	await run(v, `location.hash = "#chat/ch:7001"`);
	await waitFor(v, `current === "chat" && H.hash === "chat/ch:7001"`);
	await settle(v);
	expect(await ev(v, `[current, target, location.hash, ${PANEL}]`)).toEqual(["chat", "ch:7001", "#chat/ch:7001", false]);
	await run(v, `location.hash = "#project/ch%3A7001"`);
	await waitFor(v, `H.hash === "project/ch%3A7001"`);
	await settle(v);
	expect(await ev(v, `[current, target, location.hash, ${PANEL}]`)).toEqual(["chat", "ch:7001", "#project/ch%3A7001", true]);
	for (const [key, hash] of [["dir:/tmp/site", "#project/dir%3A%2Ftmp%2Fsite"], ["ch:9999", "#project/ch%3A9999"]] as const) {
		await run(v, `go("project", ${JSON.stringify(key)})`);
		await waitFor(v, `PM.key === ${JSON.stringify(key)} && PM.D`);
		await settle(v);
		expect(await ev(v, `[current, location.hash, ${PANEL}, !document.querySelector("#v-project").hidden && !!document.querySelector("#v-project .pmv-head")]`)).toEqual(["project", hash, false, true]);
		expect(await ev(v, LIT)).toEqual(["chat"]);
	}
});

for (const w of [390, 1280]) {
	test(`REQ2: ${w}px reload on #project/<key> opens the chat with its panel, and the 채팅 tab is lit`, async () => {
		const v = await boot(w, "#project/ch%3A7001");
		await waitFor(v, `PM.key === "ch:7001" && PM.D`);
		await settle(v);
		expect(await ev(v, `[current, target, location.hash, ${PANEL}]`)).toEqual(["chat", "ch:7001", "#project/ch%3A7001", true]);
		expect(await ev(v, `document.querySelector("#pv-panel .pmv-title").textContent`)).toBe("유튜브");
		expect(await ev(v, `[...document.querySelectorAll("#nav .ni")].filter(b => b.getClientRects().length && b.classList.contains("on")).map(b => b.dataset.view)`)).toEqual(["chat"]);
	});
}

test("S7/REQ1: the panel's head keeps the editable name and purpose without a second chat button or ⋯, and its section pages open over it and close back to it", async () => {
	const v = await boot(1280);
	await run(v, `go("project", "ch:7001")`);
	await waitFor(v, `PM.key === "ch:7001" && PM.D`);
	await settle(v);
	expect(await ev(v, `[${PANEL}, !!document.querySelector("#pv-panel .pmv-head .pmv-title"), !!document.querySelector("#pv-panel .pmv-head .pmv-purpose"), document.querySelectorAll("#pv-panel .pmv-hact, #pv-panel .pmv-more").length, document.querySelectorAll('.cv-head button[aria-label="프로젝트 메뉴"]').length]`)).toEqual([true, true, true, 0, 1]);
	for (const [k, title] of [["info", "지금 상황"], ["results", "결과 전체"]] as const) {
		await run(v, `document.querySelector('#pv-panel .pm-sec [data-k="${k}"]').click()`);
		await waitFor(v, `!!document.querySelector(".pdv .pdv-t")`);
		expect(await ev(v, `document.querySelector(".pdv .pdv-t").textContent`)).toBe(title);
		await run(v, `document.querySelector(".pdv .pdv-back").click()`);
		await waitFor(v, `!document.querySelector(".pdv")`);
		expect(await ev(v, `[current, ${PANEL}, location.hash]`)).toEqual(["chat", true, "#project/ch%3A7001"]);
	}
});

for (const [w, h] of [[1100, 800], [1280, 844], [1440, 900], [1680, 1000]] as const) {
	test(`S7/REQ3: ${w}px the 현황 button toggles the drawer in place: same composer, draft, focus, reading position, list width; the head and composer stay uncovered; the address is replaced`, async () => {
		const v = await boot(w, "", h);
		await openChat(v, "ch:7001");
		await touch(v);
		await waitFor(v, `history.state && history.state.dz`);
		expect(await ev(v, TOG)).toBe(true);
		await run(v, `window.__c = $("#composer"); ta.value = "보내기 전 초안"; ta.focus(); const tl = $("#timeline"); tl.dispatchEvent(new Event("wheel")); tl.scrollTop = Math.round((tl.scrollHeight - tl.clientHeight) / 2); window.__len = history.length; window.__tlw = tl.clientWidth; window.__lw = $("#v-chat > .cv-side").getBoundingClientRect().width`);
		await settle(v);
		await shot(v, `${w}-drawer-closed.png`);
		const before = await ev<string>(v, READ);
		expect([before !== "", await ev(v, `$("#timeline").scrollTop > 0`)]).toEqual([true, true]);
		await v.click(".cv-head .pv-tog");
		await waitFor(v, PANEL);
		await settle(v);
		expect(await ev(v, `[$("#composer") === __c, ta.value, document.activeElement === ta, ${READ}, location.hash, history.length === __len, document.querySelector(".cv-head .pv-tog").getAttribute("aria-pressed")]`))
			.toEqual([true, "보내기 전 초안", true, before, "#project/ch%3A7001", true, "true"]);
		const r = await ev<{ hit: boolean; head: boolean; inside: boolean; inView: boolean; tl: number; tlw: number; lw: number; lw0: number }>(v, `(() => { const p = $("#pv-panel").getBoundingClientRect(), c = $("#composer").getBoundingClientRect(), s = $("#send-btn").getBoundingClientRect(), vw = document.documentElement.clientWidth, meets = b => !(b.right <= p.left || b.left >= p.right || b.bottom <= p.top || b.top >= p.bottom), hb = [...document.querySelectorAll("#v-chat > .cv-head button")].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect()); return { hit: meets(c) || meets(s), head: hb.length >= 2 && hb.every(b => !meets(b) && b.left >= 0 && b.right <= vw), inside: s.right <= c.right && s.left >= c.left, inView: c.right <= vw, tl: $("#timeline").clientWidth, tlw: __tlw, lw: $("#v-chat > .cv-side").getBoundingClientRect().width, lw0: __lw }; })()`);
		expect([r.hit, r.head, r.inside, r.inView]).toEqual([false, true, true, true]);
		expect(r.lw).toBe(r.lw0);
		if (w >= 1440) expect(r.tl).toBeGreaterThanOrEqual(400);
		else expect(r.tl).toBe(r.tlw);
		await shot(v, `${w}-drawer-open.png`);
		await v.click(".cv-head .pv-tog");
		await waitFor(v, CLOSED);
		await settle(v);
		expect(await ev(v, `[$("#composer") === __c, ta.value, document.activeElement === ta, ${READ}, location.hash, history.length === __len, document.querySelector(".cv-head .pv-tog").getAttribute("aria-pressed")]`))
			.toEqual([true, "보내기 전 초안", true, before, "#chat/ch:7001", true, "false"]);
		await run(v, `const tl = $("#timeline"); tl.dispatchEvent(new Event("wheel")); tl.scrollTop = tl.scrollHeight`);
		await settle(v);
		for (const shown of [PANEL, CLOSED]) {
			await v.click(".cv-head .pv-tog");
			await waitFor(v, shown);
			await settle(v);
			expect(await ev(v, `(tl => tl.scrollHeight - tl.scrollTop - tl.clientHeight)($("#timeline"))`)).toBeLessThanOrEqual(1);
		}
	});
}

test("S7/REQ3: an open drawer follows to another project's chat from the list, not to the main chat, and is gone while the chat is split", async () => {
	const v = await boot(1280);
	await openChat(v, "ch:7001");
	expect(await ev(v, TOG)).toBe(true);
	await run(v, `document.querySelector(".cv-head .pv-tog").click()`);
	await waitFor(v, PANEL);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="ch:7002"]').click()`);
	await waitFor(v, `target === "ch:7002" && ${PANEL} && document.querySelector("#pv-panel .pmv-title").textContent === "블로그"`);
	expect(await ev(v, `location.hash`)).toBe("#project/ch%3A7002");
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="main"]').click()`);
	await waitFor(v, `target === "main" && ${CLOSED} && document.querySelector(".cv-head .cv-hd-t")?.textContent === "dotz"`);
	expect(await ev(v, `[location.hash, !!document.querySelector(".cv-head .pv-tog")]`)).toEqual(["#chat/main", false]);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]').click()`);
	await waitFor(v, `target === "ch:7001" && ${PANEL}`);
	await run(v, `paneSplit("ch:7002", "chat", "right")`);
	await waitFor(v, `paneCount() === 2 && ${CLOSED} && !location.hash.startsWith("#project/")`);
	expect(await ev(v, `[...document.querySelectorAll(".pv-tog")].filter(b => b.getClientRects().length).length`)).toBe(0);
	await run(v, `while (paneCount() > 1) paneClose(paneList().find(p => !p.active).id)`);
	await waitFor(v, `paneCount() === 1 && !localStorage.getItem("dotz-panes")`);
});

test("S3: 1280px the project list opened by go(\"projects\") leads to a project's chat with its panel, and back returns to the list, then home", async () => {
	const v = await boot(1280, "#home");
	await touch(v);
	await run(v, `go("projects")`);
	await waitFor(v, `current === "projects" && document.querySelector('#v-projects .pl-row[data-key="ch:7002"]')`);
	expect(await ev(v, `location.hash`)).toBe("#projects");
	await run(v, `document.querySelector('#v-projects .pl-row[data-key="ch:7002"]').click()`);
	await waitFor(v, `current === "chat" && target === "ch:7002" && ${PANEL}`);
	expect(await ev(v, `location.hash`)).toBe("#project/ch%3A7002");
	await back(v);
	await waitFor(v, `current === "projects"`);
	expect(await ev(v, `location.hash`)).toBe("#projects");
	await back(v);
	await waitFor(v, `current === "home"`);
	expect(await ev(v, `location.hash`)).toBe("#home");
});

test("S7: 1440px an opened canvas takes the drawer's column: no drawer and no 현황 button while it is open, the address is the chat's, and both come back when it closes", async () => {
	const v = await boot(1440, "", 900);
	await run(v, `go("project", "ch:7001")`);
	await waitFor(v, `target === "ch:7001" && ${PANEL}`);
	await run(v, `canvasOpen("/tmp/notes.html", "notes.html")`);
	await waitFor(v, `${CLOSED} && location.hash === "#chat/ch:7001"`);
	expect(await ev(v, `[${TOG}, document.querySelector("#canvas").getClientRects().length > 0]`)).toEqual([false, true]);
	await run(v, `canvasClose()`);
	await waitFor(v, `${TOG} && ${PANEL} && location.hash === "#project/ch%3A7001"`);
});

for (const w of [1100, 1280]) {
	test(`S7: ${w}px with the drawer open the jump-to-bottom button stays reachable beside it`, async () => {
		const v = await boot(w);
		await openChat(v, "ch:7001");
		await run(v, `document.querySelector(".cv-head .pv-tog").click()`);
		await waitFor(v, PANEL);
		await run(v, `const tl = $("#timeline"); tl.dispatchEvent(new Event("wheel")); tl.scrollTop = Math.round((tl.scrollHeight - tl.clientHeight) / 2)`);
		await waitFor(v, `!document.querySelector("#chat-jump").hidden && document.querySelector("#chat-jump").getClientRects().length > 0`);
		await settle(v);
		expect(await ev(v, `(b => { const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === b || b.contains(hit); })(document.querySelector("#chat-jump"))`)).toBe(true);
	});
}

test("S7/REQ4: 390px [대화 | 현황] under the conversation keeps the composer and timeline; 뒤로 and the browser's back go 현황 → 대화 → list", async () => {
	const v = await boot(390);
	await run(v, `go("chat", "list")`);
	await waitFor(v, `convListing() && document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]')`);
	await touch(v);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]').click()`);
	await waitFor(v, `target === "ch:7001" && convOnPhone() && document.querySelectorAll("#tl [data-ts]").length > 20`);
	await settle(v);
	const tabs = `[...document.querySelectorAll(".pv-seg:not([hidden]) [role=tab]")].map(b => [b.textContent, b.getAttribute("aria-selected")])`;
	expect(await ev(v, tabs)).toEqual([["대화", "true"], ["현황", "false"]]);
	expect(await ev(v, PANEL)).toBe(false);
	await run(v, `window.__c = $("#composer"); ta.value = "폰 초안"; const tl = $("#timeline"); tl.dispatchEvent(new Event("touchstart")); tl.scrollTop = Math.round((tl.scrollHeight - tl.clientHeight) / 2); window.__top = tl.scrollTop`);
	const top = await ev<number>(v, `__top`);
	await shot(v, "390-chat.png");
	await run(v, `document.querySelector('.pv-seg [data-k="overview"]').click()`);
	await waitFor(v, PANEL);
	expect(await ev(v, tabs)).toEqual([["대화", "false"], ["현황", "true"]]);
	expect(await ev(v, `[location.hash, $("#composer") === __c, ta.value]`)).toEqual(["#project/ch%3A7001", true, "폰 초안"]);
	await shot(v, "390-overview.png");
	const where = `[location.hash, convOnPhone(), convListing(), ${PANEL}]`;
	await run(v, `$("#back").click()`);
	await waitFor(v, `!H.moving && H.hash !== "project/ch%3A7001"`);
	await settle(v);
	expect(await ev(v, where)).toEqual(["#chat/ch:7001", true, false, false]);
	expect(await ev(v, `[$("#composer") === __c, ta.value, $("#timeline").scrollTop]`)).toEqual([true, "폰 초안", top]);
	await run(v, `document.querySelector('.pv-seg [data-k="overview"]').click()`);
	await waitFor(v, `${PANEL} && location.hash === "#project/ch%3A7001"`);
	await back(v);
	await settle(v);
	expect(await ev(v, where)).toEqual(["#chat/ch:7001", true, false, false]);
	await back(v);
	await settle(v);
	expect(await ev(v, where)).toEqual(["#chat/list", false, true, false]);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]').click()`);
	await waitFor(v, `target === "ch:7001" && convOnPhone()`);
	expect(await ev(v, `[${CLOSED}, document.querySelector('.pv-seg [data-k="chat"]').getAttribute("aria-selected")]`)).toEqual([true, "true"]);
});

test("S7/REQ5: a refresh with changed data repaints the panel where it was scrolled and leaves the composer's focus alone", async () => {
	const v = await boot(1280, "", 700);
	await openChat(v, "ch:7001");
	expect(await ev(v, TOG)).toBe(true);
	await run(v, `document.querySelector(".cv-head .pv-tog").click()`);
	await waitFor(v, `${PANEL} && document.querySelector("#pv-panel").scrollHeight > document.querySelector("#pv-panel").clientHeight + 200`);
	await run(v, `const p = $("#pv-panel"); p.scrollTop = 150; window.__top = p.scrollTop; window.__node = p.querySelector(".pm-o"); ta.focus()`);
	rev++;
	await run(v, `pmLoad()`);
	await waitFor(v, `$("#pv-panel .pm-o") !== __node && $("#pv-panel").innerText.includes("요약 ${rev}")`);
	expect(await ev(v, `[$("#pv-panel").scrollTop === __top, document.activeElement === ta]`)).toEqual([true, true]);
	await run(v, `window.__node = $("#pv-panel .pm-o"); pmLoad()`);
	await waitFor(v, `!latestOut("project:ch:7001")`);
	expect(await ev(v, `$("#pv-panel .pm-o") === __node`)).toBe(true);
});

test("REQ6: 삭제 from the chat head with the panel open lands on the main chat with no panel, at #chat/main, and the project's row leaves the chat list", async () => {
	const v = await boot(1280);
	await run(v, `go("project", "ch:7001")`);
	await waitFor(v, `PM.key === "ch:7001" && PM.D`);
	await settle(v);
	expect(await ev(v, `[current, ${PANEL}]`)).toEqual(["chat", true]);
	expect(await ev(v, `!!document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]')`)).toBe(true);
	await waitFor(v, `document.querySelector(".cv-head .cvmenu")`);
	await run(v, `document.querySelector(".cv-head .cvmenu").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `[...document.querySelectorAll(".menu .mi")].find(m => m.textContent.includes("삭제")).click()`);
	await waitFor(v, `document.querySelector('.fs-ft [data-k="delete"]')`);
	await run(v, `document.querySelector('.fs-ft [data-k="delete"]').click()`);
	await waitFor(v, `!document.querySelector(".fs-card") && target === "main" && location.hash === "#chat/main"`);
	expect(deletes).toEqual(["/api/projects/ch%3A7001"]);
	expect(await ev(v, `[current, ${PANEL}, ${TOG}, PM.key]`)).toEqual(["chat", false, false, ""]);
	await waitFor(v, `!document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]')`, 2000);
	expect(await ev(v, `!!document.querySelector('#chat-convo .cv-row[data-t="ch:7002"]')`)).toBe(true);
});

test("390px: 삭제 from 현황 lands on the chat list, and the browser's back goes to 홈, never to the deleted project", async () => {
	const v = await boot(390);
	deletes.length = 0;
	await run(v, `go("chat", "list")`);
	await waitFor(v, `convListing() && document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]')`);
	await touch(v);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]').click()`);
	await waitFor(v, `target === "ch:7001" && convOnPhone()`);
	await run(v, `document.querySelector('.pv-seg [data-k="overview"]').click()`);
	await waitFor(v, `${PANEL} && location.hash === "#project/ch%3A7001" && !document.querySelector("#pjmenu").hidden`);
	await run(v, `document.querySelector("#pjmenu").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `[...document.querySelectorAll(".menu .mi")].find(m => m.textContent.includes("삭제")).click()`);
	await waitFor(v, `document.querySelector('.fs-ft [data-k="delete"]')`);
	await run(v, `document.querySelector('.fs-ft [data-k="delete"]').click()`);
	await waitFor(v, `!document.querySelector(".fs-card") && target === "main" && !S.channels.work["7001"] && !H.moving && !H.hold`);
	await settle(v);
	const where = `[location.hash, current, convListing(), ${PANEL}, !!document.querySelector('#chat-convo .cv-row[data-t="ch:7001"]')]`;
	expect(deletes).toEqual(["/api/projects/ch%3A7001"]);
	expect(await ev(v, where)).toEqual(["#chat/list", "chat", true, false, false]);
	await back(v);
	await waitFor(v, `!H.moving && !H.hold`);
	await settle(v);
	expect(await ev(v, where)).toEqual(["#home", "home", false, false, false]);
});

test("a drawer opened at 1280px and carried to 390px: 대화 leaves no 현황 entry behind, so back from the list never reopens it", async () => {
	const v = await boot(1280);
	await touch(v);
	await run(v, `go("chat", "ch:7001")`);
	await waitFor(v, `target === "ch:7001" && ${TOG}`);
	await run(v, `document.querySelector(".cv-head .pv-tog").click()`);
	await waitFor(v, `${PANEL} && location.hash === "#project/ch%3A7001"`);
	await v.resize(390, 844);
	await waitFor(v, `narrowChat() && !document.querySelector(".pv-seg").hidden`);
	await settle(v);
	const where = `[location.hash, convListing(), ${PANEL}]`;
	await run(v, `document.querySelector('.pv-seg [data-k="chat"]').click()`);
	await waitFor(v, `${CLOSED} && !H.moving`);
	await settle(v);
	expect(await ev(v, where)).toEqual(["#chat/ch:7001", false, false]);
	await run(v, `$("#back").click()`);
	await waitFor(v, `convListing() && !H.moving`);
	await settle(v);
	const seen: unknown[] = [];
	for (let i = 0; i < 3 && (await ev(v, `current`)) !== "home"; i++) {
		await back(v);
		await waitFor(v, `!H.moving && !H.hold`);
		await settle(v);
		seen.push(await ev(v, where));
	}
	expect(seen.filter(s => (s as [string, boolean, boolean])[2] || (s as [string])[0].startsWith("#project/"))).toEqual([]);
	expect(seen.at(-1)).toEqual(["#home", false, false]);
});

for (const w of [390, 1280]) {
	test(`${w}px: back onto a history entry stacked as #project/builtin%3Acustom opens 내 규칙·커스텀 in that entry, and the next back leaves it for 홈`, async () => {
		const v = await boot(w, "#home");
		await touch(v);
		await waitFor(v, `history.state && history.state.dz && current === "home"`);
		await run(v, `history.pushState({ dz: 1, c: ["home", "project/builtin%3Acustom"], ov: 0, w: ["home", "project/builtin%3Acustom"] }, "", "#project/builtin%3Acustom"); history.pushState({ dz: 1, c: ["home", "project/builtin%3Acustom", "settings"], ov: 0, w: ["home", "settings"] }, "", "#settings"); H.hash = "settings"; H.want = ["home", "settings"]; go("settings")`);
		await waitFor(v, `current === "settings" && !H.moving`);
		const len0 = await ev<number>(v, `history.length`);
		const seen: unknown[] = [];
		for (let i = 0; i < 4 && (await ev(v, `current`)) !== "home"; i++) {
			await back(v);
			await waitFor(v, `!H.moving && !H.hold`);
			await settle(v);
			seen.push(await ev(v, `[current, location.hash, history.length - ${len0}]`));
		}
		expect(seen).toEqual([["custom", "#custom", 0], ["home", "#home", 0]]);
	});
}
