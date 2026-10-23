import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseProposal } from "./app-settings.ts";
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
	expect(val("t-set")).toEqual({ enabled: true, every_minutes: 60, to: "alert", label: "테스트 감시" });
	expect(WATCH_FIELDS.filter(f => f.switch).map(f => f.key)).toEqual(["enabled", "every_minutes", "to", "label"]);
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
	expect(ctx).toContain("every_minutes | number | 확인 간격(분) | 60");
	const answer = "30분마다로 바꿀게요.\n```dotz-settings\n" + JSON.stringify({ app: "w:t-set", changes: { every_minutes: 30 } }) + "\n```";
	expect(parseProposal(answer, "w:t-set", WATCH_FIELDS)).toEqual({ app: "w:t-set", changes: { every_minutes: 30 } });
	expect(parseProposal(answer.replace('"every_minutes":30', '"every_minutes":0'), "w:t-set", WATCH_FIELDS)).toBeNull();
	expect(stored("t-set").every_minutes).toBe(60);
});
