import { expect, test } from "bun:test";
import { restartWording } from "./memguard.ts";

test("a restart held for running omp subagents says so and does not claim a restart", () => {
	const w = restartWording(["build", "review"], "9.0", "8", true, false);
	expect(w.log).toContain("held");
	expect(w.log).toContain("build, review");
	expect(w.status).toContain("held");
	expect(w.status).not.toContain("restarted");
	expect(w.notify).toContain("미뤘어요");
	expect(w.notify).not.toContain("다시 시작했어요");
});

test("a restart that goes ahead says restarted", () => {
	for (const held of [undefined, []]) {
		const w = restartWording(held, "9.0", "8", true, false);
		expect(w.status).toContain("restarted");
		expect(w.notify).toContain("다시 시작했어요");
	}
});
