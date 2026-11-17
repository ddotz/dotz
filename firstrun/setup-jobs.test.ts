import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { harness } from "../onboard/harness.ts";
import { DEFAULT_JOBS, isJobId, type JobIO } from "./setup-jobs.ts";
import { setupText } from "./setup-state.ts";

const ompBin = harness("omp")!.bin;
afterEach(() => rmSync(ompBin, { force: true }));

const jobIO = (run: JobIO["run"]): JobIO => ({ line: () => {}, run, owner: () => {}, text: setupText("en") });

test("omp is installed by the install-omp job: the bun global add of its package, done once omp answers", async () => {
	expect(isJobId("install-omp")).toBe(true);
	expect(harness("omp")?.install).toEqual(["bun", "add", "-g", "@oh-my-pi/pi-coding-agent"]);
	const ran: string[][] = [];
	const result = await DEFAULT_JOBS["install-omp"](
		jobIO(async cmd => {
			ran.push(cmd);
			mkdirSync(dirname(ompBin), { recursive: true });
			writeFileSync(ompBin, '#!/bin/sh\necho "omp/18.22.0"\n');
			chmodSync(ompBin, 0o755);
			return true;
		}),
	);
	expect(ran).toEqual([["bun", "add", "-g", "@oh-my-pi/pi-coding-agent"]]);
	expect(result.ok).toBe(true);
});

test("install-omp fails with the install command for the owner when the install fails or omp still does not answer", async () => {
	const failed = await DEFAULT_JOBS["install-omp"](jobIO(async () => false));
	expect(failed.ok).toBe(false);
	expect(failed.owner).toContain("bun add -g @oh-my-pi/pi-coding-agent");
	const silent = await DEFAULT_JOBS["install-omp"](jobIO(async () => true));
	expect(silent.ok).toBe(false);
	expect(silent.owner).toContain("omp (oh-my-pi)");
});
