import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventTarget } from "./events.ts";
import { isProjectTarget, projectTarget } from "./projectchat.ts";

const WORK = { "1561565203714408448": "dotz-개선" };
const CH = "ch:1561565203714408448";

// The conversations a web chat target shows: the owner's message in a project channel (from Discord or from the web
// switcher), the orchestrator's answers and progress there, and everything that stays in the main chat or a lane.
const EVENTS: Array<[string, Record<string, unknown>, string]> = [
	["discord message in the work channel", { kind: "message", source: "discord", channel: CH, channel_name: "dotz-개선", text: "hi" }, CH],
	["web message sent to the project", { kind: "message", source: "web", channel: CH, channel_name: "dotz-개선", text: "hi" }, CH],
	["answer to the work channel", { kind: "out", source: "orchestrator", target: CH, text: "ok" }, CH],
	["progress note in the work channel", { kind: "out", source: "orchestrator", target: CH, update_key: "progress", text: "…" }, CH],
	["command answer in the work channel", { kind: "out", source: "gateway", target: CH, text: "model" }, CH],
	["web message to the main assistant", { kind: "message", source: "web", channel: "web", text: "hi" }, "main"],
	["discord chat channel", { kind: "message", source: "discord", channel: "chat", text: "hi" }, "main"],
	["thread of a work channel", { kind: "message", source: "discord", channel: "th:42", parent: CH, text: "hi" }, "main"],
	["alert", { kind: "out", source: "gateway", target: "alert", text: "x" }, "main"],
	["lane report", { kind: "lane_report", lane: "a", text: "done" }, "lane:a"],
	["lane answer posted to the work channel", { kind: "out", source: "lane:a", target: CH, text: "x" }, "lane:a"],
];

describe("project orchestrator target", () => {
	test("a known work channel is a project target, by id or ch:<id>", () => {
		expect(projectTarget("1561565203714408448", WORK)).toEqual({ target: CH, name: "dotz-개선" });
		expect(projectTarget(CH, WORK)).toEqual({ target: CH, name: "dotz-개선" });
	});

	test("an unknown or malformed channel is refused", () => {
		expect(() => projectTarget("999", WORK)).toThrow();
		expect(() => projectTarget("ch:", WORK)).toThrow();
		expect(() => projectTarget("lane:a", WORK)).toThrow();
		expect(() => projectTarget("../1561565203714408448", WORK)).toThrow();
	});

	test("isProjectTarget takes ch:<digits> only", () => {
		expect(isProjectTarget(CH)).toBe(true);
		expect(["main", "lane:a", "ch:", "ch:abc", "th:1"].some(isProjectTarget)).toBe(false);
	});

	for (const [name, e, want] of EVENTS) test(`history: ${name} -> ${want}`, () => expect(eventTarget(e as never)).toBe(want));

	test("the web app sorts events into the same conversations as the hub", () => {
		const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
		const fn = html.match(/\nfunction eventTarget\(e\) \{[\s\S]*?\n\}\n/)?.[0];
		const proj = html.match(/\nconst isProjT = .*\n/)?.[0];
		expect(fn && proj).toBeTruthy();
		const webTarget = new Function("MAIN", `${proj}${fn}return eventTarget;`)("main") as (e: unknown) => string;
		for (const [, e, want] of EVENTS) expect(webTarget(e)).toBe(want);
	});
});
