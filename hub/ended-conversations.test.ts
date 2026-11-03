// An ended session is listed in GET /api/conversations beside the live ones, so the folded 끝난 세션 group (web/js/04-state.js
// endedGroup) can show its 답변 필요; its unread count is 0 (owner 2026-11-03: "끝난 세션에 있는 안읽음 표시는 무시하도록 하자").
import { afterAll, afterEach, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { emit } from "./events.ts";
import { lanes, type Lane } from "./lanes.ts";
import { makeRoute } from "./routes.ts";

const env = setupEnv();
afterAll(env.cleanup);
afterEach(() => lanes.clear());
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
// cwd outside a temp folder: a temp-folder lane is never live (lanestate.ts isTempLane)
const lane = (name: string, status: Lane["status"], extra: Partial<Lane> = {}): Lane => ({ name, cwd: "/Users/test/proj", model: "prov/m", status, startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: status === "exited" ? undefined : ({} as Lane["proc"]), ...extra });
const list = async () => {
	const r = await route(new Request("http://hub.test/api/conversations", { headers: { "x-dotz-token": HUB_TOKEN } }));
	return ((await r!.json()) as { items: { target: string; unread: number }[] }).items;
};
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const say = (name: string, ts: string, text: string) => emit("outbox", { ts, kind: "out", source: `lane:${name}`, target: `lane:${name}`, text });

test("an ended lane is listed in /api/conversations with the live ones", async () => {
	lanes.set("run", lane("run", "idle"));
	lanes.set("done", lane("done", "exited"));
	const targets = (await list()).map(i => i.target);
	expect(targets).toContain("lane:done");
	expect(targets).toContain("lane:run");
});

test("an ended lane's unseen messages count 0; a live lane's still count; a resumed lane counts only what came after its end", async () => {
	lanes.set("act", lane("act", "idle"));
	lanes.set("fin", lane("fin", "exited", { endedAt: at(2) }));
	lanes.set("back", lane("back", "idle", { endedAt: at(2) }));
	for (const n of ["act", "fin", "back"]) say(n, at(1), `${n} 보고 1`);
	say("back", at(3), "다시 시작한 뒤 보고");
	const unread = Object.fromEntries((await list()).map(i => [i.target, i.unread]));
	expect(unread["lane:act"]).toBe(1);
	expect(unread["lane:fin"]).toBe(0);
	expect(unread["lane:back"]).toBe(1);
});
