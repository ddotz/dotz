import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { bursts, dropPending, flushQueue } from "./intake.ts";
import { onEmit, type HubEvent } from "./events.ts";
import { lanes, type Lane } from "./lanestate.ts";
import { orch } from "./orchestrator.ts";
import { enqueue, queueItems, take } from "./queue.ts";
import { flush } from "./runtime/test-clock.ts";

const was = orch.status;
const events: HubEvent[] = [];
onEmit(e => void events.push(e));
afterEach(() => {
	orch.status = was;
	dropPending("web");
	for (const i of queueItems().filter(q => q.target === "main" || q.target === "lane:gone-lane" || q.target === "lane:gone-once")) take(i.id);
	lanes.delete("gone-lane");
	lanes.delete("gone-once");
});

test("a message queued for a stopped main goes out through intake instead of waiting for an idle that does not come", () => {
	orch.status = "stopped";
	enqueue("main", "아직 거기 있나요");
	flushQueue("main");
	expect(queueItems().filter(i => i.target === "main")).toEqual([]);
	expect(bursts.get("web")?.events.map(e => e.text)).toEqual(["아직 거기 있나요"]);
});

test("a message queued for a working main still waits", () => {
	orch.status = "working";
	enqueue("main", "기다려요");
	flushQueue("main");
	expect(queueItems().filter(i => i.target === "main").map(i => i.text)).toEqual(["기다려요"]);
	expect(bursts.has("web")).toBe(false);
});

test("a message queued for an exited lane is sent, and a lane that cannot resume says so instead of leaving the message queued in silence", async () => {
	lanes.set("gone-lane", { name: "gone-lane", cwd: "/tmp", model: "m", status: "exited", startedAt: "", reports: 0, ctx: { compaction: { state: "idle" } } } as unknown as Lane);
	enqueue("lane:gone-lane", "계속 해 주세요");
	flushQueue("lane:gone-lane");
	await flush();
	expect(events.some(e => String((e as { text?: string }).text).includes("세션 gone-lane은(는) 이미 끝나서 전달하지 못했어요"))).toBe(true);
	expect(queueItems().filter(i => i.target === "lane:gone-lane")).toHaveLength(1);
});

test("a lane that cannot resume is logged and told once across the 5 s sweeps, not at every sweep", async () => {
	lanes.set("gone-once", { name: "gone-once", cwd: "/tmp", model: "m", status: "exited", startedAt: "", reports: 0, ctx: { compaction: { state: "idle" } } } as unknown as Lane);
	enqueue("lane:gone-once", "또 안 가는 메시지");
	const failures = (): number => readFileSync(paths.log, "utf8").split("\n").filter(l => l.includes("queued web messages for lane:gone-once not sent")).length;
	const told = (): number => events.filter(e => String((e as { text?: string }).text).includes("세션 gone-once은(는) 이미 끝나서 전달하지 못했어요")).length;
	const [logged0, told0] = [failures(), told()];
	for (let sweep = 0; sweep < 4; sweep++) {
		flushQueue("lane:gone-once");
		await flush();
	}
	expect(failures() - logged0).toBe(1);
	expect(told() - told0).toBe(1);
	expect(queueItems().filter(i => i.target === "lane:gone-once")).toHaveLength(1);
});
