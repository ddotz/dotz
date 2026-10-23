import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, now } from "./config.ts";
import { emit } from "./events.ts";
import { countChannelNotices } from "./notices.ts";
import { deleteProject, type DeleteDeps, planDelete, ProjectDeleteError } from "./projectdelete.ts";
import { loadProjects, removeProject, saveProject } from "./projects.ts";
import { allWatches } from "./watch.ts";
import { clearChannel, getSetup, setupChannel } from "./workchannels.ts";

let removed: string[];
let running: Record<string, string[]>;
let failWith: string | undefined;
const deps: DeleteDeps = {
	work: () => ({ "7001": "유튜브", "7002": "메일" }),
	builtin: () => ({ "111": "chat", "112": "worklog", "113": "alert", "114": "dm" }),
	running: id => running[id] ?? [],
	removeChannel: async id => {
		removed.push(id);
		if (failWith) throw new Error(failWith);
	},
};
const archiveFile = join(DATA_DIR, "archive", "projects", "유튜브-7001.jsonl");

function seed() {
	setupChannel({ channel: "7001", purpose: "유튜브 채널 관리", standing: "새 영상 알림", basis: "알려 줘", monitors: [{ command: "echo hi", every_minutes: 60, on: "change" }], logins: [{ session_url: "https://example.test/studio" }] }, "유튜브", "");
	saveProject({ key: "ch:7001", title: "유튜브" });
	emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target: "ch:7001", text: "영상 두 개가 올라왔어요" });
}

beforeEach(() => {
	removed = [];
	running = {};
	failWith = undefined;
	rmSync(join(DATA_DIR, "archive"), { recursive: true, force: true });
	clearChannel("7001");
});

afterAll(() => {
	clearChannel("7001");
	removeProject("ch:7001");
});

test("delete drops the setup's watches, the notices and the list entry, calls the Discord delete once and archives the conversation", async () => {
	seed();
	const plan = planDelete("ch:7001", deps);
	expect(plan).toMatchObject({ name: "유튜브", standing: "새 영상 알림", notices: 1, running: [], archive: archiveFile });
	expect(plan.monitors).toHaveLength(1);
	expect(plan.logins).toEqual([{ name: expect.stringMatching(/^login-/), shared: false }]);
	expect(allWatches().filter(w => w.channels?.includes("7001"))).toHaveLength(2);
	const r = await deleteProject("ch:7001", {}, deps);
	expect(r).toMatchObject({ ok: true, channel: "ch:7001", name: "유튜브", removed: { monitors: 1, logins: 1, notices: 1 }, archive: archiveFile, discord: { ok: true } });
	expect(removed).toEqual(["7001"]);
	expect(allWatches().filter(w => w.channels?.includes("7001"))).toHaveLength(0);
	expect(getSetup("7001")).toBeUndefined();
	expect(countChannelNotices("ch:7001")).toBe(0);
	expect(loadProjects()["ch:7001"]).toBeUndefined();
	const lines = readFileSync(archiveFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
	expect(lines[0].project).toMatchObject({ channel: "ch:7001", name: "유튜브" });
	expect(lines.some(l => l.text === "영상 두 개가 올라왔어요")).toBe(true);
});

test("archive:false writes no archive file", async () => {
	seed();
	const r = await deleteProject("ch:7001", { archive: false }, deps);
	expect(r.archive).toBeNull();
	expect(existsSync(archiveFile)).toBe(false);
	expect(removed).toEqual(["7001"]);
});

test("a Discord failure does not stop the delete; the result carries the error", async () => {
	seed();
	failWith = "discord DELETE /channels/7001: 403 Missing Permissions";
	const r = await deleteProject("ch:7001", {}, deps);
	expect(r.discord).toEqual({ ok: false, error: failWith });
	expect(getSetup("7001")).toBeUndefined();
	expect(countChannelNotices("ch:7001")).toBe(0);
});

test("the built-in channels, a channel-less project and an unknown channel are refused, and nothing is removed", async () => {
	seed();
	for (const key of ["chat", "worklog", "alert", "dm", "ch:111", "111", "ch:114"]) {
		const e = await deleteProject(key, {}, deps).catch(x => x);
		expect(e).toBeInstanceOf(ProjectDeleteError);
		expect(e.status).toBe(409);
		expect(e.message).toContain("기본 채널");
	}
	expect((await deleteProject("dir:/tmp/x", {}, deps).catch(x => x)).status).toBe(409);
	expect((await deleteProject("ch:999", {}, deps).catch(x => x)).status).toBe(404);
	expect(removed).toEqual([]);
	expect(getSetup("7001")).toBeDefined();
});

test("a channel with a running session is refused and the session is named", async () => {
	seed();
	running["7001"] = ["yt-upload", "yt-edit"];
	const e = await deleteProject("ch:7001", {}, deps).catch(x => x);
	expect(e).toBeInstanceOf(ProjectDeleteError);
	expect(e.status).toBe(409);
	expect(e.message).toContain("yt-upload, yt-edit");
	expect(removed).toEqual([]);
	expect(getSetup("7001")).toBeDefined();
	expect(existsSync(archiveFile)).toBe(false);
});
