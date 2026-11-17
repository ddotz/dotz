import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const closeRule = (file: string): string => readFileSync(join(import.meta.dir, "..", file), "utf8").split("\n").find(line => line.includes("`dotz_lane` verify")) ?? "";

test("the contract's rule for a verified session names the stop call and says to make it in that turn, in both languages", () => {
	expect(closeRule("MODE.md")).toContain("`dotz_lane` stop {name}");
	expect(closeRule("MODE.md")).toContain("same turn");
	expect(closeRule("MODE.ko.md")).toContain("`dotz_lane` stop {name}");
	expect(closeRule("MODE.ko.md")).toContain("그 턴에");
});
