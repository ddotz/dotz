// An ended session keeps its unread count: GET /api/conversations lists ended lanes beside the live ones, so the folded 끝난 세션 group
// (web/js/04-state.js endedGroup) can show its marks.
import { afterAll, afterEach, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { lanes, type Lane } from "./lanes.ts";
import { makeRoute } from "./routes.ts";

const env = setupEnv();
afterAll(env.cleanup);
afterEach(() => lanes.clear());
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const lane = (name: string, status: Lane["status"]): Lane => ({ name, cwd: "/tmp", model: "prov/m", status, startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: status === "exited" ? undefined : ({} as Lane["proc"]) });

test("an ended lane is listed in /api/conversations with the live ones", async () => {
	lanes.set("run", lane("run", "idle"));
	lanes.set("done", lane("done", "exited"));
	const r = await route(new Request("http://hub.test/api/conversations", { headers: { "x-dotz-token": HUB_TOKEN } }));
	const targets = ((await r!.json()) as { items: { target: string }[] }).items.map(i => i.target);
	expect(targets).toContain("lane:done");
	expect(targets).toContain("lane:run");
});
