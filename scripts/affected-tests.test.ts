import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isFullSuite } from "../hub/runtime/test-slot.ts";
import { affectedTests, buildGraph, runCommands, testCommands } from "./affected-tests.ts";

const FILES: Record<string, string> = {
	"lib/core.ts": "export const core = 1;\n",
	"lib/mid.ts": 'import { core } from "./core.ts";\nexport const mid = core + 1;\n',
	"lib/far.ts": 'export { mid } from "./mid.ts";\n',
	"lib/lazy.ts": 'export const load = () => import("./core.ts");\n',
	"lib/core.test.ts": 'import { core } from "./core.ts";\n',
	"lib/mid.test.ts": 'import {\n\tmid,\n} from "./mid.ts";\n',
	"lib/far.test.ts": 'import { mid } from "./far.ts";\n',
	"lib/lazy.test.ts": 'import { load } from "./lazy.ts";\n',
	"lib/other.test.ts": 'import "./unrelated.ts";\n',
	"lib/unrelated.ts": "export {};\n",
	"lib/core-web.test.ts": 'import { core } from "./core.ts";\n',
	"lib/listed.test.ts": 'import { core } from "./core.ts";\n',
	"web/app.js": "export const app = 1;\n",
	"lib/app.test.ts": 'import { app } from "../web/app.js";\n',
	"lib/app-web.test.ts": 'import { app } from "../web/app.js";\n',
	"web/panel.js": "export const panel = 1;\n",
	"web/lonely.js": "export const lonely = 1;\n",
	"lib/panel-path.test.ts": 'const page = Bun.file("web/panel.js");\n',
	"lib/panel-name-web.test.ts": 'const page = join(dir, "panel.js");\n',
	"lib/gone.test.ts": 'import { gone } from "./gone.ts";\n',
	"lib/uses-gone.ts": 'import { gone } from "./gone";\nexport const user = gone;\n',
	"lib/uses-gone.test.ts": 'import { user } from "./uses-gone.ts";\n',
	"lib/goner.test.ts": 'import { goner } from "./goner.ts";\n',
	"lib/pkg.test.ts": 'import { pkg } from "./pkg";\n',
	"scripts/slow-tests.txt": "lib/listed.test.ts\n",
};

let root = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "affected-tests-"));
	for (const [path, text] of Object.entries(FILES)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("affectedTests", () => {
	test("a test that imports the changed file, directly or through one module, is affected; two modules away is not", () => {
		const { tests } = affectedTests(root, ["lib/core.ts"]);
		expect(tests).toEqual(["lib/core.test.ts", "lib/lazy.test.ts", "lib/mid.test.ts"]);
	});

	test("a static, multi-line, re-export and dynamic import all count", () => {
		const graph = buildGraph(root);
		expect([...(graph.get("lib/mid.ts") ?? [])].sort()).toEqual(["lib/far.ts", "lib/mid.test.ts"]);
		expect([...(graph.get("lib/core.ts") ?? [])].sort()).toContain("lib/lazy.ts");
	});

	test("a changed test file is affected without any importer", () => {
		expect(affectedTests(root, ["lib/other.test.ts"]).tests).toEqual(["lib/other.test.ts"]);
	});

	test("a change nothing imports and that is not a test affects nothing", () => {
		expect(affectedTests(root, ["README.md"])).toEqual({ tests: [], skippedSlow: [] });
		expect(affectedTests(root, ["lib/far.test.ts"]).tests).toEqual(["lib/far.test.ts"]);
	});

	test("slow-tier tests (name pattern or listed) are skipped and named", () => {
		const { tests, skippedSlow } = affectedTests(root, ["lib/core.ts"]);
		expect(tests).not.toContain("lib/core-web.test.ts");
		expect(tests).not.toContain("lib/listed.test.ts");
		expect(skippedSlow).toEqual(["lib/core-web.test.ts", "lib/listed.test.ts"]);
	});

	test("a change under web/ also runs the affected slow-tier tests", () => {
		const { tests, skippedSlow } = affectedTests(root, ["web/app.js"]);
		expect(tests).toEqual(["lib/app-web.test.ts", "lib/app.test.ts"]);
		expect(skippedSlow).toEqual([]);
		const both = affectedTests(root, ["lib/core.ts", "web/style.css"]);
		expect(both.tests).toEqual(["lib/core-web.test.ts", "lib/core.test.ts", "lib/lazy.test.ts", "lib/listed.test.ts", "lib/mid.test.ts"]);
	});

	test("a changed web/ file selects the tests whose text names its repo path or its file name, with no import, slow tier included", () => {
		const { tests, skippedSlow } = affectedTests(root, ["web/panel.js"]);
		expect(tests).toEqual(["lib/panel-name-web.test.ts", "lib/panel-path.test.ts"]);
		expect(skippedSlow).toEqual([]);
		expect(affectedTests(root, ["web/lonely.js"]).tests).toEqual([]);
	});

	test("a deleted file selects the tests that import its name, and the tests one module further", () => {
		const { tests } = affectedTests(root, ["lib/gone.ts"]);
		expect(tests).toEqual(["lib/gone.test.ts", "lib/uses-gone.test.ts"]);
	});

	test("a deleted index file is imported by its folder name", () => {
		expect(affectedTests(root, ["lib/pkg/index.ts"]).tests).toEqual(["lib/pkg.test.ts"]);
	});

	test("a deleted file whose name only starts a longer import name selects nothing", () => {
		expect(affectedTests(root, ["lib/gon.ts"]).tests).toEqual([]);
	});
});

describe("testCommands", () => {
	const names = (n: number) => Array.from({ length: n }, (_, i) => `lib/t${i}.test.ts`);

	test("one command runs at most 20 files with --parallel=4, so the test slot never counts it as a full suite", () => {
		const commands = testCommands(names(45));
		expect(commands.map(c => c.length - 3)).toEqual([20, 20, 5]);
		for (const command of commands) {
			expect(command.slice(0, 3)).toEqual(["bun", "test", "--parallel=4"]);
			expect(isFullSuite(command)).toBe(false);
		}
		expect(commands.flatMap(c => c.slice(3))).toEqual(names(45).map(n => `./${n}`));
		expect(isFullSuite(["bun", "test", ...names(21)])).toBe(true);
		expect(testCommands(names(20))).toHaveLength(1);
	});

	test("runCommands runs the batches in order and stops at the first failing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "affected-run-"));
		try {
			const step = (name: string, code: number) => [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(join(dir, "log"))}, "${name}\\n"); process.exit(${code});`];
			expect(runCommands([step("a", 0), step("b", 3), step("c", 0)], dir)).toBe(3);
			expect(readFileSync(join(dir, "log"), "utf8")).toBe("a\nb\n");
			expect(runCommands([], dir)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("affected-tests command", () => {
	const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "affected-tests.ts"), ...args], { encoding: "utf8" });

	test("no affected test: says so and exits 0", () => {
		const r = run("README.md", "--print");
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("no affected test");
	});

	test("--print gives the bun test command for this file's own test, and runs nothing", () => {
		const r = run("scripts/affected-tests.test.ts", "--print");
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("bun test --parallel=4 ./scripts/affected-tests.test.ts");
	});
});
