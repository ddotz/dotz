import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, run, waitFor } from "./test-web.ts";

// 모니터링 lists a monitor under the section its hub-sent `scope` names: an app's under the app, a project's in its own 프로젝트 group, 일반 모니터링 only for the unowned;
// internal housekeeping stays out of sight until it fails. Headless.
const CH = "1561565203714408448";
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
	return ev<string[]>(v, `monRows(monItems(), null).map(r => r.header || r.name)`);
}

test("an app's, a project's and a plain monitor each land in their own section", async () => {
	const list = await rows([
		mon("reply-library-icloud", "첨부 폴더 iCloud 내려받기", { scope: "app", app: "mail" }),
		mon("ch-1-1", "dotz PR 감시", { channel: `ch:${CH}`, scope: "project", project: `ch:${CH}`, project_title: "dotz" }),
		mon("disk-check", "디스크 점검", { scope: "plain" }),
	]);
	const at = (s: string) => list.indexOf(s);
	expect(at("앱")).toBeGreaterThanOrEqual(0);
	expect(at("메일")).toBeGreaterThan(at("앱"));
	expect(at("앱 관리")).toBeGreaterThan(at("메일"));
	expect(at("프로젝트 · dotz")).toBeGreaterThan(at("앱 관리"));
	expect(at("dotz PR 감시")).toBe(at("프로젝트 · dotz") + 1);
	expect(at("일반 모니터링")).toBeGreaterThan(at("dotz PR 감시"));
	expect(list.slice(at("일반 모니터링") + 1)).toEqual(["디스크 점검"]);
	expect(list).not.toContain("첨부 폴더 iCloud 내려받기");
});

test("an internal monitor is hidden while it is fine and listed as plain once it fails", async () => {
	const fine = await rows([mon("omonyang-housekeeping", "리뷰 스레드 정리", { scope: "internal" })]);
	expect(fine).not.toContain("리뷰 스레드 정리");
	const failing = await rows([mon("omonyang-housekeeping", "리뷰 스레드 정리", { scope: "internal", last_result: "fail", fails: 3 })]);
	expect(failing.slice(failing.indexOf("일반 모니터링") + 1)).toEqual(["리뷰 스레드 정리"]);
});

test("a hub that sends no scope lists every monitor as plain", async () => {
	const list = await rows([mon("disk-check", "디스크 점검")]);
	expect(list.slice(list.indexOf("일반 모니터링") + 1)).toEqual(["디스크 점검"]);
	expect(list.some(r => r.startsWith("프로젝트"))).toBe(false);
});
