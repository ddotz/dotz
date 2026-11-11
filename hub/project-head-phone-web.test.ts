import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The project screen's head card (web/css/08-project-sessions.css, pmHead): on a phone the app bar already shows the project name, so the card
// does not write it again as a title block, and the content under it starts higher. Renaming stays one tap away (the ⋯ menu's 수정). At 1280 the
// card keeps the boxes it always had. Boxes only, never wording. Run in a headless Bun.WebView against a stub gateway with placeholder names.
const AT = "2026-10-25T09:00:00.000Z", AT_MS = Date.parse(AT);
const project = {
	key: "ch:8001", channel: { id: "8001", name: "프로젝트 1" }, name: "프로젝트 1", pinned: false, recordKey: "ch:8001",
	record: { title: "프로젝트 1", purpose: "첫 번째 프로젝트", updated: AT, milestones: [] },
	lanes: [{ name: "lane-1", title: "작업 세션 1", status: "working", live: true, startedAt: AT, lastText: "작업 중" }],
};
const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: project.lanes.map(l => ({ ...l, cwd: `/tmp/${project.key}`, home: project.key })), terminals: {}, channels: { work: {}, homes: {}, lanes: {}, threads: {} }, discord: {}, notices_unread: 0 });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [project], routines: [], links: [] });
		if (p === "/api/custom/project") {
			return json({
				key: project.key, record: project.record, monitors: [], routines: [], schedules: [],
				lanes: project.lanes.map(l => ({ name: l.name, title: l.title, status: l.status, live: l.live, finishedAt: AT, line: "마지막 줄" })),
				work: [{ id: "bw1", description: "폴더 정리", status: "done", started_at: AT_MS, ended_at: AT_MS }],
				results: [{ kind: "commit", at: AT, title: "커밋 제목", hash: "abc1234" }],
				summary: { lanes: 1, running: 0, waiting: 0, lastActivity: AT },
			});
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [{ ts: AT, kind: "out", source: "orchestrator", text: "안녕하세요, 데모 대화예요." }] });
		if (p === "/api/conversations") return json({ items: [{ target: "web", name: "웹", preview: "안녕하세요", ts: AT }] });
		if (p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/todo" || p === "/api/activity") return json({ items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

type Box = { x: number; y: number; w: number; h: number } | null;
const SELS = { head: ".pmv-head", hmain: ".pmv-hmain", htop: ".pmv-htop", title: ".pmv-title", purpose: ".pmv-purpose", hact: ".pmv-hact", chat: ".pmv-hrow .btn", more: ".pmv-more", tag: ".pmv-htop .tag", upd: ".pmv-upd", first: ".pm-o > *" };
const boxes = async (v: View): Promise<Record<keyof typeof SELS, Box>> => JSON.parse(await v.evaluate(`(() => {
	for (const a of document.getAnimations()) { try { a.finish(); } catch {} }
	const o = {};
	for (const [k, s] of Object.entries(${JSON.stringify(SELS)})) {
		const e = document.querySelector("#v-project " + s);
		const r = e && e.getBoundingClientRect();
		o[k] = r && (r.width || r.height) ? { x: Math.round(r.left * 2) / 2, y: Math.round(r.top * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2 } : null;
	}
	return JSON.stringify(o);
})()`) as string);
const open = async (width: number): Promise<View> => {
	const v = await hub.view({ width, height: 900 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S`);
	await run(v, `go("project", "${project.key}")`);
	await waitFor(v, `document.querySelector("#v-project .pmv-head") && document.querySelectorAll("#v-project .pm-sec").length >= 2`);
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running" || (a.effect && a.effect.getTiming().iterations === Infinity))`);
	return v;
};

// Measured on origin/main (the fixture above): the first row under the head at 390, and the card at 1280.
const BEFORE_FIRST_Y_390 = 242, BEFORE_HTOP_H_390 = 32;
const WIDE_1280 = {"head":{"x":616,"y":68,"w":636,"h":100},"hmain":{"x":636,"y":88,"w":422,"h":60},"htop":{"x":636,"y":88,"w":422,"h":32},"title":{"x":628,"y":88,"w":246,"h":32},"purpose":{"x":628,"y":124,"w":438,"h":24},"hact":{"x":1074,"y":88,"w":158,"h":40},"chat":{"x":1074,"y":90,"w":110,"h":36},"more":{"x":1192,"y":88,"w":40,"h":40},"tag":{"x":874,"y":94,"w":43.5,"h":20},"upd":{"x":925.5,"y":96,"w":132.5,"h":16},"first":{"x":616,"y":184,"w":636,"h":96}};

test("at 390px the head does not repeat the name as a title block and the content starts higher", async () => {
	const v = await open(390);
	const b = await boxes(v);
	expect(b.title).toBeNull();
	expect(b.more).not.toBeNull();
	expect(b.first!.y).toBeLessThanOrEqual(BEFORE_FIRST_Y_390 - 10);
	expect(b.htop?.h ?? 0).toBeLessThan(BEFORE_HTOP_H_390);
});

test("at 390px the ⋯ menu still opens the name field, in the head and in reach", async () => {
	const v = await open(390);
	await run(v, `document.querySelector("#v-project .pmv-more").click()`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `document.querySelector(".menu .mi").click()`);
	await waitFor(v, `document.querySelector("#v-project .pmv-head .pmv-form input")`);
	const r = JSON.parse(await v.evaluate(`(() => { const f = document.querySelector("#v-project .pmv-head .pmv-form input").getBoundingClientRect(), h = document.querySelector("#v-project .pmv-head").getBoundingClientRect(); return JSON.stringify({ fl: f.left, fr: f.right, ft: f.top, fb: f.bottom, hl: h.left, hr: h.right, ht: h.top, hb: h.bottom, vw: document.documentElement.clientWidth }); })()`) as string);
	expect(r.fl).toBeGreaterThanOrEqual(r.hl);
	expect(r.fr).toBeLessThanOrEqual(r.hr);
	expect(r.ft).toBeGreaterThanOrEqual(r.ht);
	expect(r.fb).toBeLessThanOrEqual(r.hb);
});

test("at 1280px the head keeps the boxes it had", async () => {
	const v = await open(1280);
	const b = await boxes(v);
	expect(b).toEqual(WIDE_1280);
});
