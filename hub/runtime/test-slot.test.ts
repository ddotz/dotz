import { expect, test } from "bun:test";
import { isFullSuite } from "./test-slot.ts";

const words = (line: string) => line.split(" ");

test("a run with no file argument, a filter or many files is a full suite", () => {
	for (const line of ["bun test", "bun test --parallel=4", "bun test --isolate --timeout 20000", "bun test hub", "bun test connectors", `bun test ${Array.from({ length: 21 }, (_, i) => `f${i}.test.ts`).join(" ")}`])
		expect(isFullSuite(words(line))).toBe(true);
});

test("a run of a few named files, a worker or another command is free", () => {
	for (const line of ["bun test hub/x.test.ts", "bun test --parallel=2 hub/x.test.ts hub/y.test.ts", `bun test ${Array.from({ length: 20 }, (_, i) => `f${i}.test.ts`).join(" ")}`, "bun test -t name hub/x.test.ts", "bun test --test-worker --isolate", "bun run test", "bun hub/main.ts"])
		expect(isFullSuite(words(line))).toBe(false);
});
