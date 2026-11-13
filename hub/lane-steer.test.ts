// A lane's report is never steered into main's running turn (it waits for main's idle point, hub/lanerelay.ts flush); a conversation
// session's turn still takes it. A lane's [wait] on main is main's handed work from that lane, so main's answer goes back to the lane.
// The [wait] goes through the real report path (lanereport.ts, lanewire.ts); main's queue is stubbed so nothing reaches a real orchestrator.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, NAME, paths } from "./config.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { report } from "./lanereport.ts";
import { lanes, type Lane } from "./lanestate.ts";
import { installLaneHandlers, reportSteer } from "./lanewire.ts";
import { queue } from "./outbound.ts";
import { MAIN } from "./session-key.ts";

test("a lane report is steered into a conversation session's running turn, never into main's: the relay holds main's for its idle point", () => {
	const asked: string[] = [];
	const notes: string[] = [];
	const steer = reportSteer(key => (asked.push(key), note => (notes.push(note), true)));
	expect(steer("- lane beta status=done\n[done] shipped", "ch:42")).toBe(true);
	expect(steer("- lane alpha status=done\n[done] shipped", MAIN)).toBe(false);
	expect(asked).toEqual(["ch:42"]);
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("[done] shipped");
	expect(reportSteer(() => undefined)("[done] x", "ch:43")).toBe(false);
});

const delivered: { text: string; opts?: { target?: string; from?: string } }[] = [];
const realDeliver = queue.deliver;
const saved = Reflect.get(cfg, "output_language");
const waiters: ((e: HubEvent) => void)[] = [];
let tick = 0;

beforeAll(() => {
	Reflect.set(cfg, "output_language", "off");
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
	queue.deliver = ((text: string, opts?: { target?: string; from?: string }) => (delivered.push({ text, opts }), false)) as typeof queue.deliver;
	onEmit(e => {
		if (e.kind === "lane_report") for (const w of waiters.splice(0)) w(e);
	});
	installLaneHandlers();
});
afterAll(() => {
	queue.deliver = realDeliver;
	Reflect.set(cfg, "output_language", saved);
	delete process.env.DOTZ_NO_ORCHESTRATOR;
	for (const l of lanes.values()) clearTimeout(l.watchdog);
	lanes.clear();
});
beforeEach(() => void (delivered.length = 0));

function lane(extra: Partial<Lane> = {}): Lane {
	const name = `ls-${++tick}`;
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const l = { name, cwd: "/tmp", model: "m", status: "working", startedAt: "", reports: 0, lastText: "", ctx: { compaction: { state: "idle" } }, proc: { send: () => {} }, ...extra } as unknown as Lane;
	lanes.set(name, l);
	return l;
}
const reports = async (l: Lane, text: string) => {
	const seen = new Promise<HubEvent>(resolve => waiters.push(resolve));
	report(l, text);
	await seen;
};
const WAIT = `[wait] 배포 전에 스테이징 키가 있어야 이어갈 수 있어요.\n\nFor ${NAME}: 스테이징 키를 레인 설정에 넣어 주세요`;

test("a lane's [wait] on main reaches main as that lane's handed request, so main's answer goes back to the lane", async () => {
	const l = lane();
	await reports(l, WAIT);
	expect(delivered).toHaveLength(1);
	expect(delivered[0]!.opts).toEqual({ target: `lane:${l.name}`, from: `lane:${l.name}` });
	expect(delivered[0]!.text.startsWith(`[lane:${l.name}] [wait]`)).toBe(true);
});

test("the same [wait] again in a later turn hands main nothing more", async () => {
	const l = lane();
	await reports(l, WAIT);
	l.reportedThisTurn = undefined; // a new turn of the lane
	await reports(l, WAIT);
	expect(delivered.map(d => d.opts?.from)).toEqual([`lane:${l.name}`]);
});

test("a [wait] in the turn that answers main's own answer is relayed, not handed again (one round)", async () => {
	const l = lane();
	await reports(l, WAIT);
	l.reportedThisTurn = undefined;
	l.handedBack = true; // main's answer came back (lane-handback.ts) and started this turn
	await reports(l, WAIT.replace("스테이징 키", "운영 키"));
	expect(delivered.map(d => d.opts?.from)).toEqual([`lane:${l.name}`, undefined]);
	expect(l.handedBack).toBeUndefined();
});
