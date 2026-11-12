// Quick chat's session (DOTZ_CONV=quick) may not launch lanes or merge (extension/guard.ts quickChatBlock); every other conversation keeps both.
// The function is read through a namespace so its absence fails the tests and not the import.
import { expect, test } from "bun:test";
import * as guard from "./guard.ts";

type Block = (tool: string, input: unknown, conv?: string) => string | undefined;
const block = (): Block => {
	const fn = (guard as { quickChatBlock?: Block }).quickChatBlock;
	expect(typeof fn).toBe("function");
	return fn!;
};

test("a quick chat process is refused dotz_lane launch and dotz_merge", () => {
	const refuse = block();
	expect(refuse("dotz_lane", { action: "launch", brief: "Fix the parser.\nDone when: tests pass" }, "quick")).toEqual(expect.any(String));
	expect(refuse("dotz_merge", { action: "review", pr: 3 }, "quick")).toEqual(expect.any(String));
	expect(refuse("dotz_merge", { action: "merge", pr: 3 }, "quick")).toEqual(expect.any(String));
});

test("any other conversation, and main, is not refused", () => {
	const refuse = block();
	for (const conv of ["ch:1", "mail:acme-1", "alert", "worklog", "", undefined]) {
		expect([conv, refuse("dotz_lane", { action: "launch", brief: "Fix the parser.\nDone when: tests pass" }, conv)]).toEqual([conv, undefined]);
		expect([conv, refuse("dotz_merge", { action: "merge", pr: 3 }, conv)]).toEqual([conv, undefined]);
	}
});

test("a quick chat process keeps the tools it needs for chat and small jobs", () => {
	const refuse = block();
	for (const [tool, input] of [["dotz_conv", { action: "send", to: "main", text: "x" }], ["dotz_conv", { action: "read", target: "main" }], ["bash", { command: "ls" }], ["read", { path: "a.md" }]] as const) {
		expect([tool, refuse(tool, input, "quick")]).toEqual([tool, undefined]);
	}
});
