import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { ev, fakeHub, fixPageNow, json, run, waitFor, type View } from "./test-web.ts";

const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const watch = (name: string, extra: object = {}) => ({ name, watch: name, kind: "watch", every: "10분마다", last_run: iso(-5 * 60_000), next_run: iso(5 * 60_000), last_result: "ok", connection: "connected", fails: 0, ...extra });
const intg = (key: string, label: string, needs: object = {}) => ({ key, label, icon: key === "kakao" ? "chat" : key, kind: "app", conv: key === "mail" ? ["mail:"] : [], notices: [], state: "connected", needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0, ...needs } });
const webApp = (id: string, label: string) => ({ id, label, icon: "file", kind: "tool", source: "manifest", status: "running", health: "ok", watches: [], settings: {}, web: { href: `/apps/${id}/`, url: "http://127.0.0.1:4500", path: "/", mode: "rewrite" } });
const sentToday = { item: "kakao:S1", ref: "S1", kind: "kakao", app: "kakao", label: "카카오톡", conv: "i:kakao", at: NOW - 60_000, can: { send: false, revise: false, edit: false, drop: false, restore: false },
	draft: { state: "sent", toLabel: "대화방", to: "가나", text: "고마워요" }, original: { who: "가나", text: "대화방" }, send: { state: "sent", at: NOW - 60_000, how: "owner", today: true, actions: [] } };

let monitors: object[] = [];
let notices: object[] = [];
let queue: object[] = [];
const bothApps = [webApp("docs", "Docs"), webApp("zeta", "Zeta")];
let webApps = bothApps;
let peers: { name: string; url: string; online: boolean; stale: boolean; items: object }[] = [];
const MINI = "http://mini.test";
const miniWith = (...names: string[]) => [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: names.map(n => watch(n)), notices: [], integrations: [], conversations: [] } }];
const hub = fakeHub({
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/monitors") return json({ items: monitors });
		if (p === "/api/notices") return json({ unread: 0, items: notices });
		if (p === "/api/integrations") return json({ items: [intg("mail", "메일"), intg("kakao", "카카오톡", { unread: 2 }), intg("youtube", "유튜브")], available: [] });
		if (p === "/api/apps") return json({ items: webApps, errors: [] });
		if (p === "/api/apps/docs" && req.method === "DELETE") { webApps = [bothApps[1]!]; return json({ ok: true }); }
		if (p === "/api/peers" && peers.length) return json([{ name: "맥북", url: hub.origin, self: true, online: true }, ...peers.map(x => ({ name: x.name, url: x.url, self: false, online: x.online }))]);
		if (p === "/api/machine" && peers.length) return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [] });
		if (p.startsWith("/apps/")) return new Response(`<!doctype html><title>app</title><p id="in">${p}</p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
		return undefined;
	},
});
afterEach(() => { hub.release(); peers = []; webApps = bothApps; });
afterAll(() => hub.stop());

const keys = (v: View) => ev<string[]>(v, `monRows(monItems(), null).map(r => r.header ? "#" + r.header : r.k)`);
const frame = (v: View) => v.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);
async function boot(width: number, pins: string[] = []): Promise<View> {
	const v = await hub.view({ width, height: 860 });
	await v.navigate(`${hub.origin}/`);
	await run(v, `localStorage.setItem("dotz-app-pins", ${JSON.stringify(JSON.stringify(pins))})`);
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && INTG.loaded && APPS.loaded && RQ.loaded`);
	await fixPageNow(v, NOW);
	await run(v, `go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side [data-k="x:docs"]')`);
	return v;
}

describe("the 앱 tab list (S8)", () => {
	test("승인 대기 first; then the pinned app, the app with something waiting and the rest by name, 앱 관리 last, no header; then 모니터링 with the failed watch and one fold row for the two fine ones", async () => {
		monitors = [watch("서버 응답"), watch("백업 확인", { last_result: "fail", fails: 1 }), watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280, ["x:zeta"]);
		expect(await keys(v)).toEqual(["replies", "x:zeta", "i:kakao", "i:mail", "i:youtube", "x:docs", "add-app", "#모니터링", "m:백업 확인", "fold:일반 모니터링"]);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#mon-side .mon-sec")].map(s => s.textContent)`)).toEqual(["모니터링"]);
	});

	test("on a phone with nothing waiting, 승인 대기 is there without a count and says so; once a reply went out today it says how many and 보낸 것 lists it", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(390);
		const row = `document.querySelector('#mon-side .cv-row[data-k="replies"]')`;
		await waitFor(v, row);
		expect(await ev<[string, string, string]>(v, `[${row}.querySelector(".cv-n").textContent, ${row}.querySelector(".cv-p").textContent, ${row}.querySelector(".nb") ? ${row}.querySelector(".nb").textContent : ""]`)).toEqual(["승인 대기", "대기 중인 항목 없음", ""]);
		queue = [sentToday];
		await run(v, `rqLoad()`);
		await waitFor(v, `${row}.querySelector(".cv-p").textContent === "오늘 보낸 답장 1건"`);
		await run(v, `${row}.click()`);
		await waitFor(v, `MON.sel === "replies" && document.querySelector('#mon-tl .rq-tabs [data-f="sent"]')`);
		await run(v, `document.querySelector('#mon-tl .rq-tabs [data-f="sent"]').click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-r.sent").length === 1`);
	}, 30_000);

	test("상단 고정 in a web app's ⋯ menu puts it first, a reload keeps it there, 고정 해제 puts it back by name", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const apps = async (v: View) => (await keys(v)).filter(k => /^[ix]:/.test(k));
		const pick = async (v: View, label: string) => {
			await run(v, `go("monitoring", "x:docs")`);
			await waitFor(v, `document.querySelector('#mon-app .apps-hd [aria-haspopup]')`);
			await run(v, `document.querySelector('#mon-app .apps-hd [aria-haspopup]').click()`);
			await waitFor(v, `[...document.querySelectorAll(".menu .mi")].some(b => b.textContent.trim() === ${JSON.stringify(label)})`);
			await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
		};
		const v = await boot(1280);
		expect(await apps(v)).toEqual(["i:kakao", "i:mail", "i:youtube", "x:docs", "x:zeta"]);
		await pick(v, "상단 고정");
		await waitFor(v, `monRows(monItems(), null)[1].k === "x:docs"`);
		expect(await apps(v)).toEqual(["x:docs", "i:kakao", "i:mail", "i:youtube", "x:zeta"]);
		await v.navigate(`${hub.origin}/`);
		await waitFor(v, `S && INTG.loaded && APPS.loaded && monItems().some(i => i.key === "x:docs")`);
		expect(await apps(v)).toEqual(["x:docs", "i:kakao", "i:mail", "i:youtube", "x:zeta"]);
		await pick(v, "고정 해제");
		await waitFor(v, `monRows(monItems(), null)[1].k === "i:kakao"`);
		expect(await apps(v)).toEqual(["i:kakao", "i:mail", "i:youtube", "x:docs", "x:zeta"]);
	});

	test("a web app opens in the right pane at #monitoring/x:<id>, and coming back to it after another item finds the same iframe", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280);
		await run(v, `document.querySelector('#mon-side [data-k="x:docs"]').click()`);
		await waitFor(v, `document.querySelector("#mon-app iframe.apps-frame") && document.querySelector("#mon-app").offsetWidth > 0`);
		expect(await ev<string>(v, `location.hash`)).toBe("#monitoring/x%3Adocs");
		expect(await ev<string>(v, `document.querySelector("#mon-app iframe").getAttribute("src")`)).toBe("/apps/docs/");
		expect(await ev<boolean>(v, `document.querySelector("#mon-app").getBoundingClientRect().left >= document.querySelector("#mon-side").getBoundingClientRect().right`)).toBe(true);
		expect(await ev<string>(v, `document.querySelector('#mon-side .cv-row.on').dataset.k`)).toBe("x:docs");
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#mon-app .apps-n")].map(n => n.textContent)`)).toEqual(["Docs"]);
		await run(v, `window.__frame = document.querySelector("#mon-app iframe")`);
		await run(v, `go("monitoring", "i:mail")`);
		await waitFor(v, `MON.sel === "i:mail" && document.querySelector("#mon-app").offsetWidth === 0`);
		await run(v, `go("monitoring", "x:docs")`);
		await waitFor(v, `MON.sel === "x:docs" && document.querySelector("#mon-app").offsetWidth > 0`);
		expect(await ev<boolean>(v, `document.querySelector("#mon-app iframe") === window.__frame`)).toBe(true);
	});

	test("an address naming no installed app opens the list with nothing selected", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280);
		await run(v, `const h = parseHash("#monitoring/x%3Anope"); go(h.view, h.t)`);
		await waitFor(v, `current === "monitoring" && MON.list`);
		expect(await ev<[boolean, boolean]>(v, `[!!document.querySelector("#mon-side .cv-row.on"), document.querySelector("#v-monitoring").classList.contains("x-on")]`)).toEqual([false, false]);
	});

	test("on a phone a web app takes the screen and 뒤로 returns to the list", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(390);
		await run(v, `document.querySelector('#mon-side [data-k="x:docs"]').click()`);
		await waitFor(v, `document.querySelector("#mon-app iframe") && document.querySelector("#mon-app").offsetWidth > 0 && document.querySelector("#mon-side").offsetWidth === 0`);
		expect(await ev<[string, number]>(v, `[document.querySelector("#title").textContent, document.querySelectorAll("#mon-app .apps-n").length]`)).toEqual(["Docs", 0]);
		await run(v, `history.back()`);
		await waitFor(v, `MON.list && document.querySelector("#mon-side").offsetWidth > 0 && document.querySelector("#mon-app").offsetWidth === 0`);
	});

	test("with every watch fine, 모니터링 holds one row 모두 정상 · 마지막 확인 that unfolds on a tap and stays open through a repaint; the header opens the overview at #monitoring/notice; 기타 감시 기록 shows only while a report belongs to no row", async () => {
		monitors = [watch("서버 응답"), watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280);
		const fold = `document.querySelector('#mon-side .cv-row.cv-fold')`;
		await waitFor(v, fold);
		expect(await ev<[string, string, boolean]>(v, `[${fold}.querySelector(".cv-n").textContent, ${fold}.getAttribute("aria-expanded"), !!document.querySelector('#mon-side [data-k^="m:"]')]`)).toEqual(["모두 정상 · 마지막 확인 5분 전", "false", false]);
		await run(v, `${fold}.click()`);
		await waitFor(v, `document.querySelectorAll('#mon-side .cv-row[data-k^="m:"]').length === 2`);
		await run(v, `monDirty(true)`);
		await waitFor(v, `MON.side`);
		expect(await ev<[string, number]>(v, `[${fold}.getAttribute("aria-expanded"), document.querySelectorAll('#mon-side .cv-row[data-k^="m:"]').length]`)).toEqual(["true", 2]);
		expect(await ev<boolean>(v, `!!document.querySelector('#mon-side .cv-row[data-k="notice"]')`)).toBe(false);
		await run(v, `document.querySelector("#mon-side .mon-sec-go").click()`);
		await waitFor(v, `MON.sel === "notice" && document.querySelector("#mon-tl .mon-ov")`);
		expect(await ev<string>(v, `location.hash`)).toBe("#monitoring/notice");
		notices = [{ id: "w1", kind: "watch", tone: "", title: "없어진 감시", text: "없어진 감시: 디스크가 찼어요", open: "alert", ts: iso(-60_000), read: false }];
		await run(v, `loadNotices()`);
		await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="notice"]')`);
		expect(await ev<string>(v, `document.querySelector('#mon-side .cv-row[data-k="notice"] .cv-n').textContent`)).toBe("기타 감시 기록");
	});

	test("an open watch that is fine keeps its own row, lit, beside the pane, and after 뒤로 on a phone; the fold row counts the others (S8)", async () => {
		monitors = [watch("서버 응답"), watch("디스크 점검"), watch("백업 확인", { last_result: "fail", fails: 1 })];
		notices = []; queue = [];
		const side = `[...document.querySelectorAll("#mon-side .cv-row")]`;
		const wide = await boot(1280);
		await run(wide, `go("monitoring", "m:서버 응답")`);
		await waitFor(wide, `MON.sel === "m:서버 응답" && !MON.list`);
		await frame(wide);
		expect(await ev<string[]>(wide, `${side}.map(r => r.dataset.k)`)).toEqual(["replies", "m:백업 확인", "m:서버 응답", "fold:일반 모니터링"]);
		expect(await ev<string>(wide, `document.querySelector("#mon-side .cv-row.on").dataset.k`)).toBe("m:서버 응답");
		expect(await ev<string>(wide, `document.querySelector("#mon-side .cv-row.cv-fold .cv-p").textContent`)).toBe("모니터 1개");
		const phone = await boot(390);
		await run(phone, `location.hash = "#monitoring/" + encodeURIComponent("m:서버 응답")`);
		await waitFor(phone, `MON.sel === "m:서버 응답" && !MON.list`);
		await run(phone, `history.back()`);
		await waitFor(phone, `MON.list && document.querySelector("#mon-side").offsetWidth > 0`);
		expect(await ev<string[]>(phone, `${side}.map(r => r.dataset.k).filter(k => /^(m:|fold:)/.test(k))`)).toEqual(["m:백업 확인", "m:서버 응답", "fold:일반 모니터링"]);
		expect(await ev<string>(phone, `document.querySelector("#mon-side .cv-row.cv-fold .cv-p").textContent`)).toBe("모니터 1개");
	}, 30_000);

	test("fine watches fold per computer: this computer's in its own row, the Mac mini's in a row of its own, and each lists only its own watches when unfolded (S8)", async () => {
		monitors = [watch("local-ok")];
		notices = []; queue = [];
		peers = miniWith("peer-ok", "peer-ok2");
		const v = await boot(1280);
		await waitFor(v, `PQ.loaded && PQ.list.length`);
		await frame(v);
		const folds = `[...document.querySelectorAll("#mon-side .cv-row.cv-fold")]`;
		expect(await ev<string[]>(v, `${folds}.map(f => f.querySelector(".cv-p").textContent)`)).toEqual(["모니터 1개", "맥미니에서 돌아요 · 모니터 2개"]);
		const mons = `[...document.querySelectorAll('#mon-side .cv-row[data-k*="m:"]')].map(r => r.dataset.k)`;
		expect(await ev<string[]>(v, mons)).toEqual([]);
		await run(v, `${folds}[1].click()`);
		await waitFor(v, `${mons}.length === 2`);
		expect(await ev<string[]>(v, mons)).toEqual([`p:${MINI}|m:peer-ok`, `p:${MINI}|m:peer-ok2`]);
		await run(v, `${folds}[0].click()`);
		await waitFor(v, `${mons}.length === 3`);
		expect(await ev<string[]>(v, mons)).toEqual(["m:local-ok", `p:${MINI}|m:peer-ok`, `p:${MINI}|m:peer-ok2`]);
	}, 30_000);

	test("a pin survives its app being switched off and on: the app is gone from the list while off and comes back first", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280, ["x:zeta"]);
		const apps = async () => (await keys(v)).filter(k => /^[ix]:/.test(k));
		expect((await apps())[0]).toBe("x:zeta");
		webApps = [bothApps[0]];
		await run(v, `loadApps()`);
		await waitFor(v, `!monItems().some(i => i.key === "x:zeta")`);
		expect(await apps()).toEqual(["i:kakao", "i:mail", "i:youtube", "x:docs"]);
		webApps = bothApps;
		await run(v, `loadApps()`);
		await waitFor(v, `monItems().some(i => i.key === "x:zeta")`);
		expect((await apps())[0]).toBe("x:zeta");
		expect(await ev<string>(v, `localStorage.getItem("dotz-app-pins")`)).toBe(`["x:zeta"]`);
	});

	test("제거 in an open web app's ⋯ menu returns to the 앱 tab list at #monitoring with nothing selected, without a history entry for #apps, and drops its pin (S8)", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280, ["x:docs", "i:mail"]);
		await run(v, `go("monitoring", "x:docs")`);
		await waitFor(v, `document.querySelector('#mon-app .apps-hd [aria-haspopup]')`);
		await run(v, `document.querySelector('#mon-app .apps-hd [aria-haspopup]').click()`);
		await waitFor(v, `[...document.querySelectorAll(".menu .mi")].some(b => b.textContent.trim() === "제거")`);
		await run(v, `[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.trim() === "제거").click()`);
		await waitFor(v, `[...document.querySelectorAll("button.btn.danger")].some(b => b.textContent.trim() === "제거")`);
		await run(v, `[...document.querySelectorAll("button.btn.danger")].find(b => b.textContent.trim() === "제거").click()`);
		await waitFor(v, `!monItems().some(i => i.key === "x:docs")`);
		await frame(v);
		expect(await ev<[string, string, boolean, string, number]>(v, `[location.hash, current, MON.list, MON.sel, document.querySelector("#mon-app").offsetWidth]`)).toEqual(["#monitoring", "monitoring", true, "", 0]);
		expect(await ev<string>(v, `localStorage.getItem("dotz-app-pins")`)).toBe(`["i:mail"]`);
	}, 20_000);

	test("the 30 s reload of the web apps leaves the list rows in place: the focused row stays focused (S8)", async () => {
		monitors = [watch("디스크 점검")];
		notices = []; queue = [];
		const v = await boot(1280);
		await run(v, `window.__row = document.querySelector('#mon-side [data-k="i:mail"]'); window.__row.focus()`);
		await run(v, `loadApps()`);
		await frame(v);
		await frame(v);
		expect(await ev<[boolean, string]>(v, `[window.__row.isConnected, document.activeElement.dataset.k || document.activeElement.tagName]`)).toEqual([true, "i:mail"]);
		webApps = [bothApps[0]!];
		await run(v, `loadApps()`);
		await waitFor(v, `!document.querySelector('#mon-side [data-k="x:zeta"]')`);
	});

	for (const width of [390, 1280]) {
		test(`at ${width}px the 모니터링 header's chevron ends where the row chevrons end`, async () => {
			monitors = [watch("디스크 점검")];
			notices = []; queue = [];
			const v = await boot(width);
			await waitFor(v, `document.querySelector("#mon-side .mon-sec-go")`);
			const edge = (sel: string) => `(() => { const n = document.querySelector(${JSON.stringify(sel)}), s = getComputedStyle(n); return [getComputedStyle(n, "::after").content, n.getBoundingClientRect().right - parseFloat(s.paddingRight)]; })()`;
			const [hc, he] = await ev<[string, number]>(v, edge("#mon-side .mon-sec-go"));
			const [rc, re] = await ev<[string, number]>(v, edge('#mon-side .cv-row[data-k="i:mail"]'));
			expect(rc).not.toBe("none");
			expect(hc).toBe(rc);
			expect(Math.abs(he - re)).toBeLessThanOrEqual(1);
		});
	}
});
