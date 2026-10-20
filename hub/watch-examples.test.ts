// docs/watch-examples dry runs: each example runs twice with a temp state folder and a fixture input (a local file or a
// local server, no network); the second run must print nothing new, and a broken input must fail with the DOTZ_FAIL form
// hub/watch.ts parses.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXAMPLES = join(import.meta.dir, "..", "docs", "watch-examples");
const FAIL_KIND = /^DOTZ_FAIL[ =:]([a-z0-9-]{1,20})\b/m; // the same pattern hub/watch.ts uses
const tmp = mkdtempSync(join(tmpdir(), "dotz-examples-"));

async function run(name: string, state: string, ...args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn([join(EXAMPLES, name), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTZ_WATCH_STATE_DIR: state } });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: out + err };
}
const freshState = () => join(mkdtempSync(join(tmp, "s-")), "state"); // not created: the script makes it

test("new-items.sh: the first run records the baseline, later runs print only the new items once", async () => {
	const feed = join(tmp, "feed.json");
	const state = freshState();
	writeFileSync(feed, JSON.stringify([{ id: 1, title: "one" }, { id: 2, title: "two" }]));
	expect(await run("new-items.sh", state, feed)).toEqual({ code: 0, out: "" });
	expect(await run("new-items.sh", state, feed)).toEqual({ code: 0, out: "" });
	writeFileSync(feed, JSON.stringify([{ id: 4, title: "four" }, { id: 1, title: "one" }, { id: 2, title: "two" }, { id: 3, title: "three" }]));
	expect(await run("new-items.sh", state, `file://${feed}`)).toEqual({ code: 0, out: "3 three\n4 four\n" });
	expect(await run("new-items.sh", state, feed)).toEqual({ code: 0, out: "" });
});

test("new-items.sh: an unreadable or malformed feed fails with a DOTZ_FAIL kind and keeps the baseline", async () => {
	const feed = join(tmp, "feed2.json");
	const state = freshState();
	writeFileSync(feed, JSON.stringify([{ id: 5, title: "five" }]));
	await run("new-items.sh", state, feed);
	const missing = await run("new-items.sh", state, join(tmp, "nope.json"));
	expect(missing.code).toBe(1);
	expect(FAIL_KIND.exec(missing.out)?.[1]).toBe("fetch");
	writeFileSync(feed, "not json");
	const bad = await run("new-items.sh", state, feed);
	expect(bad.code).toBe(1);
	expect(FAIL_KIND.exec(bad.out)?.[1]).toBe("feed");
	writeFileSync(feed, JSON.stringify([{ id: 5, title: "five" }, { id: 6, title: "six" }]));
	expect(await run("new-items.sh", state, feed)).toEqual({ code: 0, out: "6 six\n" });
});

test("changed.sh: prints one line when the content changed, nothing on the runs around it", async () => {
	const page = join(tmp, "page.html");
	const state = freshState();
	writeFileSync(page, "price 10");
	expect(await run("changed.sh", state, page)).toEqual({ code: 0, out: "" });
	expect(await run("changed.sh", state, page)).toEqual({ code: 0, out: "" });
	writeFileSync(page, "price 12");
	const changed = await run("changed.sh", state, page);
	expect(changed.code).toBe(0);
	expect(changed.out).toMatch(/^changed: .*page\.html \([0-9a-f]{16}\)\n$/);
	expect(await run("changed.sh", state, page)).toEqual({ code: 0, out: "" });
	const missing = await run("changed.sh", state, join(tmp, "gone.html"));
	expect(missing.code).toBe(1);
	expect(FAIL_KIND.exec(missing.out)?.[1]).toBe("fetch");
});

test("up.sh: healthy prints nothing, a known failure prints the same DOTZ_FAIL text each run, a dead port is down", async () => {
	let status = 200;
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x", { status }) });
	const state = freshState();
	mkdirSync(state, { recursive: true });
	const url = `http://127.0.0.1:${server.port}/health`;
	try {
		expect(await run("up.sh", state, url)).toEqual({ code: 0, out: "" });
		expect(await run("up.sh", state, url)).toEqual({ code: 0, out: "" });
		status = 503;
		const first = await run("up.sh", state, url);
		const second = await run("up.sh", state, url);
		expect(first.code).toBe(1);
		expect(FAIL_KIND.exec(first.out)?.[1]).toBe("http-503");
		expect(second).toEqual(first);
	} finally {
		await server.stop(true);
	}
	const down = await run("up.sh", state, url);
	expect(down.code).toBe(1);
	expect(FAIL_KIND.exec(down.out)?.[1]).toBe("down");
});

afterAll(() => Bun.spawn(["rm", "-rf", tmp]));
