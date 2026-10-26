// The update gate is the smoke start (hub/update-gate.json -> hub/update-smoke-run.ts -> hub/update-smoke.ts): it passes on this tree,
// and fails for a tree whose gateway cannot start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateIn } from "./selfupdate.ts";
import { pageAssets, smoke } from "./update-smoke.ts";

const repo = join(import.meta.dir, "..");
let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "dotz-smoke-test-"))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("the shipped gate is the smoke run, at most 5 minutes", () => {
	expect(gateIn(repo)).toEqual({ cmd: ["bun", "test", "./hub/update-smoke-run.ts"], ms: 5 * 60_000 });
});

test("the gateway of this tree starts, serves the page with its scripts and styles and answers the read-only API", async () => {
	const r = await smoke(repo);
	expect(r.ok ? "" : `${r.why}\n${r.out}`).toBe("");
	if (r.ok) expect(r.checked).toEqual(expect.arrayContaining(["/api/health", "/", "/app.js", "/app.css", "/api/state", "/api/notices"]));
}, 60_000);

test("a tree whose hub module does not parse fails the smoke check with the gateway's output", async () => {
	mkdirSync(join(tmp, "hub"));
	writeFileSync(join(tmp, "hub", "main.ts"), 'import "./broken.ts";\n');
	writeFileSync(join(tmp, "hub", "broken.ts"), "export const = ;\n");
	const r = await smoke(tmp);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.why).toContain("exited before it answered");
		expect(r.out).toContain("broken.ts");
	}
});

test("pageAssets lists local scripts and stylesheets only", () => {
	const html = '<link rel="manifest" href="/m.json"><link rel="stylesheet" href="/app.css"><script>inline()</script><script src="/app.js"></script><script src="https://x.test/a.js"></script>';
	expect(pageAssets(html)).toEqual(["/app.js", "/app.css"]);
});
