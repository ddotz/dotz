// /api/state carries the run state of the main conversation (and every lane) under `runs`: the page's one status line reads it.
import { expect, test } from "bun:test";
import { HUB_TOKEN } from "./config.ts";
import { makeRoute } from "./routes.ts";

test("state carries runs.main with a kind and no stale empty time", async () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const res = await route(new Request("http://127.0.0.1/api/state", { headers: { "x-dotz-token": HUB_TOKEN } }));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { runs?: Record<string, { kind?: string; since?: string }> };
	expect(["working", "waiting", "idle", "limited", "error", "stopped", "done"]).toContain(body.runs?.main?.kind);
	expect(body.runs?.main?.since).not.toBe("");   // absent before the first turn, never an empty time
});

test("중단 and 다시 맡기기 of a background worker are routes that say plainly when there is no such worker", async () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const post = (path: string) => route(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: "{}" }));
	for (const act of ["cancel", "retry"]) {
		const res = await post(`/api/workers/st_nope/${act}`);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error?: string }).error).toBe("이 작업을 찾을 수 없어요");
	}
});
