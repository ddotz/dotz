// Stored project records (hub/projects.ts, docs/layers.md §4): merge, validation, and the purpose edit that also updates the
// work channel setup.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { loadProjects, MAX_MILESTONES, MAX_TITLE, saveProject } from "./projects.ts";
import { clearChannel, getSetup, setupChannel } from "./workchannels.ts";

const FILE = join(DATA_DIR, "projects.json");
beforeEach(() => rmSync(FILE, { force: true }));

test("no file is no records; a save trims strings, keeps fields not given and stamps updated", () => {
	expect(loadProjects()).toEqual({});
	const first = saveProject({ key: "ch:5", title: "  메일 자동답장 ", purpose: "새 메일에 답해요", milestones: [{ text: "감시 등록 ", done: true }, { text: "답장 규칙" }] });
	expect(first.record).toMatchObject({ title: "메일 자동답장", purpose: "새 메일에 답해요", milestones: [{ text: "감시 등록", done: true }, { text: "답장 규칙", done: false }] });
	const second = saveProject({ key: "ch:5", goal: "회사 메일 응답 자동화", paused: true });
	expect(second.record).toMatchObject({ title: "메일 자동답장", goal: "회사 메일 응답 자동화", paused: true });
	expect(second.record.milestones).toHaveLength(2);
	expect(JSON.parse(readFileSync(FILE, "utf8")).projects["ch:5"]).toEqual(second.record);
	expect(saveProject({ key: "dir:~/Code/x", title: "다른 것" }).record.title).toBe("다른 것");
	expect(Object.keys(loadProjects()).sort()).toEqual(["ch:5", "dir:~/Code/x"]);
});

test("an empty string clears a text field so the derived value shows again", () => {
	saveProject({ key: "ch:5", title: "제목", goal: "목표" });
	const record = saveProject({ key: "ch:5", title: "  " }).record;
	expect(record.title).toBeUndefined();
	expect(record.goal).toBe("목표");
});

test("a bad key, a long title, too many milestones or a wrong type is refused and writes nothing", () => {
	const bad: Array<[Record<string, unknown>, string]> = [
		[{ key: "lane:x", title: "a" }, "key"],
		[{ title: "a" }, "key"],
		[{ key: "ch:5", title: "x".repeat(MAX_TITLE + 1) }, "title"],
		[{ key: "ch:5", title: 7 }, "title"],
		[{ key: "ch:5", milestones: Array.from({ length: MAX_MILESTONES + 1 }, () => ({ text: "a", done: false })) }, "milestones"],
		[{ key: "ch:5", milestones: [{ text: " ", done: false }] }, "milestones[0]"],
		[{ key: "ch:5", milestones: "nope" }, "milestones"],
		[{ key: "ch:5", paused: "yes" }, "paused"],
	];
	for (const [input, word] of bad) expect(() => saveProject(input)).toThrow(word);
	expect(existsSync(FILE)).toBe(false);
	expect(saveProject({ key: "ch:5", title: "x".repeat(MAX_TITLE) }).record.title).toHaveLength(MAX_TITLE);
});

test("editing the purpose of a ch:<id> project also updates its work channel setup; a dir project has none", () => {
	setupChannel({ channel: "ch:7001", purpose: "예전 목적" }, "메일", "");
	try {
		saveProject({ key: "ch:7001", title: "메일", purpose: "새 목적" });
		expect(getSetup("7001")?.purpose).toBe("새 목적");
		saveProject({ key: "ch:7001", goal: "목표만" });
		expect(getSetup("7001")?.purpose).toBe("새 목적");
		expect(() => saveProject({ key: "ch:7002", purpose: "설정 없는 채널" })).not.toThrow();
		expect(getSetup("7002")).toBeUndefined();
	} finally {
		clearChannel("7001");
	}
});
