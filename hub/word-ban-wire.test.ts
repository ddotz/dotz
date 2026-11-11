// The owner's word list on the two ways text leaves a session: /api/send (refused) and a lane report (sent back once, then through).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN, paths } from "./config.ts";
import { onEmit } from "./events.ts";
import { report } from "./lanereport.ts";
import { hooks, lanes, type Lane } from "./lanestate.ts";
import { makeRoute } from "./routes.ts";
import { wordsFile } from "./word-ban.ts";

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const send = (body: object) => route(new Request("http://127.0.0.1/api/send", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify(body) }));

const savedReport = hooks.report;
let outs: string[] = [];
let tick = 0;

beforeAll(() => {
	mkdirSync(join(wordsFile(), ".."), { recursive: true });
	writeFileSync(wordsFile(), JSON.stringify({ words: [{ word: "빨간 시험", use: "red test" }] }));
	onEmit(e => {
		if (e.kind === "out") outs.push(e.target);
	});
});
afterAll(() => {
	rmSync(wordsFile(), { force: true });
	hooks.report = savedReport;
});

test("/api/send refuses a text with a listed word on every kind of target and posts nothing", async () => {
	for (const target of ["web", "chat", "worklog", "alert", "ch:general", "th:abc"]) {
		const r = await send({ target, text: "방금 빨간  시험을 끝냈어요", session: "main" });
		expect(r.status).toBe(422);
		const body = (await r.json()) as { error: string };
		expect(body.error).toContain("빨간 시험");
		expect(body.error).toContain("red test");
	}
	expect(outs).toEqual([]);
});

test("a lane report with a listed word goes back to the session once, then passes unchanged", () => {
	const sent: string[] = [];
	const reports: string[] = [];
	hooks.report = (_lane, text) => void reports.push(text);
	const name = `wb-${++tick}`;
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const lane = { name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, lastText: "", ctx: { compaction: { state: "idle" } }, proc: { send: (t: string) => sent.push(t) } } as unknown as Lane;
	lanes.set(name, lane);

	report(lane, "[run] 빨간 시험은 이제 통과해요");
	expect(reports).toEqual([]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("빨간 시험");
	expect(lane.bannedRefused).toBe(true);

	report(lane, "[run] 빨간   시험은 이제 통과해요");
	expect(sent).toHaveLength(1);
	expect(reports).toEqual(["[run] 빨간   시험은 이제 통과해요"]);

	report(lane, "[run] 다 끝났어요");
	expect(reports).toHaveLength(2);
	expect(lane.bannedRefused).toBeUndefined();
	lanes.delete(name);
});
