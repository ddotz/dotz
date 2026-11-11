import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The two-column frame (web/css/01-tokens.css --frame-*): 채팅 and 프로젝트 draw their left column and their content column with the same boxes,
// and both fall back to one column at the same window width. The two tabs' measured boxes are compared with each other, never with a pinned number.
// Run in a headless Bun.WebView against a stub gateway with placeholder names.
const AT = "2026-10-25T09:00:00.000Z", AT_MS = Date.parse(AT);
const projects = [1, 2].map(n => ({
	key: `ch:${8000 + n}`, channel: { id: String(8000 + n), name: `프로젝트 ${n}` }, name: `프로젝트 ${n}`, pinned: false, recordKey: `ch:${8000 + n}`,
	record: { title: `프로젝트 ${n}`, purpose: `${n}번째 프로젝트`, updated: AT, milestones: [] },
	lanes: [{ name: `lane-${n}`, title: `작업 세션 ${n}`, status: "working", live: true, startedAt: AT, lastText: "작업 중" }],
}));
const builtin = { key: "builtin:custom", name: "커스텀", note: "내 취향대로 바꾼 것", pinned: true, builtin: true, lanes: [] };
const detail = (p: (typeof projects)[number]) => ({
	key: p.key, record: p.record, monitors: [], routines: [], schedules: [],
	lanes: p.lanes.map(l => ({ name: l.name, title: l.title, status: l.status, live: l.live, finishedAt: AT, line: "마지막 줄" })),
	work: [{ id: "bw1", description: "폴더 정리", status: "done", started_at: AT_MS, ended_at: AT_MS }],
	results: [{ kind: "commit", at: AT, title: "커밋 제목", hash: "abc1234" }],
	summary: { lanes: 1, running: 0, waiting: 0, lastActivity: AT },
});
const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: projects.flatMap(x => x.lanes.map(l => ({ ...l, cwd: `/tmp/${x.key}`, home: x.key }))), terminals: {}, channels: { work: {}, homes: {}, lanes: {}, threads: {} }, discord: {}, notices_unread: 0 });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [builtin, ...projects], routines: [], links: [] });
		if (p === "/api/custom/project") {
			if (url.searchParams.get("key") === builtin.key) return json({ groups: [{ id: "rules", label: "내 규칙", empty: "없어요", items: ["하나", "둘"].map(n => ({ title: `규칙 ${n}`, full: `규칙 ${n}의 원문` })) }] });
			const x = projects.find(q => q.key === url.searchParams.get("key"));
			return x ? json(detail(x)) : json({ error: "not found" }, 404);
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

type Box = { x: number; w: number; t: number } | null;
type Frame = { left: Box; content: Box; right: number | null; twoCols: boolean };
const frame = async (v: View, left: string, content: string): Promise<Frame> => {
	const raw = await v.evaluate(`(() => {
		for (const a of document.getAnimations()) { try { a.finish(); } catch {} }
		const B = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left, w: r.width, t: r.top } : null; };
		const L = B(${JSON.stringify(left)}), C = B(${JSON.stringify(content)});
		return JSON.stringify({ L, C, vw: document.documentElement.clientWidth });
	})()`) as string;
	const { L, C, vw } = JSON.parse(raw) as { L: Box; C: Box; vw: number };
	return { left: L, content: C, right: C ? vw - C.x - C.w : null, twoCols: !!L && !!C && C.x >= L.x + L.w };
};
const boot = async (v: View): Promise<View> => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S`);
	return v;
};
const chatFrame = async (v: View) => {
	await run(v, `go("chat")`);
	await waitFor(v, `document.querySelector("#v-chat .cv-row") && document.querySelector("#v-chat > .cv-head")`);
	return frame(v, "#v-chat > .cv-side", "#v-chat > .cv-head");
};
const projectFrame = async (v: View) => {
	await run(v, `go("project", "${projects[0].key}")`);
	await waitFor(v, `document.querySelector("#v-projects .pl-row") && document.querySelectorAll("#v-project .pm-sec").length >= 2`);
	return frame(v, "#v-projects", "#v-project");
};

// The WebViews are started in the describe body (collection time, on no test's clock): the first start of a process is the slow one. One view per
// window width, since the width is what differs; the tests of a width share it and each navigates it again (a navigation resets the page).
describe("frame", async () => {
const views: Record<number, View> = {};
for (const width of [1099, 1100, 1280, 1920]) views[width] = await hub.view({ width, height: 900 });
// new Bun.WebView() is lazy: the browser backend starts with the first navigation (~1 s under load), so that navigation is made here, not in a test.
for (const v of Object.values(views)) await v.navigate("about:blank");

for (const width of [1280, 1920]) {
	test(`at ${width}px 프로젝트 uses the left column, content column and right edge of 채팅`, async () => {
		const v = await boot(views[width]);
		const chat = await chatFrame(v);
		const project = await projectFrame(v);
		expect(chat.twoCols).toBe(true);
		expect(project.twoCols).toBe(true);
		expect(project.left).toEqual(chat.left);
		expect(project.content).toEqual(chat.content);
		expect(project.right).toBe(chat.right);
	});

	test(`at ${width}px a project's drill-in page and the 커스텀 page sit in the same content box`, async () => {
		const v = await boot(views[width]);
		const chat = await chatFrame(v);
		const project = await projectFrame(v);
		await run(v, `document.querySelector('.pm-sec [data-k="sessions"]').click()`);
		await waitFor(v, `document.querySelector(".fs-card.pdv:not([aria-hidden]) .srows")`);
		const drill = await frame(v, "#v-projects", ".fs-card.pdv");
		expect(drill.content).toEqual(chat.content);
		expect(drill.right).toBe(chat.right);
		await run(v, `document.querySelector(".pdv .pdv-back").click()`);
		await waitFor(v, `!document.querySelector(".pdv")`);
		await run(v, `go("project", "builtin:custom")`);
		await waitFor(v, `document.querySelector("#v-project .pmv-title")?.textContent === "커스텀"`);
		const custom = await frame(v, "#v-projects", "#v-project");
		expect(custom.left).toEqual(project.left);
		expect(custom.content).toEqual(project.content);
	});
}

test("채팅 and 프로젝트 fall back to one column at the same window width", async () => {
	const cols: Record<number, [boolean, boolean]> = {};
	for (const width of [1099, 1100]) {
		const v = await boot(views[width]);
		const chat = await chatFrame(v);
		// below the breakpoint 프로젝트 is its own list screen, then the project; wide it is the list beside the open project
		await run(v, `go("projects")`);
		await waitFor(v, `document.querySelector(".pl-row")`);
		const project = await frame(v, "#v-projects", "#v-project");
		cols[width] = [chat.twoCols, project.twoCols];
	}
	expect(cols[1099]).toEqual([false, false]);
	expect(cols[1100]).toEqual([true, true]);
});
});
