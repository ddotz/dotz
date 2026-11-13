import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { HUB_TOKEN } from "./config.ts";
import { onEmit, type HubEvent } from "./events.ts";
import { msg } from "./i18n.ts";
import { lanes } from "./lanes.ts";
import type { Lane } from "./lanestate.ts";
import { handBackToLane } from "./lane-handback.ts";
import { queue } from "./outbound.ts";
import { makeRoute } from "./routes.ts";
import { MAIN, primaryTarget } from "./session-key.ts";

// A lane hands main a request (dotz_main -> POST /api/conv-sessions/main/send from lane:<name>): main takes it as handed work from that lane,
// its answer goes back to the lane as a message, and that answer's turn may not hand main work again. Only main is a valid receiver.
// The queue is stubbed so main's real orchestrator holds nothing that another test file in this process would then receive.
const delivered: { text: string; opts?: { target?: string; from?: string } }[] = [];
const realDeliver = queue.deliver;
beforeAll(() => void (queue.deliver = ((text: string, opts?: { target?: string; from?: string }) => void delivered.push({ text, opts })) as typeof queue.deliver));
afterAll(() => {
	queue.deliver = realDeliver;
	for (const l of lanes.values()) clearTimeout(l.watchdog);
	lanes.clear();
});
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as never });
const send = (key: string, body: object) => route(new Request(`http://hub.test/api/conv-sessions/${encodeURIComponent(key)}/send`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
const seen: HubEvent[] = [];
onEmit(e => seen.push(e));
const handed = (channel: string) => seen.filter(e => e.kind === "handed" && e.channel === channel);

const sent: string[] = [];
const lane = (name: string): Lane => ({ name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, ctx: { compaction: { state: "idle" } } as Lane["ctx"], lastText: "", proc: { send: (text: string) => void sent.push(text), kill: () => {} } as unknown as Lane["proc"] }) as Lane;
beforeEach(() => {
	delivered.length = 0;
	sent.length = 0;
	seen.length = 0;
	lanes.set("alpha", lane("alpha"));
	lanes.set("beta", lane("beta"));
});

test("a lane's request is main's handed work from that lane, recorded under its name and answered back to it", async () => {
	const r = await send(MAIN, { text: "cut the release", from: "lane:alpha" });
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ ok: true, to: MAIN, answers_in: "lane:alpha" });
	expect(delivered).toMatchObject([{ text: "[lane:alpha] cut the release", opts: { target: "lane:alpha", from: "lane:alpha" } }]);
	expect(handed(primaryTarget(MAIN))).toMatchObject([{ from: "lane:alpha", text: "cut the release" }]);
});

test("a lane may hand work only to main: any other key is refused and nothing is queued or recorded", async () => {
	for (const key of ["ch:1", "lane:beta", "mail:x"]) {
		const r = await send(key, { text: "do this", from: "lane:alpha" });
		expect(r.status).toBe(403);
	}
	expect(delivered).toEqual([]);
	expect(seen.filter(e => e.kind === "handed")).toEqual([]);
});

test("a request from a lane that does not exist is refused", async () => {
	const r = await send(MAIN, { text: "hello", from: "lane:ghost" });
	expect(r.status).toBe(400);
});

test("main's answer reaches the lane as a message, and that turn cannot hand main work again", async () => {
	handBackToLane("alpha", MAIN, "restarted, back up");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`${msg().handbackLead} restarted, back up`);
	expect(handed("lane:alpha")).toMatchObject([{ from: MAIN, handback: true, text: "restarted, back up" }]);
	expect(lanes.get("alpha")!.handedBack).toBe(true);

	const again = await send(MAIN, { text: "and one more thing", from: "lane:alpha" });
	expect(again.status).toBe(409);
	expect(delivered).toEqual([]);

	lanes.get("alpha")!.handedBack = undefined; // the lane's next report, or a new instruction, ends that turn
	expect((await send(MAIN, { text: "and one more thing", from: "lane:alpha" })).status).toBe(200);
});
