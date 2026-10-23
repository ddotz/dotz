import { expect, test } from "bun:test";
import { emitDelivery, eventTarget, historyEvents, onEmit, type HubEvent } from "./events.ts";
import { recordMail } from "./mail.ts";
import { orch } from "./orchestrator.ts";
import { rateLimitNotice } from "./outbound.ts";
import { type Computer, createPeerMonitor, type OrchestratorPause } from "./peer-monitor.ts";

// The Mac mini's orchestrator was paused (provider login) and the owner wrote in a mail conversation from the other Mac. The gateway's notice and
// the held state are written for the mail's Discord thread; the thread is unknown to Discord here, so the Discord send is dropped. Both must still
// be in the mail conversation's history (what the owner's own web and a peer's proxied read both show).
const THREAD = "1563113405412282505";
const KEY = `kdb-n${Date.now().toString(36)}`;

test("a gateway notice and the held state of a mail's thread are in the mail conversation, also when the Discord send is dropped", async () => {
	recordMail({ key: KEY, source: "kdb", id: KEY.slice(4), subject: "견적 요청", from: "Kim <kim@example.com>", at: new Date().toISOString(), thread: THREAD });
	const was = { status: orch.status, pauseKind: orch.pauseKind };
	orch.status = "rate-limited";
	orch.pauseKind = "owner";
	try {
		const noticed = new Promise<HubEvent>(resolve => onEmit(e => void (e.kind === "out" && e.source === "gateway" && e.target === `th:${THREAD}` && resolve(e))));
		rateLimitNotice(`th:${THREAD}`, "mid-n1");
		emitDelivery(`th:${THREAD}`, "mid-n1", "held");
		const notice = await noticed;
		expect(notice.conv).toBe(`mail:${KEY}`);
		expect(eventTarget(notice)).toBe(`mail:${KEY}`);
		const events = historyEvents(`mail:${KEY}`, 50);
		expect(events.some(e => e.kind === "out" && e.source === "gateway" && String(e.text).includes("멈춰 있어요"))).toBe(true);
		expect(events.some(e => e.kind === "delivery" && e.state === "held" && e.ref === "mid-n1")).toBe(true);
	} finally {
		orch.status = was.status;
		orch.pauseKind = was.pauseKind;
	}
});

const TOKEN = "t".repeat(24);
const URL_B = "https://mini.example.test";
const SELF: Computer = { name: "맥북", url: "https://book.example.test", self: true };
const MINI: Computer = { name: "맥미니", url: URL_B, self: false };

test("a gateway's snapshot carries its orchestrator pause, and a change of it reaches the peer", async () => {
	let pause: OrchestratorPause = { status: "idle", pauseKind: "rate" };
	const local = async (_req: Request) => Response.json({ items: [] });
	const mini = createPeerMonitor({ name: () => "맥미니", local, orchestrator: () => pause, computers: async () => [{ ...MINI, self: true }] });
	const book = createPeerMonitor({
		name: () => "맥북",
		local,
		computers: async () => [SELF, MINI],
		token: () => TOKEN,
		fetch: async (url, init) => (await mini.route(new Request(url, init), new URL(url))) ?? new Response("not found", { status: 404 }),
		refreshMs: 0,
	});
	const first = (await book.peerMonitoring())[0]!;
	expect(first.items?.orchestrator).toEqual({ status: "idle", pauseKind: "rate" });
	pause = { status: "rate-limited", pauseKind: "owner" };
	await book.peerMonitoring();
	await book.idle();
	const next = (await book.peerMonitoring())[0]!;
	expect(next.items?.orchestrator).toEqual({ status: "rate-limited", pauseKind: "owner" });
	expect(next.items?.rev).not.toBe(first.items?.rev);
});
