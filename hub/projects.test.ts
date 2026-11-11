// Stored project records (hub/projects.ts, docs/layers.md §4): merge, validation, and the purpose edit that also updates the
// work channel setup.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { loadProjects, MAX_TITLE, saveProject } from "./projects.ts";
import { clearChannel, getSetup, setupChannel } from "./workchannels.ts";

const FILE = join(DATA_DIR, "projects.json");
beforeEach(() => rmSync(FILE, { force: true }));

test("no file is no records; a save trims strings, keeps fields not given and stamps updated", () => {
	expect(loadProjects()).toEqual({});
	const first = saveProject({ key: "ch:5", title: "  메일 자동답장 ", purpose: "새 메일에 답해요" });
	expect(first.record).toMatchObject({ title: "메일 자동답장", purpose: "새 메일에 답해요" });
	const second = saveProject({ key: "ch:5", paused: true });
	expect(second.record).toMatchObject({ title: "메일 자동답장", purpose: "새 메일에 답해요", paused: true });
	expect(JSON.parse(readFileSync(FILE, "utf8")).projects["ch:5"]).toEqual(second.record);
	expect(saveProject({ key: "dir:~/Code/x", title: "다른 것" }).record.title).toBe("다른 것");
	expect(Object.keys(loadProjects()).sort()).toEqual(["ch:5", "dir:~/Code/x"]);
});

test("an empty string clears a text field so the derived value shows again", () => {
	saveProject({ key: "ch:5", title: "제목", purpose: "목적" });
	const record = saveProject({ key: "ch:5", title: "  " }).record;
	expect(record.title).toBeUndefined();
	expect(record.purpose).toBe("목적");
});

test("a bad key, a long title or a wrong type is refused and writes nothing", () => {
	const bad: Array<[Record<string, unknown>, string]> = [
		[{ key: "lane:x", title: "a" }, "key"],
		[{ title: "a" }, "key"],
		[{ key: "ch:5", title: "x".repeat(MAX_TITLE + 1) }, "title"],
		[{ key: "ch:5", title: 7 }, "title"],
		[{ key: "ch:5", paused: "yes" }, "paused"],
	];
	for (const [input, word] of bad) expect(() => saveProject(input)).toThrow(word);
	expect(existsSync(FILE)).toBe(false);
	expect(saveProject({ key: "ch:5", title: "x".repeat(MAX_TITLE) }).record.title).toHaveLength(MAX_TITLE);
});

test("a stored record with goal and milestones still loads, and a write that sends them neither fails nor changes them", () => {
	mkdirSync(DATA_DIR, { recursive: true });
	const old = { title: "옛 기록", goal: "목표", milestones: [{ text: "하나", done: true }], updated: "2026-10-21T00:00:00Z" };
	writeFileSync(FILE, JSON.stringify({ projects: { "ch:5": old } }));
	expect(loadProjects()["ch:5"]).toEqual(old);
	const { record } = saveProject({ key: "ch:5", title: "새 이름", goal: 7, milestones: "nope" });
	expect(record).toMatchObject({ title: "새 이름", goal: "목표", milestones: old.milestones });
	expect(JSON.parse(readFileSync(FILE, "utf8")).projects["ch:5"]).toEqual(record);
});

test("editing the purpose of a ch:<id> project also updates its work channel setup; a dir project has none", () => {
	setupChannel({ channel: "ch:7001", purpose: "예전 목적" }, "메일", "");
	try {
		saveProject({ key: "ch:7001", title: "메일", purpose: "새 목적" });
		expect(getSetup("7001")?.purpose).toBe("새 목적");
		saveProject({ key: "ch:7001", title: "이름만" });
		expect(getSetup("7001")?.purpose).toBe("새 목적");
		expect(() => saveProject({ key: "ch:7002", purpose: "설정 없는 채널" })).not.toThrow();
		expect(getSetup("7002")).toBeUndefined();
	} finally {
		clearChannel("7001");
	}
});
