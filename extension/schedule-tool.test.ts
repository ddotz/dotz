import { expect, test } from "bun:test";
import { scheduleAddRefusal } from "./schedule-tool.ts";

test("an add without a valid kind is refused with every kind explained; other calls and valid kinds go on", () => {
	for (const kind of [undefined, "", "quiet"]) expect(scheduleAddRefusal({ action: "add", name: "sample-2", kind })).toMatch(/kind required.*owner.*task.*check/s);
	for (const kind of ["owner", "task", "check"]) expect(scheduleAddRefusal({ action: "add", name: "sample-2", kind })).toBeUndefined();
	for (const action of ["list", "remove", "edit"]) expect(scheduleAddRefusal({ action })).toBeUndefined();
});

test("an add without a name is refused, a blank one too, and both missing name both", () => {
	for (const name of [undefined, "", "   ", 7]) expect(scheduleAddRefusal({ action: "add", name, kind: "task" })).toMatch(/^Not added: name required/);
	expect(scheduleAddRefusal({ action: "add" })).toMatch(/^Not added: name and kind required/);
});
