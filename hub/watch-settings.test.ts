import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseProposal, setDiscordProbe } from "./app-settings.ts";
import { paths } from "./config.ts";
import { WATCH_FIELDS, readWatchSettings, watchOfSubject, watchSettingsContext, writeWatchSettings } from "./watch-settings.ts";
import { addWatch, allWatches, removeWatch, startWatches } from "./watch.ts";

// A monitor's settings use the app-settings schema format; the one write path ends in patchWatch.
beforeAll(() => startWatches(() => {}));
afterEach(() => { for (const w of allWatches()) removeWatch(w.id); });
const stored = (name: string) => JSON.parse(readFileSync(paths.watches, "utf8")).find((w: { name: string }) => w.name === name);
const make = () => addWatch({ name: "t-set", command: "true", every_minutes: 60, on: "change", to: "alert", label: "테스트 감시" }, "");
const val = (name: string) => Object.fromEntries(readWatchSettings(name).map(f => [f.key, f.value]));

test("the fields read the watch's own values; the common ones are controls above the conversation", () => {
	make();
	expect(val("t-set")).toEqual({ enabled: true, every_minutes: 60, to: "alert", label: "테스트 감시", notify: true, push: true });
	expect(WATCH_FIELDS.filter(f => f.switch).map(f => f.key)).toEqual(["enabled", "every_minutes", "to", "label"]);
	// The screen's sections: 알림, 감시, then the rest (the web draws them in this order).
	expect(WATCH_FIELDS.map(f => [f.key, f.section])).toEqual([["enabled", "watch"], ["every_minutes", "watch"], ["to", "notify"], ["label", "advanced"]]);
	expect(watchOfSubject("w:t-set")).toBe("t-set");
	expect(watchOfSubject("w:nope")).toBeUndefined();
	expect(watchOfSubject("mail")).toBeUndefined();
});

test("PATCH writes through patchWatch: pause, interval, notice route and label", () => {
	make();
	writeWatchSettings("t-set", { enabled: false });
	expect(stored("t-set").paused).toBe(true);
	expect(val("t-set").enabled).toBe(false);
	writeWatchSettings("t-set", { enabled: true, every_minutes: 30, to: "chat", label: "  새 이름 " });
	expect(stored("t-set")).toMatchObject({ every_minutes: 30, to: "chat", label: "새 이름" });
	expect(stored("t-set").paused).toBeUndefined();
});

test("알림 switches: 새 소식 알림 and 휴대폰 알림 are stored on the watch only when off; 디스코드에도 보내기 only while Discord is connected", () => {
	make();
	expect(readWatchSettings("t-set").filter(f => f.section === "notify").map(f => f.key)).toEqual(["to", "notify", "push"]);
	writeWatchSettings("t-set", { notify: false, push: false });
	expect(stored("t-set")).toMatchObject({ notify: false, push: false });
	writeWatchSettings("t-set", { notify: true });
	expect(stored("t-set").notify).toBeUndefined();
	expect(() => writeWatchSettings("t-set", { discord: false })).toThrow();
	setDiscordProbe(() => true);
	try {
		expect(readWatchSettings("t-set").map(f => f.key)).toContain("discord");
		writeWatchSettings("t-set", { discord: false });
		expect(stored("t-set").discord).toBe(false);
		expect(val("t-set").discord).toBe(false);
	} finally {
		setDiscordProbe(() => false);
	}
});

test("a bad value or an unknown key rejects the whole set and writes nothing", () => {
	make();
	for (const bad of [{ every_minutes: 0 }, { every_minutes: 2.5 }, { every_minutes: "5" }, { every_minutes: 10081 }, { to: "email" }, { enabled: "yes" }, { label: 5 }, { pattern: "x" }, {}, null]) expect(() => writeWatchSettings("t-set", bad)).toThrow();
	expect(() => writeWatchSettings("t-set", { every_minutes: 5, to: "email" })).toThrow();
	expect(stored("t-set")).toMatchObject({ every_minutes: 60, to: "alert", label: "테스트 감시" });
	expect(() => writeWatchSettings("nope", { enabled: false })).toThrow("no watch");
});

test("the orchestrator gets only this monitor's schema and values; a proposal is parsed but never applied", () => {
	make();
	const ctx = watchSettingsContext("t-set");
	expect(ctx).toContain("[settings:w:t-set]");
	for (const k of ["enabled", "every_minutes", "to", "label"]) expect(ctx).toContain(`${k} | `);
	expect(ctx).toContain("every_minutes | number | 감시 주기(분) | 60");
	const answer = "30분마다로 바꿀게요.\n```dotz-settings\n" + JSON.stringify({ app: "w:t-set", changes: { every_minutes: 30 } }) + "\n```";
	expect(parseProposal(answer, "w:t-set", WATCH_FIELDS)).toEqual({ app: "w:t-set", changes: { every_minutes: 30 } });
	expect(parseProposal(answer.replace('"every_minutes":30', '"every_minutes":0'), "w:t-set", WATCH_FIELDS)).toBeNull();
	expect(stored("t-set").every_minutes).toBe(60);
});
