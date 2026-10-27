import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, HUB_TOKEN } from "./config.ts";
import { makeRoute } from "./routes.ts";
import { addWatch, allWatches, removeWatch, stopWatches } from "./watch.ts";

// POST /api/watches/<name>/run: the web's 지금 확인 / 지금 다시 확인. It runs the same runner the timer uses and answers with the
// monitor row the list would show afterwards. The watch here is a fixture command, so no real check runs.
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const post = (path: string, auth = true) => route(new Request(`http://hub.test${path}`, { method: "POST", headers: auth ? { "x-dotz-token": HUB_TOKEN } : {} }));

afterAll(() => {
	for (const w of allWatches()) removeWatch(w.id);
	stopWatches();
});

test("running a watch now answers with its fresh result", async () => {
	addWatch({ name: "run-now", command: "echo 확인했어요", every_minutes: 10 }, "");
	const res = await post("/api/watches/run-now/run");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; item: Record<string, unknown> };
	expect(body.ok).toBe(true);
	expect(body.item).toMatchObject({ name: "run now", watch: "run-now", kind: "watch", last_result: "ok", connection: "connected", last_summary: "확인했어요" });
	expect(Date.parse(String(body.item.last_run))).toBeGreaterThan(0);
	expect(Date.parse(String(body.item.next_run)) - Date.parse(String(body.item.last_run))).toBe(10 * 60_000);
});

test("an unknown watch is 404 and no owner identity is 403", async () => {
	expect((await post("/api/watches/no-such-watch/run")).status).toBe(404);
	expect((await post("/api/watches/run-now/run", false)).status).toBe(403);
});

test("다시 연결 of a disconnected watch behind an approval gate approves it instead of a plain run that only waits", async () => {
	addWatch({ name: "gated-login", command: "printf 'waiting\\nDOTZ_DISCONNECTED since=2026-10-23T12:29:18.300Z\\n'", every_minutes: 10, approval_minutes: 30 }, "");
	const first = (await (await post("/api/watches/gated-login/run")).json()) as { approved?: boolean; item: { connection: string } };
	expect([first.approved, first.item.connection]).toEqual([undefined, "disconnected"]);
	const again = (await (await post("/api/watches/gated-login/run")).json()) as { approved?: boolean };
	expect(again.approved).toBe(true);
	expect(existsSync(join(DATA_DIR, "approvals", "gated-login"))).toBe(true);
});
