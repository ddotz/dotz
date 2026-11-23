import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor } from "./test-web.ts";

// 모니터링 lists a monitor under the section its hub-sent `scope` names: an app's under the app, a project's in its own 프로젝트 group, 일반 모니터링 only for the unowned;
// internal housekeeping stays out of sight until it fails. Headless.
const CH = "1500000000001908448";
const mon = (watch: string, name: string, extra: object = {}) => ({ name, watch, kind: "watch", last_run: "2026-10-23T03:00:00Z", last_result: "ok", every: "30분마다", fails: 0, connection: "connected", ...extra });
const app = { key: "mail", label: "메일", kind: "app", icon: "mail", app: "mail", conv: ["mail:"], unread: 0, unreplied: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } };
let monitors: object[] = [];
const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/monitors") return json({ items: monitors });
		if (p === "/api/integrations") return json({ items: [app] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: {} }, discord: {}, notices_unread: 0 });
	},
});
afterAll(() => hub.stop());

async function rows(list: object[]): Promise<string[]> {
	monitors = list;
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `S && NM.loaded && INTG.items.length`);
	return ev<string[]>(v, `monRows(monItems(), null).map(r => r.header || (r.fold ? r.k : r.name))`);
}

test("an app's, a project's and a plain monitor each land in their own section (S8: the plain ones under 모니터링, a project after them)", async () => {
	const list = await rows([
		mon("reply-library-icloud", "첨부 폴더 iCloud 내려받기", { scope: "app", app: "mail" }),
		mon("ch-1-1", "dotz PR 감시", { channel: `ch:${CH}`, scope: "project", project: `ch:${CH}`, project_title: "dotz", last_result: "fail", fails: 1 }),
		mon("disk-check", "디스크 점검", { scope: "plain", last_result: "fail", fails: 1 }),
	]);
	expect(list).toEqual(["승인 대기", "메일", "앱 관리", "모니터링", "디스크 점검", "프로젝트 · dotz", "dotz PR 감시"]);
});

test("a fine watch of a project folds under that project's group, a fine plain one under 모니터링, an app's own watch has no row (S8)", async () => {
	const list = await rows([
		mon("reply-library-icloud", "첨부 폴더 iCloud 내려받기", { scope: "app", app: "mail" }),
		mon("ch-1-1", "dotz PR 감시", { channel: `ch:${CH}`, scope: "project", project: `ch:${CH}`, project_title: "dotz" }),
		mon("disk-check", "디스크 점검", { scope: "plain" }),
	]);
	expect(list).toEqual(["승인 대기", "메일", "앱 관리", "모니터링", "fold:일반 모니터링", "프로젝트 · dotz", "fold:프로젝트 · dotz"]);
});

test("an internal monitor is hidden while it is fine and listed as plain once it fails", async () => {
	const fine = await rows([mon("omonyang-housekeeping", "리뷰 스레드 정리", { scope: "internal" })]);
	expect(fine.slice(fine.indexOf("모니터링") + 1)).toEqual([]);
	const failing = await rows([mon("omonyang-housekeeping", "리뷰 스레드 정리", { scope: "internal", last_result: "fail", fails: 3 })]);
	expect(failing.slice(failing.indexOf("모니터링") + 1)).toEqual(["리뷰 스레드 정리"]);
});

test("a hub that sends no scope lists every monitor as plain: a fine one folds under 모니터링 (S8)", async () => {
	const list = await rows([mon("disk-check", "디스크 점검")]);
	expect(list.slice(list.indexOf("모니터링") + 1)).toEqual(["fold:일반 모니터링"]);
	expect(list.some(r => r.startsWith("프로젝트"))).toBe(false);
});
