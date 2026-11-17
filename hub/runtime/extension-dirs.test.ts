import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ompAgentDir } from "../omp-dirs.ts";
import { EXTENSION_DIRS } from "./index.ts";

const KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
	for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
	else process.env[k] = saved[k];
});

test("omp's extension folder is under the same agent folder as the rest of dotz reads, profile included", () => {
	for (const k of KEYS) delete process.env[k];
	process.env.HOME = "/h";
	expect(EXTENSION_DIRS.omp!()).toBe(join(ompAgentDir(process.env, "/h"), "extensions"));
	expect(EXTENSION_DIRS.omp!()).toBe("/h/.omp/agent/extensions");
	process.env.OMP_PROFILE = "work";
	process.env.PI_CODING_AGENT_DIR = "/x/agent";
	expect(EXTENSION_DIRS.omp!()).toBe("/h/.omp/profiles/work/agent/extensions");
	delete process.env.OMP_PROFILE;
	expect(EXTENSION_DIRS.omp!()).toBe("/x/agent/extensions");
});
