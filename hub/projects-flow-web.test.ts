import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// 프로젝트 tab, three levels (web/js/18-lanes.js, 19-project-main.js) as shipped: a headless Bun.WebView at 390 and 1280 against a stub
// gateway with 30 projects. Screenshots are written only when PROJECTS_SHOTS names a folder. Names are placeholders.
const SHOTS = process.env.PROJECTS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const AT = "2026-10-25T09:00:00.000Z", AT_MS = Date.parse(AT);
type Mile = { text: string; done: boolean };
type Rec = { title?: string; purpose?: string; goal?: string; milestones?: Mile[]; updated: string };
const records: Record<string, Rec> = {};
const projects = Array.from({ length: 30 }, (_, i) => {
	const n = i + 1, key = `ch:${8000 + i}`, ch = { id: String(8000 + i), name: `프로젝트 ${n}` };
	const ms = i < 4 ? [{ text: "정리하기", done: true }, { text: "고치기", done: false }, { text: "확인하기", done: false }]
		: i < 10 ? [{ text: "설계", done: true }, { text: "구현", done: true }, { text: "검증", done: false }, { text: "정리", done: false }]
		: i < 20 ? [{ text: "시작", done: true }, { text: "끝", done: true }] : [];
	const lanes = i < 4 ? [{ name: `lane-q${i}`, title: `질문 세션 ${n}`, status: "idle", live: true, waiting: true, startedAt: AT, lastText: "확인 부탁드려요" }]
		: i < 10 ? [{ name: `lane-w${i}`, title: `작업 세션 ${n}`, status: "working", live: true, startedAt: AT, lastText: "작업 중" }] : [];
	// A stored record can still hold milestones and a goal; the screens must not show them.
	const rec: Rec = { title: `프로젝트 ${n}`, purpose: `${n}번째 프로젝트`, updated: AT, milestones: ms };
	if (i < 10) rec.goal = `${n}번째 목표`;
	records[key] = rec;
	return { key, channel: ch, name: `프로젝트 ${n}`, pinned: false, recordKey: key, record: rec, lanes };
});
const builtin = { key: "builtin:custom", name: "커스텀", note: "내 취향대로 바꾼 것", pinned: true, builtin: true, lanes: [] };
const writes: { path: string; body: any }[] = [];

const detailOf = (key: string) => {
	const p = projects.find(x => x.key === key), rec = records[key];
	if (!p) return null;
	return [{
		key, record: rec, monitors: [{ id: "w1", name: "댓글 확인", every_minutes: 30, lastRun: AT, lastOk: true, script: "/x/watch.sh" }],
		routines: [{ id: "r1", name: "아침 정리", target: key, schedule: { at: "08:00" } }],
		schedules: [{ id: "s1", text: "밤 정리", at: "2026-10-27T00:00:00.000Z", every_minutes: 1440 }],
		lanes: p.lanes.map((l: any) => ({ name: l.name, title: l.title, status: l.status, live: l.live, waiting: l.waiting, finishedAt: AT, line: "마지막 줄" })),
		work: [{ id: "bw1", description: "폴더 정리", status: "done", started_at: AT_MS, ended_at: AT_MS }],
		results: [
			{ kind: "report", at: AT, lane: p.lanes[0]?.name || "lane-q0", tone: "done", title: "레인 보고", verified: true },
			{ kind: "commit", at: AT, title: "커밋 제목", hash: "abc1234" },
			{ kind: "verify", at: AT, title: "bun test", ok: true },
		],
		summary: { lanes: p.lanes.length, running: 0, waiting: p.lanes.length, lastActivity: AT },
	}, rec] as const;
};

const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let streamWaiters: (() => void)[] = [];
const te = new TextEncoder();
const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") {
			let ctl: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(te.encode(": open\n\n")); const w = streamWaiters; streamWaiters = []; for (const f of w) f(); },
				cancel() { streams.delete(ctl); },
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
		}
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: projects.flatMap(x => x.lanes.map((l: any) => ({ ...l, pendingAsk: l.waiting, cwd: `/tmp/${x.key}`, home: x.key }))), terminals: {}, channels: { work: {}, homes: {}, lanes: {}, threads: {} }, discord: {}, notices_unread: 0 });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [builtin, ...projects], routines: [], links: [] });
		if (p === "/api/custom/project") {
			if (url.searchParams.get("key") === "builtin:custom") return json({ groups: [{ id: "rules", label: "내 규칙", empty: "없어요", items: ["하나", "둘", "셋", "넷", "다섯", "여섯", "일곱"].map(n => ({ title: `규칙 ${n}`, full: `[11-01] 규칙 ${n}의 원문` })) }] });
			const d = detailOf(url.searchParams.get("key") || "");
			return d ? json(d[0]) : json({ error: "not found" }, 404);
		}
		if (p.startsWith("/api/projects") && req.method === "PUT") {
			const body = await req.json();
			writes.push({ path: p, body });
			const rec = records[body.key];
			if (rec) {
				for (const k of ["title", "purpose"]) if (typeof body[k] === "string") rec[k as "title"] = body[k];
				rec.updated = AT;
			}
			return json({ key: body.key, record: rec });
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/todo" || p === "/api/activity") return json({ items: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); for (const c of streams) { try { c.close(); } catch { /* already closed */ } } server.stop(true); });

const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// A pulsing status dot (작업 중) runs forever; only the entrance animations are waited for.
// The 더 보기 line spans its card and keeps the 44px tap height.
const moreBox = (v: View, card: string) => q(v, `const c = document.querySelector(${JSON.stringify(card)}), m = c.querySelector(".cv-more").getBoundingClientRect(); return { whole: m.width === c.clientWidth, tall: m.height >= 44 }`);
const shot = async (v: View, name: string) => { if (SHOTS) { await waitFor(v, `document.getAnimations().every(a => a.playState !== "running" || (a.effect && a.effect.getTiming().iterations === Infinity))`); await Bun.write(join(SHOTS, name), await v.screenshot()); } };

async function boot(width: number, height: number): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	const opened = new Promise<void>(r => streamWaiters.push(r));
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("projects")`);
	await waitFor(v, `document.querySelector(".pl-row")`);
	return v;
}

test("the list pages 12 projects at a time, filters by need/running and searches", async () => {
	const v = await boot(390, 844);
	const rows = `[...document.querySelectorAll('#pl-list .pl-row:not(.sub):not([data-k="sessions"])')]`;
	expect(await q<string[]>(v, `return ${rows}.slice(0, 3).map(r => r.querySelector(".li-end .tag").textContent)`).then(s => s.every(t => t.includes("답을 기다려요")))).toBe(true);
	expect(await q<number>(v, `return ${rows}.length`)).toBe(12);
	expect(await q(v, `return document.querySelector('#pl-list [data-k="more"]').textContent`)).toBe("프로젝트 18개 더 보기");
	// the list starts right under the app bar (normal section spacing, no stray gap)
	expect(await q<number>(v, `document.getAnimations().forEach(a => a.finish()); return document.querySelector(".pl").getBoundingClientRect().top - document.querySelector("#appbar").getBoundingClientRect().bottom`)).toBeLessThanOrEqual(20);
	expect(await q<number>(v, `const b = [...document.querySelectorAll(".pl-chips .mr-f")].map(x => Math.round(x.getBoundingClientRect().top)); return new Set(b).size`)).toBe(1);
	expect(await q<number>(v, `return Math.round(document.querySelector(".pl-search").getBoundingClientRect().width)`)).toBe(366);
	await shot(v, "01-list-390.png");
	await run(v, `document.querySelector('#pl-list [data-k="more"]').click()`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 24`);
	await run(v, `document.querySelector('#pl-list [data-k="more"]').click()`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 30`);
	expect(await q(v, `return !!document.querySelector('#pl-list [data-k="more"]')`)).toBe(false);
	// chips: need -> running -> all (paging starts again)
	expect(await q<string[]>(v, `return [...document.querySelectorAll(".pl-chips .mr-f")].map(b => b.dataset.view)`)).toEqual(["all", "run", "need"]);
	await run(v, `document.querySelector('.pl-chips [data-view="need"]').click()`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 4`);
	await run(v, `document.querySelector('.pl-chips [data-view="run"]').click()`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 6`);
	expect(await q<string[]>(v, `return [...document.querySelectorAll("#pl-list .pl-row:not(.sub) .li-end .tag")].map(n => n.textContent)`).then(s => s.every(t => t.includes("진행 중")))).toBe(true);
	await run(v, `document.querySelector('.pl-chips [data-view="all"]').click()`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 12`);
	// search narrows to the typed name
	await run(v, `const i = document.querySelector("#pl-q"); i.value = "프로젝트 17"; i.dispatchEvent(new Event("input", { bubbles: true }))`);
	await waitFor(v, `document.querySelectorAll("#pl-list .pl-row:not(.sub):not([data-k='sessions'])").length === 1`);
	expect(await q(v, `return document.querySelector("#pl-list .pl-row .pl-n").textContent`)).toBe("프로젝트 17");
	// every milestone of this stored record is ticked, and that no longer makes the project finished
	expect(await q(v, `return document.querySelector("#pl-list .pl-row .li-end .tag").textContent`)).toBe("아직 세션이 없어요");
	// the built-in 커스텀 page stays reachable at the end of 전체
	await run(v, `const i = document.querySelector("#pl-q"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true }))`);
	await waitFor(v, `document.querySelector("#pl-list .pl-row.sub")`);
	expect(await q(v, `return document.querySelector("#pl-list .pl-gh").textContent`)).toBe("내 설정");
	await run(v, `document.querySelector("#pl-list .pl-row.sub").click()`);
	await waitFor(v, `document.querySelector("#v-project .pmv-title")`);
	expect(await q(v, `return document.querySelector("#v-project .pmv-title").textContent`)).toBe("커스텀");
});

test("프로젝트 더 보기 is the last line of the last group's card and draws the next page", async () => {
	const v = await boot(390, 844);
	await waitFor(v, `document.querySelector(".pl-list > .cv-more:last-child")`);
	expect(await moreBox(v, ".pl-list:has(> .cv-more)")).toEqual({ whole: true, tall: true });
	expect(await q(v, `return document.querySelector(".pl-list > .cv-more").textContent`)).toBe("프로젝트 18개 더 보기");
	await run(v, `document.querySelector(".pl-list > .cv-more").click()`);
	await waitFor(v, `document.querySelector(".pl-list > .cv-more")?.textContent === "프로젝트 6개 더 보기"`);
});

test("커스텀 내 규칙: five rows and 더 보기 as the card's last line, a searchable full list, and a row opens the chat draft with the full text", async () => {
	const v = await boot(390, 844);
	await waitFor(v, `document.querySelector("#pl-list .pl-row.sub")`);
	await run(v, `document.querySelector("#pl-list .pl-row.sub").click()`);
	await waitFor(v, `document.querySelector("#v-project .list > .cv-more:last-child")`);
	expect(await moreBox(v, "#v-project .list")).toEqual({ whole: true, tall: true });
	expect(await q(v, `return [...document.querySelectorAll("#v-project .list > .li")].map(e => e.textContent)`)).toEqual(["규칙 하나", "규칙 둘", "규칙 셋", "규칙 넷", "규칙 다섯"]);
	expect(await q(v, `return document.querySelector("#v-project .cv-more").textContent`)).toBe("규칙 2개 더 보기");
	expect(await q(v, `return document.querySelectorAll("#v-project .list .btn").length`)).toBe(0);
	await run(v, `document.querySelector("#v-project .cv-more").click()`);
	await waitFor(v, `document.querySelector(".pdv-body #cm-q")`);
	expect(await q(v, `return document.querySelectorAll(".pdv-body .li").length`)).toBe(7);
	await run(v, `const i = document.querySelector("#cm-q"); i.value = "여섯의 원문"; i.dispatchEvent(new Event("input", { bubbles: true }))`);
	expect(await q(v, `return [...document.querySelectorAll(".pdv-body .li")].map(e => e.textContent)`)).toEqual(["규칙 여섯"]);
	await run(v, `document.querySelector(".pdv-body .li").click()`);
	await waitFor(v, `!document.querySelector(".fs-card.pdv:not([aria-hidden])") && ta.value.includes("[11-01] 규칙 여섯의 원문")`);
});

test("a row opens the overview; every section opens its own page and 뒤로 or the browser back returns", async () => {
	const v = await boot(390, 844);
	await run(v, `document.querySelectorAll("#pl-list .pl-row")[0].click()`);
	await waitFor(v, `document.querySelectorAll(".pm-sec").length === 5`);
	expect(await q<string[]>(v, `return [...document.querySelectorAll(".pm-sec > span")].map(n => n.textContent)`)).toEqual(["지금 상황", "세션 1", "작업 1", "결과 3", "감시 3"]);
	// 확인 필요 is the primary action, and it is a single tap into the waiting session's chat
	expect(await q(v, `return document.querySelector(".pm-need-t").textContent`)).toBe("질문 세션 1");
	expect(await q(v, `return document.querySelector('.pm-need [data-k="answer"]').textContent`)).toBe("대화에서 답하기");
	expect(await q(v, `return document.querySelector("#v-project").textContent.includes("단계")`)).toBe(false);
	// the page menu is a real 40px icon button, like the app's other ⋯ menus
	expect(await q(v, `const b = document.querySelector(".pmv-more").getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]`)).toEqual([40, 40]);
	await shot(v, "02-overview-390.png");
	// 세션 기록, 결과 전체, 루틴과 모니터링 each open in place and close back to the overview
	for (const [k, title, seen] of [["sessions", "세션 기록", ".pdv .srows"], ["results", "결과 전체", ".pdv .li"], ["routines", "루틴과 모니터링", ".pdv .pmv-rt"]] as const) {
		await run(v, `document.querySelector('.pm-sec [data-k="${k}"]').click()`);
		await waitFor(v, `!!document.querySelector("${seen}")`);
		expect(await q(v, `return document.querySelector(".pdv-t").textContent`)).toBe(title);
		await shot(v, `04-${k}-390.png`);
		await run(v, `document.querySelector(".pdv .pdv-back").click()`);
		await waitFor(v, `!document.querySelector(".pdv")`);
	}
	// the page is an overlay on the app's history stack: the browser's own back button returns to the overview
	await run(v, `document.querySelector('.pm-sec [data-k="routines"]').click()`);
	await waitFor(v, `!!document.querySelector(".pdv")`);
	await run(v, `history.back()`);
	await waitFor(v, `!document.querySelector(".pdv")`);
	expect(await q(v, `return !document.querySelector("#v-project").hidden && document.querySelectorAll(".pm-sec").length`)).toBe(5);
	// a write goes through the project's record key
	await v.evaluate(`pmWrite({ title: "프로젝트 1" }).then(() => 0)`);
	expect(writes.at(-1)!.body.key).toBe("ch:8000");
});

test("from 1100px the list sits beside the overview, and a section page opens over both", async () => {
	const v = await boot(1280, 900);
	await run(v, `document.querySelectorAll("#pl-list .pl-row")[0].click()`);
	await waitFor(v, `document.querySelectorAll(".pl-row").length > 0 && document.querySelectorAll(".pm-sec").length === 5`);
	expect(await q(v, `return !document.querySelector("#v-projects").hidden && document.querySelector(".views").classList.contains("pp")`)).toBe(true);
	// the open project is the selected row, and the chips stay on one line
	expect(await q(v, `return document.querySelector("#pl-list .pl-row.on .pl-n").textContent`)).toBe("프로젝트 1");
	expect(await q(v, `return getComputedStyle(document.querySelector("#pl-list .pl-row.on")).backgroundColor`)).toBe("rgb(232, 235, 238)");
	expect(await q<number>(v, `const b = [...document.querySelectorAll(".pl-chips .mr-f")].map(x => Math.round(x.getBoundingClientRect().top)); return new Set(b).size`)).toBe(1);
	await shot(v, "05-list-overview-1280.png");
	await run(v, `document.querySelector('.pm-sec [data-k="sessions"]').click()`);
	await waitFor(v, `!!document.querySelector(".pdv .srows")`);
	await shot(v, "06-sessions-1280.png");
	await run(v, `document.querySelector(".pdv .pdv-back").click()`);
	await waitFor(v, `!document.querySelector(".pdv")`);
	// dark mode, same list
	await run(v, `dotzTheme.toggle()`);
	await run(v, `go("projects")`);
	await waitFor(v, `document.querySelector(".pl-row")`);
	await shot(v, "07-list-1280-dark.png");
});
