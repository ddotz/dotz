import { afterAll, expect, test } from "bun:test";
import { projectsView } from "./custom.ts";
import { ev, fakeHub, idleState, json, type View, waitFor } from "./test-web.ts";

// One session, one project on every web surface: the real resolver's output served to the shipped page at 390px, against a stub gateway.
const work = { "7001": "기획팀", "7002": "지원리뷰" };
const lane = (name: string, extra: object) => ({ name, title: name, cwd: "/h/shared", status: "idle", live: true, reports: 0, startedAt: "2026-11-01T00:00:00Z", ...extra });
const lanes = [lane("homed", { home: "ch:7001", project: "기획팀" }), lane("rival", { home: "ch:7002", project: "지원리뷰" }), lane("folderOnly", { cwd: "/h/alone" })];
const projects = projectsView({ lanes, channels: { work }, pins: { projects: [], hide_projects: [], routines: [], links: [] }, home: "/h", tmpDirs: [] });
const hub = fakeHub({
	stream: "fake",
	state: idleState({ channels: { work }, lanes }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects, routines: [], links: [], errors: [] });
		if (p === "/api/custom/project") return json({ key: url.searchParams.get("key"), monitors: [], lanes: [], work: [], results: [], routines: [], schedules: [], watches: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => hub.stop());

async function boot(): Promise<View> {
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/`);
	await hub.streamConnected(1);
	await waitFor(v, `typeof S !== "undefined" && S && S.lanes.length === 3`);
	await v.evaluate("void prjLoad()");
	await waitFor(v, "PRJ && PRJ.projects.length > 0");
	return v;
}

test("a homed session shows its home project everywhere, a session with no home its folder's", async () => {
	const v = await boot();
	const onPage = (name: string, project: string) => ev<Record<string, unknown>>(v, `(() => {
		const l = S.lanes.find(x => x.name === "${name}"), p = PRJ.projects.find(x => x.name === "${project}");
		return { label: laneProject(l), notice: ntLaneNote({ key: "lane:${name}" }).split(" · ")[0], rows: pmSessionRows(p, null).map(r => r.name + ":" + r.project), row: sessionRow(l).querySelector(".sproj").textContent, chat: laneChat(l) };
	})()`);
	expect(await onPage("homed", "기획팀")).toMatchObject({ label: "기획팀", notice: "기획팀", rows: ["homed:기획팀"], row: "기획팀", chat: "ch:7001" });
	expect(await onPage("rival", "지원리뷰")).toMatchObject({ label: "지원리뷰", notice: "지원리뷰", rows: ["rival:지원리뷰"], row: "지원리뷰", chat: "ch:7002" });
	const alone = projects.find(p => p.key === "dir:~/alone")!.name;
	expect(await onPage("folderOnly", alone)).toMatchObject({ label: alone, notice: alone, rows: [`folderOnly:${alone}`], row: alone, chat: "" });
	const rows = await ev<string[]>(v, `(() => { renderBars(); const d = document.querySelector(".thead .tdrop"); return d ? d._items().map(i => i.header || i.value) : []; })()`);
	expect(rows.indexOf("lane:homed")).toBe(rows.indexOf("ch:7001") + 1);
	expect(rows.indexOf("lane:rival")).toBe(rows.indexOf("ch:7002") + 1);
	expect(rows.indexOf("lane:folderOnly")).toBeGreaterThan(rows.indexOf("프로젝트 없음"));
});
